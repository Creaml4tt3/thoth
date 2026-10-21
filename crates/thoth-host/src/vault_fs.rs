//! Scoped `VaultFs` (packages/local-store/src/ports.ts) on a vault root fd.
//! Semantics match `NodeVaultFs`: vault-relative paths only, symlinks reported
//! and never followed, exclusive create, no-replace rename with the
//! exclusive-copy fallback, fsync of the file and (after rename) its directory.
//!
//! Differences from Node, all stricter: every operation is `openat`-relative to
//! a directory fd opened once per vault (no TOCTOU on ancestors); `list`
//! refuses a symlinked directory; opens add `O_NONBLOCK` so a FIFO cannot hang
//! the host; and the live index database files cannot be mutated through fs.
use crate::at::{self, WalkError, file_type, kind_name, mtime_ms};
use crate::error::{HostError, HostResult};
use crate::paths::{is_reserved_first_segment, vault_segments};
use rustix::fs::{AtFlags, FileType, Mode, OFlags, linkat, mkdirat, openat, renameat, statat, unlinkat};
use rustix::io::Errno;
use serde_json::{Value, json};
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use unicode_normalization::UnicodeNormalization;

/// Largest file the host reads or writes in one call (the importer's 1 GiB entry limit).
pub const MAX_FILE_BYTES: usize = 1024 * 1024 * 1024;
const MAX_REMOVE_DEPTH: usize = 256;

pub struct VaultFs {
    root: OwnedFd,
    /// Test hook (`THOTH_TEST_DISABLE_HARDLINK` in the stdio harness): `link` fails with ENOTSUP.
    disable_hardlink: bool,
}

/// The parent directory fd of a path plus its final component.
struct Target {
    dir: OwnedFd,
    name: String,
}

impl VaultFs {
    pub fn new(root: OwnedFd, disable_hardlink: bool) -> Self {
        Self { root, disable_hardlink }
    }

    pub fn root_fd(&self) -> BorrowedFd<'_> {
        self.root.as_fd()
    }

    /// Resolves the parent of `path` without following symlinks.
    fn target(&self, raw: &str, op: &str) -> HostResult<Target> {
        let mut segments = vault_segments(raw, false)?;
        let name = segments.pop().expect("non-empty");
        let dir = at::open_dir(self.root.as_fd(), &segments).map_err(|e| walk_error(e, raw, op))?;
        Ok(Target { dir, name })
    }

    pub fn stat(&self, raw: &str) -> HostResult<Value> {
        let st = if raw.is_empty() {
            rustix::fs::fstat(&self.root).map_err(|e| HostError::errno(e, "lstat", raw))?
        } else {
            let target = match self.target(raw, "lstat") {
                Ok(t) => t,
                Err(e) if e.code == "ENOENT" || e.code == "ENOTDIR" => return Ok(Value::Null),
                Err(e) => return Err(e),
            };
            match statat(&target.dir, target.name.as_str(), AtFlags::SYMLINK_NOFOLLOW) {
                Ok(st) => st,
                Err(Errno::NOENT | Errno::NOTDIR) => return Ok(Value::Null),
                Err(e) => return Err(HostError::errno(e, "lstat", raw)),
            }
        };
        Ok(json!({ "kind": kind_name(file_type(&st)), "size": st.st_size, "mtimeMs": mtime_ms(&st) }))
    }

    pub fn read(&self, raw: &str) -> HostResult<Vec<u8>> {
        let target = self.target(raw, "open")?;
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
        let fd = openat(&target.dir, target.name.as_str(), flags, Mode::empty()).map_err(|e| HostError::errno(e, "open", raw))?;
        let st = rustix::fs::fstat(&fd).map_err(|e| HostError::errno(e, "fstat", raw))?;
        match file_type(&st) {
            FileType::RegularFile => {}
            FileType::Directory => return Err(HostError::errno(Errno::ISDIR, "read", raw)),
            _ => return Err(HostError::new("NOT_A_REGULAR_FILE", format!("Not a regular file: {raw}"))),
        }
        if st.st_size as u64 > MAX_FILE_BYTES as u64 {
            return Err(HostError::bad_argument(format!("File exceeds the {MAX_FILE_BYTES}-byte limit: {raw}")));
        }
        let mut out = Vec::with_capacity(st.st_size as usize);
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = rustix::io::read(&fd, &mut buf).map_err(|e| HostError::errno(e, "read", raw))?;
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
        let segments = vault_segments(raw, true)?;
        let dir = at::open_dir(self.root.as_fd(), &segments).map_err(|e| walk_error(e, raw, "scandir"))?;
        let entries = at::read_dir(dir.as_fd()).map_err(|e| HostError::errno(e, "scandir", raw))?;
        Ok(Value::Array(
            entries.into_iter().map(|(name, ft)| json!({ "name": name.nfc().collect::<String>(), "kind": kind_name(ft) })).collect(),
        ))
    }

    pub fn mkdirp(&self, raw: &str) -> HostResult<()> {
        let segments = vault_segments(raw, true)?;
        let last = segments.len().saturating_sub(1);
        let mut current: Option<OwnedFd> = None;
        for (i, segment) in segments.iter().enumerate() {
            let parent = current.as_ref().map_or(self.root.as_fd(), |fd| fd.as_fd());
            let next = match at::open_child_dir(parent, segment) {
                Ok(fd) => fd,
                Err(WalkError::Errno(Errno::NOENT)) => {
                    match mkdirat(parent, segment.as_str(), Mode::from_raw_mode(0o777)) {
                        Ok(()) | Err(Errno::EXIST) => {}
                        Err(e) => return Err(HostError::errno(e, "mkdir", raw)),
                    }
                    at::open_child_dir(parent, segment).map_err(|e| walk_error(e, raw, "mkdir"))?
                }
                // Like `mkdir -p`: an existing non-directory is EEXIST at the end, ENOTDIR above it.
                Err(WalkError::Errno(Errno::NOTDIR)) if i == last => return Err(HostError::errno(Errno::EXIST, "mkdir", raw)),
                Err(e) => return Err(walk_error(e, raw, "mkdir")),
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
        let target = self.target(raw, "open")?;
        let mode_flag = if exclusive { OFlags::EXCL } else { OFlags::TRUNC };
        let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC | mode_flag;
        let fd = openat(&target.dir, target.name.as_str(), flags, Mode::from_raw_mode(0o644)).map_err(|e| HostError::errno(e, "open", raw))?;
        let st = rustix::fs::fstat(&fd).map_err(|e| HostError::errno(e, "fstat", raw))?;
        if file_type(&st) != FileType::RegularFile {
            return Err(HostError::new("NOT_A_REGULAR_FILE", format!("Not a regular file: {raw}")));
        }
        write_all(&fd, data).map_err(|e| HostError::errno(e, "write", raw))?;
        full_sync(&fd).map_err(|e| HostError::errno(e, "fsync", raw))
    }

    pub fn rename(&self, from: &str, to: &str, no_replace: bool) -> HostResult<()> {
        refuse_index_files(from)?;
        refuse_index_files(to)?;
        let src = self.target(from, "rename")?;
        let dst = self.target(to, "rename")?;
        let pair = format!("{from}' -> '{to}");
        if no_replace {
            // link() fails with EEXIST if the target exists, giving an atomic no-replace rename.
            // Filesystems without hardlinks fall back to an exclusive copy, which also fails with EEXIST.
            let linked = if self.disable_hardlink {
                Err(Errno::NOTSUP)
            } else {
                linkat(&src.dir, src.name.as_str(), &dst.dir, dst.name.as_str(), AtFlags::empty())
            };
            match linked {
                Ok(()) => {}
                Err(e @ (Errno::PERM | Errno::NOTSUP | Errno::OPNOTSUPP | Errno::XDEV | Errno::NOSYS)) => copy_exclusive(&src, &dst, e).map_err(|e| HostError::errno(e, "copyfile", &pair))?,
                Err(e) => return Err(HostError::errno(e, "link", &pair)),
            }
            unlinkat(&src.dir, src.name.as_str(), AtFlags::empty()).map_err(|e| HostError::errno(e, "unlink", from))?;
        } else {
            renameat(&src.dir, src.name.as_str(), &dst.dir, dst.name.as_str()).map_err(|e| HostError::errno(e, "rename", &pair))?;
        }
        // Make the new directory entry durable (best effort, as in Node).
        let _ = full_sync(&dst.dir);
        Ok(())
    }

    pub fn remove(&self, raw: &str) -> HostResult<()> {
        refuse_index_files(raw)?;
        let target = match self.target(raw, "rm") {
            Ok(t) => t,
            // `rm -rf` semantics: a missing path is not an error.
            Err(e) if e.code == "ENOENT" => return Ok(()),
            Err(e) => return Err(e),
        };
        match statat(&target.dir, target.name.as_str(), AtFlags::SYMLINK_NOFOLLOW) {
            Err(Errno::NOENT) => Ok(()),
            Err(e) => Err(HostError::errno(e, "rm", raw)),
            Ok(st) if file_type(&st) == FileType::Directory => remove_tree(target.dir.as_fd(), &target.name, 0).map_err(|e| HostError::errno(e, "rm", raw)),
            Ok(_) => match unlinkat(&target.dir, target.name.as_str(), AtFlags::empty()) {
                Ok(()) | Err(Errno::NOENT) => Ok(()),
                Err(e) => Err(HostError::errno(e, "rm", raw)),
            },
        }
    }
}

fn walk_error(e: WalkError, raw: &str, op: &str) -> HostError {
    match e {
        WalkError::Symlink => HostError::unsafe_path(raw, "symlinked directory in path"),
        WalkError::Errno(errno) => HostError::errno(errno, op, raw),
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

fn write_all(fd: &OwnedFd, mut data: &[u8]) -> Result<(), Errno> {
    while !data.is_empty() {
        match rustix::io::write(fd, data) {
            Ok(0) => return Err(Errno::IO),
            Ok(n) => data = &data[n..],
            Err(Errno::INTR) => {}
            Err(Errno::AGAIN) => std::thread::yield_now(),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// fsync that reaches the disk: libuv (Node) uses F_FULLFSYNC on Apple platforms, falling back to fsync.
pub fn full_sync(fd: &OwnedFd) -> Result<(), Errno> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        if rustix::fs::fcntl_fullfsync(fd).is_ok() {
            return Ok(());
        }
    }
    rustix::fs::fsync(fd)
}

/// Exclusive copy for filesystems without hardlinks. Never follows a symlink and copies regular files only.
fn copy_exclusive(src: &Target, dst: &Target, link_error: Errno) -> Result<(), Errno> {
    let input = openat(&src.dir, src.name.as_str(), OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC, Mode::empty())?;
    let st = rustix::fs::fstat(&input)?;
    if file_type(&st) != FileType::RegularFile {
        return Err(link_error);
    }
    let mode = Mode::from_raw_mode((st.st_mode as u32 & 0o777) as _);
    let output = openat(&dst.dir, dst.name.as_str(), OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC, mode)?;
    let copied = (|| {
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = rustix::io::read(&input, &mut buf)?;
            if n == 0 {
                break;
            }
            write_all(&output, &buf[..n])?;
        }
        full_sync(&output)
    })();
    if let Err(e) = copied {
        // Never leave a partial copy behind under the target name.
        let _ = unlinkat(&dst.dir, dst.name.as_str(), AtFlags::empty());
        return Err(e);
    }
    Ok(())
}

/// Recursive delete that never follows a symlink: directories are opened with O_NOFOLLOW, everything else is unlinked.
fn remove_tree(parent: BorrowedFd<'_>, name: &str, depth: usize) -> Result<(), Errno> {
    if depth > MAX_REMOVE_DEPTH {
        return Err(Errno::LOOP);
    }
    let dir = match at::open_child_dir(parent, name) {
        Ok(fd) => fd,
        // Swapped for a symlink or file since the stat: unlink the entry itself, never its target.
        Err(WalkError::Symlink | WalkError::Errno(Errno::NOTDIR | Errno::LOOP)) => {
            return match unlinkat(parent, name, AtFlags::empty()) {
                Ok(()) | Err(Errno::NOENT) => Ok(()),
                Err(e) => Err(e),
            };
        }
        Err(WalkError::Errno(Errno::NOENT)) => return Ok(()),
        Err(WalkError::Errno(e)) => return Err(e),
    };
    for (child, ft) in at::read_dir(dir.as_fd())? {
        if ft == FileType::Directory {
            remove_tree(dir.as_fd(), &child, depth + 1)?;
        } else {
            match unlinkat(&dir, child.as_str(), AtFlags::empty()) {
                Ok(()) | Err(Errno::NOENT) => {}
                // A directory reported with another type (or swapped in): recurse instead.
                Err(Errno::PERM | Errno::ISDIR) => remove_tree(dir.as_fd(), &child, depth + 1)?,
                Err(e) => return Err(e),
            }
        }
    }
    match unlinkat(parent, name, AtFlags::REMOVEDIR) {
        Ok(()) | Err(Errno::NOENT) => Ok(()),
        Err(e) => Err(e),
    }
}
