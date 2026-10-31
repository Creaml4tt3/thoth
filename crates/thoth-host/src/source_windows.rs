//! Import `SourceHost` (packages/importer-core/src/ports.ts) on Windows: read-only access to the one file or
//! folder the user picked, plus private temp files. The same contract as the POSIX `source.rs`:
//!
//! - The picked location is opened by its canonical path without following a final reparse point, and its final
//!   path must still be that canonical path (no junction swapped into an ancestor). A folder source then walks its
//!   root handle with the relative NT layer (`win::walk`): no reparse point in any component, every open is of a
//!   regular file. An archive source keeps the archive handle from `source.open`.
//! - Temp files live in a fresh directory under the user's temp folder (`%TEMP%`, private to the user by its
//!   inherited ACL; Windows has no mode bits to check), are created with `CREATE_NEW` and
//!   `FILE_FLAG_DELETE_ON_CLOSE`, so the system deletes them when the handle closes, even if the host crashes, and
//!   are only read back through the handle that wrote them.
use crate::error::{HostError, HostResult};
use crate::paths::source_segments;
use crate::win::names::segment_problem;
use crate::win::nt::{self, FILE_OPEN, Kind, OsError};
use crate::win::walk::{self, WalkError, disk_name};
use serde_json::{Value, json};
use std::fs::File;
use std::os::windows::fs::{FileExt, OpenOptionsExt};
use std::os::windows::io::OwnedHandle;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation as f;
use windows_sys::Win32::Storage::FileSystem as fs;

/// Largest positional read in one call.
pub const MAX_READ_BYTES: usize = 16 * 1024 * 1024;
/// Largest temp-file write in one call, and the temp-file size cap (the importer's 1 GiB entry limit).
pub const MAX_TEMP_BYTES: u64 = 1024 * 1024 * 1024;
/// Open files and temp files per source.
pub const MAX_OPEN_FILES: usize = 256;

pub enum SourceRoot {
    Directory(OwnedHandle),
    /// The archive itself, kept open from `source.open` so a later swap of the path cannot substitute it.
    File {
        file: File,
        size: u64,
    },
}

pub struct Source {
    pub root: SourceRoot,
    pub location: PathBuf,
    pub label: String,
    temp_dir: Option<tempfile::TempDir>,
    temp_count: u64,
}

pub struct OpenFile {
    pub file: File,
    pub size: u64,
    /// Temp files track their own high-water mark and are deleted on close.
    pub temp_path: Option<PathBuf>,
}

fn os(e: OsError, op: &str, path: &str) -> HostError {
    HostError::win32(e.0, op, path)
}

impl Source {
    pub fn open(location: &Path) -> HostResult<Self> {
        let display = location.display().to_string();
        let label = location.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| display.clone());
        let handle = nt::open_path(&crate::win::paths::verbatim(location), nt::READ_ACCESS, true).map_err(|e| os(e, "open", &display))?;
        let kind = nt::kind(&handle).map_err(|e| os(e, "fstat", &display))?;
        if matches!(kind, Kind::Directory | Kind::File) {
            crate::win::verify_final_path(&handle, location)?;
        }
        let root = match kind {
            Kind::Directory => SourceRoot::Directory(handle),
            Kind::File => {
                let size = nt::size(&handle).map_err(|e| os(e, "fstat", &display))?;
                SourceRoot::File { file: File::from(handle), size }
            }
            Kind::Symlink | Kind::Other => return Err(HostError::new("NOT_A_REGULAR_FILE", format!("{label} is not a regular file or directory"))),
        };
        Ok(Self { root, location: location.to_owned(), label, temp_dir: None, temp_count: 0 })
    }

    pub fn root_kind(&self) -> &'static str {
        match self.root {
            SourceRoot::Directory(_) => "directory",
            SourceRoot::File { .. } => "file",
        }
    }

    fn root_dir(&self) -> HostResult<&OwnedHandle> {
        match &self.root {
            SourceRoot::Directory(handle) => Ok(handle),
            SourceRoot::File { .. } => Err(HostError::bad_argument("Not a directory source")),
        }
    }

    /// Source segments that can exist on Windows (`None`: a name no Windows volume holds).
    fn segments(raw: &str) -> HostResult<Option<Vec<String>>> {
        let segments = source_segments(raw)?;
        Ok(if segments.iter().any(|s| segment_problem(s).is_some()) { None } else { Some(segments) })
    }

    pub fn list(&self, dir: &str) -> HostResult<Value> {
        let root = self.root_dir()?;
        let Some(segments) = Self::segments(dir)? else { return Err(os(OsError(f::ERROR_PATH_NOT_FOUND), "scandir", dir)) };
        let handle = walk::open_dir(root, &segments).map_err(|e| walk_error(e, dir, "scandir"))?;
        let entries = nt::read_dir(&handle).map_err(|e| os(e, "scandir", dir))?;
        // Sizes come from the directory listing, for regular files only; nothing is opened.
        Ok(Value::Array(entries.into_iter().map(|e| json!({ "name": e.name, "kind": nt::kind_name(e.kind), "size": e.size })).collect()))
    }

    pub fn open_file(&self, path: &str) -> HostResult<OpenFile> {
        match &self.root {
            SourceRoot::File { file, size } => {
                if !path.is_empty() {
                    return Err(HostError::bad_argument("An archive source only opens the archive itself"));
                }
                let file = file.try_clone().map_err(|e| HostError::io(&e, "dup", &self.label))?;
                Ok(OpenFile { file, size: *size, temp_path: None })
            }
            SourceRoot::Directory(root) => {
                if path.is_empty() {
                    return Err(HostError::bad_argument("Cannot open the source folder as a file"));
                }
                let Some(mut segments) = Self::segments(path)? else { return Err(os(OsError(f::ERROR_FILE_NOT_FOUND), "open", path)) };
                let name = segments.pop().expect("non-empty");
                let dir = walk::open_dir(root, &segments).map_err(|e| walk_error(e, path, "open"))?;
                let name = disk_name(&dir, &name);
                let handle = nt::open_at_wide(&dir, &name, nt::READ_ACCESS, FILE_OPEN, 0).map_err(|e| os(e, "open", path))?;
                if nt::kind(&handle).map_err(|e| os(e, "fstat", path))? != Kind::File {
                    return Err(HostError::new("NOT_A_REGULAR_FILE", format!("Not a regular file: {path}")));
                }
                let size = nt::size(&handle).map_err(|e| os(e, "fstat", path))?;
                Ok(OpenFile { file: File::from(handle), size, temp_path: None })
            }
        }
    }

    /// A fresh directory per source under the user's temp folder, created on first use.
    pub fn create_temp(&mut self) -> HostResult<OpenFile> {
        if self.temp_dir.is_none() {
            let dir = tempfile::Builder::new().prefix("thoth-import-").tempdir().map_err(|e| HostError::io(&e, "mkdtemp", "temp"))?;
            let meta = std::fs::symlink_metadata(dir.path()).map_err(|e| HostError::io(&e, "lstat", "temp"))?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(HostError::internal("Import temp directory is not a plain directory"));
            }
            self.temp_dir = Some(dir);
        }
        let dir = self.temp_dir.as_ref().expect("created above").path();
        self.temp_count += 1;
        let path = dir.join(format!("part-{}.tmp", self.temp_count));
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .access_mode(fs::FILE_GENERIC_READ | fs::FILE_GENERIC_WRITE | fs::DELETE)
            .custom_flags(fs::FILE_FLAG_DELETE_ON_CLOSE | fs::FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)
            .map_err(|e| HostError::io(&e, "open", "temp"))?;
        Ok(OpenFile { file, size: 0, temp_path: Some(path) })
    }
}

impl OpenFile {
    pub fn read(&self, position: u64, length: usize) -> HostResult<Vec<u8>> {
        if length > MAX_READ_BYTES {
            return Err(HostError::bad_argument(format!("Read of {length} bytes exceeds the {MAX_READ_BYTES}-byte limit")));
        }
        // Temp files are bounded by what was written; source files read whatever is there (callers bound by size at open).
        let length = if self.temp_path.is_some() { length.min(self.size.saturating_sub(position) as usize) } else { length };
        let mut out = vec![0u8; length];
        let mut done = 0;
        while done < length {
            match self.file.seek_read(&mut out[done..], position + done as u64) {
                Ok(0) => break,
                Ok(n) => done += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                // Reading at or past the end of a file is ERROR_HANDLE_EOF on Windows: the end, not a failure.
                Err(e) if e.raw_os_error() == Some(f::ERROR_HANDLE_EOF as i32) => break,
                Err(e) => return Err(HostError::io(&e, "read", "file")),
            }
        }
        out.truncate(done);
        Ok(out)
    }

    pub fn write(&mut self, position: u64, data: &[u8]) -> HostResult<()> {
        if self.temp_path.is_none() {
            return Err(HostError::bad_argument("Only temp files are writable"));
        }
        let end = position
            .checked_add(data.len() as u64)
            .filter(|end| *end <= MAX_TEMP_BYTES)
            .ok_or_else(|| HostError::bad_argument(format!("Temp files are limited to {MAX_TEMP_BYTES} bytes")))?;
        let mut done = 0;
        while done < data.len() {
            match self.file.seek_write(&data[done..], position + done as u64) {
                Ok(0) => return Err(HostError::new("EIO", "EIO: short write, write 'temp'")),
                Ok(n) => done += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(HostError::io(&e, "write", "temp")),
            }
        }
        self.size = self.size.max(end);
        Ok(())
    }

    /// Deletes a temp file's name now; the system deletes the file when the handle closes in any case.
    pub fn discard(self) {
        if let Some(path) = &self.temp_path {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn walk_error(e: WalkError, raw: &str, op: &str) -> HostError {
    match e {
        WalkError::Symlink => HostError::unsafe_path(raw, "symlinked directory in source path"),
        WalkError::Os(e) if e.0 == f::ERROR_DIRECTORY => HostError::new("ENOTDIR", format!("Not a directory in source path: {raw}")),
        WalkError::Os(e) => os(e, op, raw),
    }
}
