//! Handle-relative traversal on Windows, the counterpart of `at.rs`: every lookup starts from a directory handle the
//! host opened when the vault or source was opened, and walks one component at a time, refusing any reparse point.
//!
//! Names are looked up as given (NFC for vault paths). NTFS compares names code unit by code unit after case
//! folding, so a name stored in another Unicode normalization form (NFD, common in folders copied from macOS) would
//! not be found by its NFC spelling, while `list` reports it in NFC. When a non-ASCII name is not found, the
//! directory is searched for an entry whose NFC form is the requested name, and that entry is used: lookups behave
//! like APFS (normalization-insensitive) and creating `café.md` next to an NFD `café.md` is EEXIST, not a twin.
use super::nt::{self, DIR_ACCESS, FILE_DIRECTORY_FILE, FILE_OPEN, Kind, OsError};
use std::os::windows::io::OwnedHandle;
use unicode_normalization::UnicodeNormalization;
use windows_sys::Win32::Foundation as f;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalkError {
    /// A component that should be a directory is a symlink, junction or other reparse point.
    Symlink,
    Os(OsError),
}

impl From<OsError> for WalkError {
    fn from(e: OsError) -> Self {
        Self::Os(e)
    }
}

/// The name to use for `name` inside `dir`: `name` itself, or the on-disk spelling of an entry whose NFC form is
/// `name` when `name` itself does not exist.
pub fn disk_name(dir: &OwnedHandle, name: &str) -> Vec<u16> {
    let wide: Vec<u16> = name.encode_utf16().collect();
    if name.is_ascii() {
        return wide;
    }
    match nt::open_at_wide(dir, &wide, nt::ATTR_ACCESS, FILE_OPEN, 0) {
        Err(e) if e.is_not_found() => {}
        _ => return wide,
    }
    let Ok(entries) = nt::read_dir(dir) else { return wide };
    entries.into_iter().find(|e| e.name != name && e.name.nfc().eq(name.chars())).map(|e| e.wide).unwrap_or(wide)
}

/// Opens `name` under `dir` as a directory, refusing a reparse point.
pub fn open_child_dir(dir: &OwnedHandle, name: &str) -> Result<OwnedHandle, WalkError> {
    open_child_dir_wide(dir, &disk_name(dir, name))
}

pub fn open_child_dir_wide(dir: &OwnedHandle, name: &[u16]) -> Result<OwnedHandle, WalkError> {
    match nt::open_at_wide(dir, name, DIR_ACCESS, FILE_OPEN, FILE_DIRECTORY_FILE) {
        Ok(handle) => match nt::kind(&handle)? {
            Kind::Directory => Ok(handle),
            Kind::Symlink | Kind::Other => Err(WalkError::Symlink),
            Kind::File => Err(WalkError::Os(OsError(f::ERROR_DIRECTORY))),
        },
        // A file, or a symlink to one (a directory symlink or junction opens as a directory, checked above).
        Err(e) if e.0 == f::ERROR_DIRECTORY => match classify_wide(dir, name) {
            Ok(Kind::Symlink | Kind::Other) => Err(WalkError::Symlink),
            _ => Err(WalkError::Os(e)),
        },
        Err(e) => Err(WalkError::Os(e)),
    }
}

/// What `name` under `dir` is, without following it.
pub fn classify_wide(dir: &OwnedHandle, name: &[u16]) -> Result<Kind, OsError> {
    nt::kind(&nt::open_at_wide(dir, name, nt::ATTR_ACCESS, FILE_OPEN, 0)?)
}

/// Another handle for the directory `root` itself (`DuplicateHandle`: the same open directory, never a new name
/// lookup). Duplicates share the enumeration position, which `nt::read_dir` serializes.
pub fn reopen(root: &OwnedHandle) -> Result<OwnedHandle, OsError> {
    root.try_clone().map_err(|e| OsError(e.raw_os_error().map_or(f::ERROR_INVALID_HANDLE, |c| c as u32)))
}

/// Opens the directory reached by `segments` from `root`, never following a reparse point.
pub fn open_dir(root: &OwnedHandle, segments: &[String]) -> Result<OwnedHandle, WalkError> {
    let mut current: Option<OwnedHandle> = None;
    for segment in segments {
        let parent = current.as_ref().unwrap_or(root);
        current = Some(open_child_dir(parent, segment)?);
    }
    match current {
        Some(handle) => Ok(handle),
        None => Ok(reopen(root)?),
    }
}
