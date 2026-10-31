//! `openat`-based traversal. Every lookup starts from a directory fd that the
//! host opened when the vault or source was opened, and walks one component at
//! a time with `O_NOFOLLOW | O_DIRECTORY`. No absolute path is re-resolved per
//! call, so swapping an ancestor for a symlink between a check and the use
//! cannot redirect the operation (the check *is* the use).
use rustix::fs::{AtFlags, FileType, Mode, OFlags, Stat, openat, statat};
use rustix::io::Errno;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use unicode_normalization::UnicodeNormalization;

pub const DIR_FLAGS: OFlags = OFlags::RDONLY.union(OFlags::DIRECTORY).union(OFlags::NOFOLLOW).union(OFlags::CLOEXEC);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalkError {
    /// A component that should be a directory is a symlink.
    Symlink,
    Errno(Errno),
}

impl From<Errno> for WalkError {
    fn from(e: Errno) -> Self {
        Self::Errno(e)
    }
}

/// Opens `name` under `dir` as a directory, refusing a symlink.
pub fn open_child_dir(dir: BorrowedFd<'_>, name: &str) -> Result<OwnedFd, WalkError> {
    match openat(dir, name, DIR_FLAGS, Mode::empty()) {
        Ok(fd) => Ok(fd),
        // O_NOFOLLOW on a symlink gives ELOOP (or ENOTDIR with O_DIRECTORY on some systems).
        Err(e @ (Errno::LOOP | Errno::NOTDIR)) => match statat(dir, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(st) if file_type(&st) == FileType::Symlink => Err(WalkError::Symlink),
            _ => Err(WalkError::Errno(e)),
        },
        Err(e) => Err(WalkError::Errno(e)),
    }
}

/// A fresh fd for `root` itself.
pub fn reopen(root: BorrowedFd<'_>) -> Result<OwnedFd, Errno> {
    openat(root, ".", DIR_FLAGS, Mode::empty())
}

/// `name` as it is stored in `dir`: itself, or the entry whose NFC form is `name`. Linux keeps names as bytes, so one
/// written in NFD (copied from a Mac, unzipped) does not answer to the NFC spelling `list` reports; macOS and Windows
/// match both, so there the first lookup succeeds. A name with no entry stays as it is (it is about to be created).
pub fn on_disk_name(dir: BorrowedFd<'_>, name: &str) -> String {
    if name.is_ascii() || statat(dir, name, AtFlags::SYMLINK_NOFOLLOW).is_ok() {
        return name.to_owned();
    }
    let stored = read_dir(dir).ok().and_then(|entries| entries.into_iter().map(|(n, _)| n).find(|n| n.nfc().eq(name.chars())));
    stored.unwrap_or_else(|| name.to_owned())
}

/// Opens the directory reached by `segments` from `root`, never following a symlink.
pub fn open_dir(root: BorrowedFd<'_>, segments: &[String]) -> Result<OwnedFd, WalkError> {
    let mut current: Option<OwnedFd> = None;
    for segment in segments {
        let parent = current.as_ref().map_or(root, |fd| fd.as_fd());
        current = Some(open_child_dir(parent, &on_disk_name(parent, segment))?);
    }
    match current {
        Some(fd) => Ok(fd),
        None => Ok(reopen(root)?),
    }
}

pub fn file_type(st: &Stat) -> FileType {
    FileType::from_raw_mode(st.st_mode as _)
}

/// The port's `EntryKind`.
pub fn kind_name(ft: FileType) -> &'static str {
    match ft {
        FileType::RegularFile => "file",
        FileType::Directory => "directory",
        FileType::Symlink => "symlink",
        _ => "other",
    }
}

/// Same arithmetic as Node's `Stats.mtimeMs`.
pub fn mtime_ms(st: &Stat) -> f64 {
    st.st_mtime as f64 * 1000.0 + st.st_mtime_nsec as f64 / 1_000_000.0
}

/// Entry type from `d_type`, falling back to `fstatat` (never following) when the filesystem doesn't report it.
pub fn entry_type(dir: BorrowedFd<'_>, name: &str, d_type: FileType) -> FileType {
    if d_type != FileType::Unknown {
        return d_type;
    }
    statat(dir, name, AtFlags::SYMLINK_NOFOLLOW).map(|st| file_type(&st)).unwrap_or(FileType::Unknown)
}

/// Reads a directory's entries (without `.` and `..`) as `(name, type)`; names are lossily decoded.
pub fn read_dir(dir: BorrowedFd<'_>) -> Result<Vec<(String, FileType)>, Errno> {
    let mut out = Vec::new();
    for entry in rustix::fs::Dir::read_from(dir)? {
        let entry = entry?;
        let raw = entry.file_name().to_bytes();
        if raw == b"." || raw == b".." {
            continue;
        }
        let name = String::from_utf8_lossy(raw).into_owned();
        let ft = entry_type(dir, &name, entry.file_type());
        out.push((name, ft));
    }
    Ok(out)
}
