//! The confined file layer on Windows (the POSIX one is `at.rs`, `vault_fs.rs`, `source.rs`).
//!
//! Windows has no `openat`, but the NT API does: `NtCreateFile` with `OBJECT_ATTRIBUTES.RootDirectory` set to an
//! open directory handle resolves the name relative to that directory, like `openat(dirfd, name)`. Every vault and
//! source path is walked one component at a time from the root handle the host opened when the vault or source was
//! opened, and every open carries `FILE_OPEN_REPARSE_POINT` (the reparse point itself is opened, never followed),
//! after which the handle's `FILE_ATTRIBUTE_REPARSE_POINT` is checked. Symlinks, junctions, mount points and any
//! other reparse point are therefore refused at every component, and an ancestor swapped for one between a check and
//! the use cannot redirect the operation (the check is the use). See `nt` for the primitives and `walk` for the
//! traversal; `paths` has root canonicalization and the root policy, `names` the Windows name rules.
//!
//! Why not `CreateFileW` on full paths checked with `GetFinalPathNameByHandleW`: that re-resolves the whole path
//! on every call and can only detect a redirect after the open happened, when its side effects (a file created or
//! truncated in the wrong place) are already done. The relative NT open has no such window and no `MAX_PATH` limit. `GetFinalPathNameByHandleW` is used once, for the root: the root is
//! opened by its canonical path (as on Linux), and the handle's final path must equal that path, which refuses an
//! ancestor swapped for a junction after canonicalization (macOS gets the same from `O_NOFOLLOW_ANY`).
pub mod names;
pub mod nt;
pub mod paths;
pub mod walk;

use crate::error::{HostError, HostResult};
use std::os::windows::io::OwnedHandle;
use std::path::Path;

/// Opens a canonical root directory (vault, agent working directory) and checks that it is still the folder the
/// canonical path names: a directory, not a reparse point, reached without a link in any component.
pub fn open_root(root: &Path) -> HostResult<OwnedHandle> {
    let shown = root.to_string_lossy();
    let handle = nt::open_path(&paths::verbatim(root), nt::DIR_ACCESS, true).map_err(|e| HostError::win32(e.0, "open", &shown))?;
    let (attrs, tag) = nt::attr_tag(&handle).map_err(|e| HostError::win32(e.0, "open", &shown))?;
    match nt::kind_of(attrs, tag) {
        nt::Kind::Directory => {}
        nt::Kind::File => return Err(HostError::win32(windows_sys::Win32::Foundation::ERROR_DIRECTORY, "open", &shown)),
        _ => return Err(HostError::unsafe_path(&shown, "the folder is a symlink or reparse point")),
    }
    verify_final_path(&handle, root)?;
    Ok(handle)
}

/// Refuses a handle whose final path is not `expected` (a canonical, simplified path).
pub fn verify_final_path(handle: &OwnedHandle, expected: &Path) -> HostResult<()> {
    let shown = expected.to_string_lossy();
    let actual = nt::final_path(handle).map_err(|e| HostError::win32(e.0, "open", &shown))?;
    if !paths::same_path(&paths::simplify(&actual), expected) {
        return Err(HostError::unsafe_path(&shown, "the folder moved or a parent folder is a link"));
    }
    Ok(())
}
