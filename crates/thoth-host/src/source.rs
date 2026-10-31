//! Import `SourceHost` (packages/importer-core/src/ports.ts): read-only access
//! to the one file or folder the user picked, plus private temp files.
//!
//! Folder sources hold a root directory fd and walk it with `openat` (no
//! symlinks in any component). Every open is `O_NOFOLLOW | O_NONBLOCK` and
//! must be a regular file. Temp files live in a fresh 0700 directory under the
//! system temp dir, are created 0600 with `O_EXCL | O_NOFOLLOW`, are only read
//! back through the handle that wrote them, and are deleted on close.
use crate::at::{self, WalkError, file_type, kind_name};
use crate::error::{HostError, HostResult};
use crate::paths::source_segments;
use rustix::fs::{AtFlags, FileType, Mode, OFlags, openat, statat};
use rustix::io::Errno;
use serde_json::{Value, json};
use std::fs::File;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::fs::{FileExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Largest positional read in one call.
pub const MAX_READ_BYTES: usize = 16 * 1024 * 1024;
/// Largest temp-file write in one call, and the temp-file size cap (the importer's 1 GiB entry limit).
pub const MAX_TEMP_BYTES: u64 = 1024 * 1024 * 1024;
/// Open files and temp files per source.
pub const MAX_OPEN_FILES: usize = 256;

pub enum SourceRoot {
    Directory(OwnedFd),
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

impl Source {
    pub fn open(location: &Path) -> HostResult<Self> {
        let display = location.display().to_string();
        let label = location.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| display.clone());
        let fd = openat(rustix::fs::CWD, location, crate::no_symlinks(OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC), Mode::empty())
            .map_err(|e| HostError::errno(e, "open", &display))?;
        let st = rustix::fs::fstat(&fd).map_err(|e| HostError::errno(e, "fstat", &display))?;
        let root = match file_type(&st) {
            FileType::Directory => SourceRoot::Directory(at::reopen(fd.as_fd()).map_err(|e| HostError::errno(e, "open", &display))?),
            FileType::RegularFile => SourceRoot::File { file: File::from(fd), size: st.st_size as u64 },
            _ => return Err(HostError::new("NOT_A_REGULAR_FILE", format!("{label} is not a regular file or directory"))),
        };
        Ok(Self { root, location: location.to_owned(), label, temp_dir: None, temp_count: 0 })
    }

    pub fn root_kind(&self) -> &'static str {
        match self.root {
            SourceRoot::Directory(_) => "directory",
            SourceRoot::File { .. } => "file",
        }
    }

    fn root_dir(&self) -> HostResult<&OwnedFd> {
        match &self.root {
            SourceRoot::Directory(fd) => Ok(fd),
            SourceRoot::File { .. } => Err(HostError::bad_argument("Not a directory source")),
        }
    }

    pub fn list(&self, dir: &str) -> HostResult<Value> {
        let root = self.root_dir()?;
        let segments = source_segments(dir)?;
        let fd = at::open_dir(root.as_fd(), &segments).map_err(|e| walk_error(e, dir, "scandir"))?;
        let mut out = Vec::new();
        for (name, ft) in at::read_dir(fd.as_fd()).map_err(|e| HostError::errno(e, "scandir", dir))? {
            // lstat never follows symlinks; size is reported for regular files only.
            let size =
                if ft == FileType::RegularFile { statat(&fd, name.as_str(), AtFlags::SYMLINK_NOFOLLOW).map(|s| s.st_size as u64).unwrap_or(0) } else { 0 };
            out.push(json!({ "name": name, "kind": kind_name(ft), "size": size }));
        }
        Ok(Value::Array(out))
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
                let mut segments = source_segments(path)?;
                let name = segments.pop().expect("non-empty");
                let dir = at::open_dir(root.as_fd(), &segments).map_err(|e| walk_error(e, path, "open"))?;
                // O_NOFOLLOW refuses a symlinked final component; O_NONBLOCK keeps a FIFO from hanging the open.
                let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
                let fd = openat(&dir, name.as_str(), flags, Mode::empty()).map_err(|e| HostError::errno(e, "open", path))?;
                let st = rustix::fs::fstat(&fd).map_err(|e| HostError::errno(e, "fstat", path))?;
                if file_type(&st) != FileType::RegularFile {
                    return Err(HostError::new("NOT_A_REGULAR_FILE", format!("Not a regular file: {path}")));
                }
                Ok(OpenFile { file: File::from(fd), size: st.st_size as u64, temp_path: None })
            }
        }
    }

    /// A fresh owner-only directory per source, created on first use and verified private.
    pub fn create_temp(&mut self) -> HostResult<OpenFile> {
        if self.temp_dir.is_none() {
            let dir = tempfile::Builder::new()
                .prefix("thoth-import-")
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir()
                .map_err(|e| HostError::io(&e, "mkdtemp", "temp"))?;
            let meta = std::fs::symlink_metadata(dir.path()).map_err(|e| HostError::io(&e, "lstat", "temp"))?;
            if !meta.is_dir() || meta.mode() & 0o077 != 0 || meta.uid() != rustix::process::geteuid().as_raw() {
                return Err(HostError::internal("Import temp directory is not private"));
            }
            self.temp_dir = Some(dir);
        }
        let dir = self.temp_dir.as_ref().expect("created above").path();
        self.temp_count += 1;
        let path = dir.join(format!("part-{}.tmp", self.temp_count));
        let flags = OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let fd = openat(rustix::fs::CWD, &path, flags, Mode::from_raw_mode(0o600)).map_err(|e| HostError::errno(e, "open", "temp"))?;
        Ok(OpenFile { file: File::from(fd), size: 0, temp_path: Some(path) })
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
            match self.file.read_at(&mut out[done..], position + done as u64) {
                Ok(0) => break,
                Ok(n) => done += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
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
        self.file.write_all_at(data, position).map_err(|e| HostError::io(&e, "write", "temp"))?;
        self.size = self.size.max(end);
        Ok(())
    }

    /// Deletes a temp file's name; the fd is closed when dropped.
    pub fn discard(self) {
        if let Some(path) = &self.temp_path {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn walk_error(e: WalkError, raw: &str, op: &str) -> HostError {
    match e {
        WalkError::Symlink => HostError::unsafe_path(raw, "symlinked directory in source path"),
        WalkError::Errno(Errno::NOTDIR) => HostError::new("ENOTDIR", format!("Not a directory in source path: {raw}")),
        WalkError::Errno(errno) => HostError::errno(errno, op, raw),
    }
}
