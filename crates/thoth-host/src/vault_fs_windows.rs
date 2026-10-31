//! Scoped `VaultFs` (packages/local-store/src/ports.ts) on Windows, on a vault root directory handle. The same
//! contract and guarantees as the POSIX `vault_fs.rs` (tests/ports/contract.ts runs against both), built on the
//! handle-relative NT layer in `win/` instead of `openat`:
//!
//! - Every path is vault-relative and walked from the root handle one component at a time (`win::walk`); no
//!   absolute path is resolved per call. Every open carries `FILE_OPEN_REPARSE_POINT` and checks the handle's
//!   reparse attribute: symlinks, junctions and mount points are reported (`kind: "symlink"`) and never followed,
//!   in any component, and other reparse points are `"other"` and refused the same way.
//! - Names Windows cannot hold (`CON`, `a.md:stream`, `x.`, `<>:"|?*`) cannot exist, so looking one up is "not
//!   found" and creating one is an unsafe path (`win::names`).
//! - Exclusive create is `FILE_CREATE` (atomic, EEXIST). Truncating writes open the existing file first and
//!   truncate that handle, so a symlink in its place is refused, not replaced.
//! - Rename is `SetFileInformationByHandle(FileRenameInfoEx)` on the source handle with the target named relative
//!   to its directory handle. Replace (the CAS write's temp → target) is atomic, with POSIX semantics where the
//!   volume has them. No-replace is the volume's own atomic no-replace rename, so unlike `link()` + `unlink()` no
//!   moment has both names; an existing target answering to the name in any case or normalization is EEXIST
//!   (`a.md` → `A.md` included, as `link()` on a case-insensitive volume). The exclusive-copy fallback remains for a
//!   cross-volume rename and the test hook.
//! - Data is flushed with `FlushFileBuffers` after every write. Directories are not flushed after a rename: Windows
//!   cannot flush a directory handle; NTFS journals the rename itself.
//! - The live index database files cannot be mutated through fs.
use crate::error::{HostError, HostResult};
use crate::paths::{is_reserved_first_segment, vault_segments};
use crate::win::names::segment_problem;
use crate::win::nt::{self, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, Kind, OsError};
use crate::win::walk::{self, WalkError, disk_name};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::windows::io::OwnedHandle;
use unicode_normalization::UnicodeNormalization;
use windows_sys::Win32::Foundation as f;

/// Largest file the host reads or writes in one call (the importer's 1 GiB entry limit).
pub const MAX_FILE_BYTES: usize = 1024 * 1024 * 1024;
const MAX_REMOVE_DEPTH: usize = 256;

pub struct VaultFs {
    root: OwnedHandle,
    /// Test hook (`THOTH_TEST_DISABLE_HARDLINK` in the stdio harness): no-replace rename takes the exclusive copy.
    disable_hardlink: bool,
}

/// The parent directory handle of a path plus its final component (the on-disk spelling, see `walk::disk_name`).
struct Target {
    dir: OwnedHandle,
    name: Vec<u16>,
}

/// A path checked against the Windows name rules.
enum Checked {
    Segments(Vec<String>),
    /// A component no Windows volume can hold: the path cannot exist.
    Impossible(&'static str),
}

fn check(raw: &str, allow_root: bool) -> HostResult<Checked> {
    let segments = vault_segments(raw, allow_root)?;
    match segments.iter().find_map(|s| segment_problem(s)) {
        Some(problem) => Ok(Checked::Impossible(problem)),
        None => Ok(Checked::Segments(segments)),
    }
}

/// Segments for an operation that creates the path: an impossible name is refused as unsafe.
fn creatable(raw: &str, allow_root: bool) -> HostResult<Vec<String>> {
    match check(raw, allow_root)? {
        Checked::Segments(s) => Ok(s),
        Checked::Impossible(problem) => Err(HostError::unsafe_path(raw, problem)),
    }
}

fn not_found(op: &str, raw: &str) -> HostError {
    HostError::win32(f::ERROR_FILE_NOT_FOUND, op, raw)
}

fn os(e: OsError, op: &str, raw: &str) -> HostError {
    HostError::win32(e.0, op, raw)
}

impl VaultFs {
    pub fn new(root: OwnedHandle, disable_hardlink: bool) -> Self {
        Self { root, disable_hardlink }
    }

    fn target_of(&self, mut segments: Vec<String>, raw: &str, op: &str) -> HostResult<Target> {
        let name = segments.pop().expect("non-empty");
        let dir = walk::open_dir(&self.root, &segments).map_err(|e| walk_error(e, raw, op))?;
        let name = disk_name(&dir, &name);
        Ok(Target { dir, name })
    }

    /// The parent of an existing path (`None`: the path cannot exist on Windows).
    fn existing(&self, raw: &str, op: &str) -> HostResult<Option<Target>> {
        match check(raw, false)? {
            Checked::Segments(segments) => self.target_of(segments, raw, op).map(Some),
            Checked::Impossible(_) => Ok(None),
        }
    }

    /// The parent of a path that may be created.
    fn creating(&self, raw: &str, op: &str) -> HostResult<Target> {
        self.target_of(creatable(raw, false)?, raw, op)
    }

    pub fn stat(&self, raw: &str) -> HostResult<Value> {
        let handle = if raw.is_empty() {
            walk::reopen(&self.root).map_err(|e| os(e, "lstat", raw))?
        } else {
            let target = match self.existing(raw, "lstat") {
                Ok(Some(t)) => t,
                Ok(None) => return Ok(Value::Null),
                Err(e) if e.code == "ENOENT" || e.code == "ENOTDIR" => return Ok(Value::Null),
                Err(e) => return Err(e),
            };
            match nt::open_at_wide(&target.dir, &target.name, nt::ATTR_ACCESS, FILE_OPEN, 0) {
                Ok(h) => h,
                Err(e) if e.is_not_found() || e.0 == f::ERROR_DIRECTORY => return Ok(Value::Null),
                Err(e) => return Err(os(e, "lstat", raw)),
            }
        };
        let fail = |e: OsError| os(e, "lstat", raw);
        let kind = nt::kind(&handle).map_err(fail)?;
        let size = nt::size(&handle).map_err(fail)?;
        let mtime = nt::mtime_ms(&handle).map_err(fail)?;
        Ok(json!({ "kind": nt::kind_name(kind), "size": size, "mtimeMs": mtime }))
    }

    pub fn read(&self, raw: &str) -> HostResult<Vec<u8>> {
        let Some(target) = self.existing(raw, "open")? else { return Err(not_found("open", raw)) };
        let handle = nt::open_at_wide(&target.dir, &target.name, nt::READ_ACCESS, FILE_OPEN, 0).map_err(|e| os(e, "open", raw))?;
        match nt::kind(&handle).map_err(|e| os(e, "fstat", raw))? {
            Kind::File => {}
            Kind::Directory => return Err(os(OsError(f::ERROR_DIRECTORY_NOT_SUPPORTED), "read", raw)),
            // O_NOFOLLOW on a symlink is ELOOP.
            Kind::Symlink => return Err(os(OsError(f::ERROR_CANT_RESOLVE_FILENAME), "open", raw)),
            Kind::Other => return Err(HostError::new("NOT_A_REGULAR_FILE", format!("Not a regular file: {raw}"))),
        }
        let size = nt::size(&handle).map_err(|e| os(e, "fstat", raw))?;
        if size > MAX_FILE_BYTES as u64 {
            return Err(HostError::bad_argument(format!("File exceeds the {MAX_FILE_BYTES}-byte limit: {raw}")));
        }
        let mut file = std::fs::File::from(handle);
        let mut out = Vec::with_capacity(size as usize);
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = match file.read(&mut buf) {
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(HostError::io(&e, "read", raw)),
            };
            if n == 0 {
                break;
            }
            if out.len() + n > MAX_FILE_BYTES {
                return Err(HostError::bad_argument(format!("File exceeds the {MAX_FILE_BYTES}-byte limit: {raw}")));
            }
            out.extend_from_slice(&buf[..n]);
        }
        Ok(out)
    }

    pub fn list(&self, raw: &str) -> HostResult<Value> {
        let segments = match check(raw, true)? {
            Checked::Segments(s) => s,
            Checked::Impossible(_) => return Err(not_found("scandir", raw)),
        };
        let dir = walk::open_dir(&self.root, &segments).map_err(|e| walk_error(e, raw, "scandir"))?;
        let entries = nt::read_dir(&dir).map_err(|e| os(e, "scandir", raw))?;
        Ok(Value::Array(entries.into_iter().map(|e| json!({ "name": e.name.nfc().collect::<String>(), "kind": nt::kind_name(e.kind) })).collect()))
    }

    pub fn mkdirp(&self, raw: &str) -> HostResult<()> {
        let segments = creatable(raw, true)?;
        let last = segments.len().saturating_sub(1);
        let mut current: Option<OwnedHandle> = None;
        for (i, segment) in segments.iter().enumerate() {
            let parent = current.as_ref().unwrap_or(&self.root);
            let name = disk_name(parent, segment);
            let next = match walk::open_child_dir_wide(parent, &name) {
                Ok(handle) => handle,
                Err(WalkError::Os(e)) if e.is_not_found() => match nt::open_at_wide(parent, &name, nt::DIR_ACCESS, FILE_CREATE, FILE_DIRECTORY_FILE) {
                    Ok(handle) => handle,
                    Err(e) if e.0 == f::ERROR_ALREADY_EXISTS || e.0 == f::ERROR_FILE_EXISTS => {
                        walk::open_child_dir_wide(parent, &name).map_err(|e| mkdir_error(e, i == last, raw))?
                    }
                    Err(e) => return Err(os(e, "mkdir", raw)),
                },
                Err(e) => return Err(mkdir_error(e, i == last, raw)),
            };
            current = Some(next);
        }
        Ok(())
    }

    pub fn write(&self, raw: &str, data: &[u8], exclusive: bool) -> HostResult<()> {
        if data.len() > MAX_FILE_BYTES {
            return Err(HostError::bad_argument(format!("Write exceeds the {MAX_FILE_BYTES}-byte limit")));
        }
        refuse_index_files(raw)?;
        let target = self.creating(raw, "open")?;
        let create = || nt::open_at_wide(&target.dir, &target.name, nt::WRITE_ACCESS, FILE_CREATE, FILE_NON_DIRECTORY_FILE);
        let handle = if exclusive {
            create().map_err(|e| os(e, "open", raw))?
        } else {
            // Open what is there (never through a link), else create; a create lost to a racing creator retries once.
            let mut attempt = 0;
            loop {
                attempt += 1;
                match nt::open_at_wide(&target.dir, &target.name, nt::WRITE_ACCESS, FILE_OPEN, 0) {
                    Ok(handle) => {
                        match nt::kind(&handle).map_err(|e| os(e, "fstat", raw))? {
                            Kind::File => {}
                            Kind::Directory => return Err(os(OsError(f::ERROR_DIRECTORY_NOT_SUPPORTED), "open", raw)),
                            Kind::Symlink => return Err(os(OsError(f::ERROR_CANT_RESOLVE_FILENAME), "open", raw)),
                            Kind::Other => return Err(HostError::new("NOT_A_REGULAR_FILE", format!("Not a regular file: {raw}"))),
                        }
                        break handle;
                    }
                    Err(e) if e.is_not_found() => match create() {
                        Ok(handle) => break handle,
                        Err(e) if attempt == 1 && (e.0 == f::ERROR_ALREADY_EXISTS || e.0 == f::ERROR_FILE_EXISTS) => continue,
                        Err(e) => return Err(os(e, "open", raw)),
                    },
                    Err(e) => return Err(os(e, "open", raw)),
                }
            }
        };
        let mut file = std::fs::File::from(handle);
        if !exclusive {
            file.set_len(0).map_err(|e| HostError::io(&e, "ftruncate", raw))?;
        }
        file.write_all(data).map_err(|e| HostError::io(&e, "write", raw))?;
        file.sync_all().map_err(|e| HostError::io(&e, "fsync", raw))
    }

    pub fn rename(&self, from: &str, to: &str, no_replace: bool) -> HostResult<()> {
        refuse_index_files(from)?;
        refuse_index_files(to)?;
        let Some(src) = self.existing(from, "rename")? else { return Err(not_found("rename", from)) };
        let dst = self.creating(to, "rename")?;
        let pair = format!("{from}' -> '{to}");
        // The entry itself, never what it points to: renaming a symlink renames the link, as renameat does.
        let source = nt::open_at_wide(&src.dir, &src.name, nt::DELETE_ACCESS, FILE_OPEN, 0).map_err(|e| os(e, "rename", &pair))?;
        if no_replace {
            if self.disable_hardlink {
                return self.copy_then_delete(&src, &source, &dst, &pair);
            }
            // Anything answering to the target name is EEXIST, even the source itself in another letter case:
            // the volume would allow that rename without a replace, `link()` on a case-insensitive volume does not.
            match nt::open_at_wide(&dst.dir, &dst.name, nt::ATTR_ACCESS, FILE_OPEN, 0) {
                Ok(_) => return Err(os(OsError(f::ERROR_ALREADY_EXISTS), "link", &pair)),
                Err(e) if e.is_not_found() => {}
                Err(e) => return Err(os(e, "link", &pair)),
            }
            match nt::rename(&source, &dst.dir, &dst.name, false) {
                Ok(()) => Ok(()),
                Err(e) if e.0 == f::ERROR_NOT_SAME_DEVICE => self.copy_then_delete(&src, &source, &dst, &pair),
                Err(e) => Err(os(e, "link", &pair)),
            }
        } else {
            nt::rename(&source, &dst.dir, &dst.name, true).map_err(|e| os(e, "rename", &pair))
        }
    }

    /// The no-replace fallback: exclusive copy of a regular file, flushed, then the source is deleted.
    fn copy_then_delete(&self, src: &Target, source: &OwnedHandle, dst: &Target, pair: &str) -> HostResult<()> {
        copy_exclusive(src, dst).map_err(|e| os(e, "copyfile", pair))?;
        nt::delete(source).map_err(|e| os(e, "unlink", pair))
    }

    pub fn remove(&self, raw: &str) -> HostResult<()> {
        refuse_index_files(raw)?;
        let target = match self.existing(raw, "rm") {
            Ok(Some(t)) => t,
            Ok(None) => return Ok(()),
            // `rm -rf` semantics: a missing path is not an error.
            Err(e) if e.code == "ENOENT" => return Ok(()),
            Err(e) => return Err(e),
        };
        remove_entry(&target.dir, &target.name, 0).map_err(|e| os(e, "rm", raw))
    }

    /// Refuses a vault whose index database (or its WAL, shared-memory or rollback journal file) is a symlink or
    /// other reparse point. SQLite's `SQLITE_OPEN_NOFOLLOW` is enforced by its Unix VFS only, so on Windows the host
    /// checks through the root handle before opening the database (`.thoth` itself was just checked by `mkdirp`).
    pub fn refuse_linked_index(&self) -> HostResult<()> {
        let dir = walk::open_dir(&self.root, &[".thoth".to_owned()]).map_err(|e| walk_error(e, ".thoth", "open"))?;
        for name in ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm", "index.sqlite-journal"] {
            let wide: Vec<u16> = name.encode_utf16().collect();
            if let Ok(Kind::Symlink | Kind::Other) = walk::classify_wide(&dir, &wide) {
                return Err(HostError::new("SQLITE_ERROR", format!("The index database .thoth/{name} is a symlink")));
            }
        }
        Ok(())
    }
}

fn walk_error(e: WalkError, raw: &str, op: &str) -> HostError {
    match e {
        WalkError::Symlink => HostError::unsafe_path(raw, "symlinked directory in path"),
        WalkError::Os(e) => os(e, op, raw),
    }
}

/// Like `mkdir -p`: an existing non-directory is EEXIST at the end, ENOTDIR above it.
fn mkdir_error(e: WalkError, last: bool, raw: &str) -> HostError {
    match e {
        WalkError::Os(e) if e.0 == f::ERROR_DIRECTORY && last => os(OsError(f::ERROR_ALREADY_EXISTS), "mkdir", raw),
        e => walk_error(e, raw, "mkdir"),
    }
}

/// The live SQLite files are owned by the host's connection; the webview reaches them only through SQL.
fn refuse_index_files(raw: &str) -> HostResult<()> {
    let segments = vault_segments(raw, false)?;
    let protected = match segments.as_slice() {
        [first] => is_reserved_first_segment(first),
        [first, name] => is_reserved_first_segment(first) && name.to_lowercase().starts_with("index.sqlite"),
        _ => false,
    };
    if protected {
        return Err(HostError::not_allowed(format!("{raw} is managed by the host and cannot be modified through the file API")));
    }
    Ok(())
}

/// Exclusive copy of a regular file, never through a link. A partial copy is deleted.
fn copy_exclusive(src: &Target, dst: &Target) -> Result<(), OsError> {
    let input = nt::open_at_wide(&src.dir, &src.name, nt::READ_ACCESS, FILE_OPEN, FILE_NON_DIRECTORY_FILE)?;
    if nt::kind(&input)? != Kind::File {
        return Err(OsError(f::ERROR_NOT_SUPPORTED));
    }
    let output =
        nt::open_at_wide(&dst.dir, &dst.name, nt::WRITE_ACCESS | windows_sys::Win32::Storage::FileSystem::DELETE, FILE_CREATE, FILE_NON_DIRECTORY_FILE)?;
    let io_error = |e: std::io::Error| OsError(e.raw_os_error().map_or(f::ERROR_WRITE_FAULT, |c| c as u32));
    let mut reader = std::fs::File::from(input);
    let output_file = std::fs::File::from(output.try_clone().map_err(io_error)?);
    let copied = (|| {
        let mut writer = &output_file;
        std::io::copy(&mut reader, &mut writer).map_err(io_error)?;
        output_file.sync_all().map_err(io_error)
    })();
    if let Err(e) = copied {
        let _ = nt::delete(&output);
        return Err(e);
    }
    Ok(())
}

/// Deletes `name` under `dir`, recursively for a directory, never following a reparse point: a link is deleted as
/// itself.
fn remove_entry(dir: &OwnedHandle, name: &[u16], depth: usize) -> Result<(), OsError> {
    if depth > MAX_REMOVE_DEPTH {
        return Err(OsError(f::ERROR_CANT_RESOLVE_FILENAME));
    }
    let entry = match nt::open_at_wide(dir, name, nt::DELETE_ACCESS, FILE_OPEN, 0) {
        Ok(h) => h,
        Err(e) if e.is_not_found() => return Ok(()),
        Err(e) => return Err(e),
    };
    if nt::kind(&entry)? != Kind::Directory {
        return nt::delete(&entry);
    }
    drop(entry);
    // A real directory: open it to list and delete. If it was swapped for a file or link meanwhile, start over.
    let tree = match nt::open_at_wide(dir, name, nt::DELETE_ACCESS | nt::DIR_ACCESS, FILE_OPEN, FILE_DIRECTORY_FILE) {
        Ok(h) => h,
        Err(e) if e.is_not_found() => return Ok(()),
        Err(e) if e.0 == f::ERROR_DIRECTORY => return remove_entry(dir, name, depth + 1),
        Err(e) => return Err(e),
    };
    if nt::kind(&tree)? != Kind::Directory {
        return nt::delete(&tree);
    }
    for child in nt::read_dir(&tree)? {
        remove_entry(&tree, &child.wide, depth + 1)?;
    }
    nt::delete(&tree)
}
