//! The app data folder after a bundle identifier change (ADR-0031). Tauri names the folder after the identifier, so a
//! new identifier means a new, empty folder. The shell calls `move_legacy` once at start, before anything (the host,
//! the webview, the Connected apps socket) opens either folder: the old folder becomes the new one, unless the new one
//! exists already, which is never overwritten.
use std::io;
use std::path::Path;

/// The identifier before ADR-0031; its app data folder is moved by `move_legacy`.
pub const LEGACY_IDENTIFIER: &str = "io.github.creaml4tt3.thoth";

#[derive(Debug, PartialEq, Eq)]
pub enum Moved {
    /// No old folder: a new installation, or moved before.
    Nothing,
    /// Something is at the new path already (a folder, or anything else): both are left as they are.
    Kept,
    /// The old folder was renamed to the new path.
    Renamed,
    /// The old folder was on another volume: copied to the new path, then removed.
    Copied,
}

/// Moves the folder at `old` to `new`, once. Never overwrites `new` and never removes `old` before `new` holds all of
/// it. A copy goes to a sibling of `new` first and is renamed into place when complete, so a copy cut short leaves no
/// half folder at `new` and is done again next time.
pub fn move_legacy(old: &Path, new: &Path) -> io::Result<Moved> {
    if std::fs::symlink_metadata(new).is_ok() {
        return Ok(Moved::Kept);
    }
    match std::fs::symlink_metadata(old) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Ok(Moved::Nothing),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Moved::Nothing),
        Err(e) => return Err(e),
    }
    if let Some(parent) = new.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(old, new) {
        Ok(()) => Ok(Moved::Renamed),
        Err(e) if e.kind() == io::ErrorKind::CrossesDevices => copy_then_remove(old, new),
        Err(e) => Err(e),
    }
}

fn copy_then_remove(old: &Path, new: &Path) -> io::Result<Moved> {
    let mut partial = new.as_os_str().to_owned();
    partial.push(".moving");
    let partial = std::path::PathBuf::from(partial);
    if std::fs::symlink_metadata(&partial).is_ok() {
        std::fs::remove_dir_all(&partial)?;
    }
    if let Err(e) = copy_tree(old, &partial) {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(e);
    }
    std::fs::rename(&partial, new)?;
    // Best effort: if the old folder cannot be removed, the new one exists now and is the one used.
    let _ = std::fs::remove_dir_all(old);
    Ok(Moved::Copied)
}

/// Folders, files and links. Sockets and other special files are left out: the app makes its socket again.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let (source, target) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&source, &target)?;
        } else if kind.is_file() {
            std::fs::copy(&source, &target)?;
        } else if kind.is_symlink() {
            copy_link(&source, &target)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_link(source: &Path, target: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(std::fs::read_link(source)?, target)
}

#[cfg(windows)]
fn copy_link(_source: &Path, _target: &Path) -> io::Result<()> {
    // shortcut: links are left out on Windows (the app makes none in its data folder); copy them if it ever does.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn old_folder(root: &Path) -> std::path::PathBuf {
        let old = root.join(LEGACY_IDENTIFIER);
        std::fs::create_dir_all(old.join("agent-runs")).unwrap();
        std::fs::write(old.join("recent.json"), "[\"/Users/a/Notes\"]").unwrap();
        std::fs::write(old.join("agent-runs").join("history.json"), "[]").unwrap();
        old
    }

    fn holds_the_old_contents(folder: &Path) {
        assert_eq!(std::fs::read_to_string(folder.join("recent.json")).unwrap(), "[\"/Users/a/Notes\"]");
        assert_eq!(std::fs::read_to_string(folder.join("agent-runs").join("history.json")).unwrap(), "[]");
    }

    #[test]
    fn the_old_folder_becomes_the_new_one() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (old_folder(root.path()), root.path().join("com.thothnotes.desktop"));
        assert_eq!(move_legacy(&old, &new).unwrap(), Moved::Renamed);
        holds_the_old_contents(&new);
        assert!(!old.exists());
        // Once: the next start finds nothing to move.
        assert_eq!(move_legacy(&old, &new).unwrap(), Moved::Kept);
    }

    #[test]
    fn a_new_folder_that_exists_is_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (old_folder(root.path()), root.path().join("com.thothnotes.desktop"));
        std::fs::create_dir(&new).unwrap();
        std::fs::write(new.join("recent.json"), "[]").unwrap();
        assert_eq!(move_legacy(&old, &new).unwrap(), Moved::Kept);
        assert_eq!(std::fs::read_to_string(new.join("recent.json")).unwrap(), "[]");
        holds_the_old_contents(&old);
    }

    #[test]
    fn a_file_at_the_new_path_is_left_and_so_is_the_old_folder() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (old_folder(root.path()), root.path().join("com.thothnotes.desktop"));
        std::fs::write(&new, "not a folder").unwrap();
        assert_eq!(move_legacy(&old, &new).unwrap(), Moved::Kept);
        assert_eq!(std::fs::read_to_string(&new).unwrap(), "not a folder");
        holds_the_old_contents(&old);
    }

    #[test]
    fn neither_folder_is_nothing_to_do() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (root.path().join(LEGACY_IDENTIFIER), root.path().join("com.thothnotes.desktop"));
        assert_eq!(move_legacy(&old, &new).unwrap(), Moved::Nothing);
        assert!(!new.exists() && !old.exists());
        // A file where the old folder would be is not a data folder either.
        std::fs::write(&old, "x").unwrap();
        assert_eq!(move_legacy(&old, &new).unwrap(), Moved::Nothing);
        assert!(!new.exists());
    }

    #[test]
    fn a_copy_holds_everything_but_sockets_and_replaces_a_partial_one() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (old_folder(root.path()), root.path().join("com.thothnotes.desktop"));
        #[cfg(unix)]
        {
            std::fs::create_dir(old.join("mcp")).unwrap();
            let _socket = std::os::unix::net::UnixListener::bind(old.join("mcp").join("thoth.sock")).unwrap();
            std::os::unix::fs::symlink("recent.json", old.join("link")).unwrap();
        }
        // A copy cut short last time.
        std::fs::create_dir(root.path().join("com.thothnotes.desktop.moving")).unwrap();
        std::fs::write(root.path().join("com.thothnotes.desktop.moving").join("stale"), "x").unwrap();
        assert_eq!(copy_then_remove(&old, &new).unwrap(), Moved::Copied);
        holds_the_old_contents(&new);
        assert!(!new.join("stale").exists());
        assert!(!root.path().join("com.thothnotes.desktop.moving").exists());
        assert!(!old.exists());
        #[cfg(unix)]
        {
            assert!(new.join("mcp").is_dir() && !new.join("mcp").join("thoth.sock").exists());
            assert_eq!(std::fs::read_link(new.join("link")).unwrap(), Path::new("recent.json"));
        }
    }
}
