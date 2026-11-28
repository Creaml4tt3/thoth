//! A Markdown file the system handed to Thoth (Open With, a Dock drop; ADR-0057): which files are accepted, and
//! whether one belongs to a Private Space Thoth knows or opens on its own.

use crate::error::{HostError, HostResult};
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};

/// The largest file accepted: far below the vault's write limit, at what the editor still handles.
pub const MAX_OPENED_BYTES: u64 = 16 * 1024 * 1024;

/// Where an opened file goes.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// Inside a Private Space Thoth opened before: that Space, and the file's `/`-separated path in it.
    Space { root: String, page: String },
    /// Anywhere else: a window for just this file.
    Loose(PathBuf),
}

/// The file's real path when it is an existing regular file named `.md` or `.markdown` (any case, after links are
/// followed) of at most `MAX_OPENED_BYTES`; else nothing.
pub fn check_opened(path: &Path) -> Option<PathBuf> {
    // The host's form of a path (on Windows without `\\?\`), so it compares with the recent Private Spaces.
    let real = crate::paths::canonicalize_path(path).ok()?;
    let ext = real.extension()?.to_str()?.to_ascii_lowercase();
    if ext != "md" && ext != "markdown" {
        return None;
    }
    let meta = std::fs::metadata(&real).ok()?;
    (meta.is_file() && meta.len() <= MAX_OPENED_BYTES).then_some(real)
}

/// The Private Space among `roots` (canonical paths) that holds `file`, by whole path parts; the deepest one wins.
pub fn route(file: &Path, roots: &[String]) -> Route {
    let best = roots
        .iter()
        .filter_map(|root| file.strip_prefix(root).ok().map(|rest| (root, rest)))
        .filter(|(_, rest)| !rest.as_os_str().is_empty())
        .max_by_key(|(root, _)| Path::new(root).components().count());
    match best {
        Some((root, rest)) => {
            let page = rest.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            Route::Space { root: root.clone(), page }
        }
        None => Route::Loose(file.to_path_buf()),
    }
}

/// A file the system handed to one window (`owner`): it reaches the file only through the token it was given.
pub struct Opened {
    pub owner: String,
    pub path: PathBuf,
}

/// The file's name, for messages: never its folder (the page does not learn where the file is).
fn name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The file itself, never a link or folder put in its place since it was opened.
fn regular(path: &Path) -> HostResult<std::fs::Metadata> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| HostError::io(&e, "stat", &name_of(path)))?;
    if !meta.is_file() {
        return Err(HostError::new("NOT_A_REGULAR_FILE", format!("Not a regular file: {}", name_of(path))));
    }
    Ok(meta)
}

/// `opened.stat`: the file's name, its folder's name (not the path), when it changed and its size.
pub fn stat(path: &Path) -> HostResult<Value> {
    let meta = regular(path)?;
    let folder = path.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(json!({ "name": name_of(path), "folder": folder, "mtimeMs": mtime, "size": meta.len() }))
}

/// `opened.read`: the file's bytes.
pub fn read(path: &Path) -> HostResult<Vec<u8>> {
    let meta = regular(path)?;
    if meta.len() > MAX_OPENED_BYTES {
        return Err(HostError::bad_argument(format!("{} is larger than Thoth opens", name_of(path))));
    }
    std::fs::read(path).map_err(|e| HostError::io(&e, "read", &name_of(path)))
}

/// Refuses a page larger than Thoth writes to an opened file.
fn fits(data: &[u8]) -> HostResult<()> {
    if data.len() as u64 > MAX_OPENED_BYTES {
        return Err(HostError::bad_argument("The page is larger than Thoth writes to an opened file"));
    }
    Ok(())
}

/// The file is no longer the version the window has.
fn changed(path: &Path) -> HostError {
    HostError::new("CONFLICT", format!("{} changed or was removed outside Thoth", name_of(path)))
}

/// `opened.write`: replaces the file with `data` when it is still the version `expected` (its sha256), through a
/// temporary file in the same folder and a rename, so a crash never leaves half a file. Returns the new hash.
/// The caller holds the host's replace lock, so two windows cannot both pass the check.
pub fn write(path: &Path, expected: &str, data: &[u8], digest: impl Fn(&[u8]) -> String) -> HostResult<String> {
    fits(data)?;
    let meta = match regular(path) {
        Ok(meta) => meta,
        Err(e) if e.code == "ENOENT" => return Err(changed(path)),
        Err(e) => return Err(e),
    };
    let current = digest(&std::fs::read(path).map_err(|e| HostError::io(&e, "read", &name_of(path)))?);
    if current != expected {
        return Err(changed(path));
    }
    // A file the person made read-only stays as it is, though replacing it would only need the folder's permission.
    if meta.permissions().readonly() {
        return Err(HostError::new("EACCES", format!("{} is read-only", name_of(path))));
    }
    let dir = path.parent().ok_or_else(|| HostError::internal("An opened file has no folder"))?;
    // A short name of fixed length, so a file with a long name can still be saved.
    let temp = dir.join(format!(".thoth-{}.tmp", &crate::handles::new_handle("w")?[2..14]));
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        f.write_all(data)?;
        // The replaced file keeps who may read it (a private note stays private).
        f.set_permissions(meta.permissions())?;
        f.sync_all()?;
        std::fs::rename(&temp, path)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(HostError::io(&e, "write", &name_of(path)));
    }
    Ok(digest(data))
}

/// A conflict copy's name: one plain file name ending `.md`, nothing that reaches another folder.
fn copy_name_ok(name: &str) -> bool {
    name.len() > 3 && name.len() <= 255 && name.ends_with(".md") && !name.starts_with('.') && !name.contains(['/', '\\', '\0'])
}

/// `opened.copy`: writes `data` as a new file `name` next to the opened file (Keep both), never over another.
pub fn copy(path: &Path, name: &str, data: &[u8]) -> HostResult<Value> {
    if !copy_name_ok(name) {
        return Err(HostError::bad_argument("A copy's name is one file name ending .md"));
    }
    fits(data)?;
    let dir = path.parent().ok_or_else(|| HostError::internal("An opened file has no folder"))?;
    let target = dir.join(name);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| HostError::io(&e, "open", name))?;
    f.write_all(data).and_then(|()| f.sync_all()).map_err(|e| HostError::io(&e, "write", name))?;
    Ok(json!({ "name": name }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn file(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, "# Hi\n").unwrap();
        p
    }

    #[test]
    fn check_accepts_md_and_markdown_any_case() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(check_opened(&file(d.path(), "a.md")), Some(crate::paths::canonicalize_path(&d.path().join("a.md")).unwrap()));
        assert!(check_opened(&file(d.path(), "b.MARKDOWN")).is_some());
    }

    #[test]
    fn check_refuses_other_extensions_and_folders() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(check_opened(&file(d.path(), "a.txt")), None);
        fs::create_dir(d.path().join("x.md")).unwrap();
        assert_eq!(check_opened(&d.path().join("x.md")), None);
        assert_eq!(check_opened(&d.path().join("missing.md")), None);
    }

    #[cfg(unix)]
    #[test]
    fn check_follows_symlink_then_checks_target() {
        let d = tempfile::tempdir().unwrap();
        let secret = file(d.path(), "secret.txt");
        std::os::unix::fs::symlink(&secret, d.path().join("link.md")).unwrap();
        assert_eq!(check_opened(&d.path().join("link.md")), None);
        let real = file(d.path(), "real.md");
        std::os::unix::fs::symlink(&real, d.path().join("ok.md")).unwrap();
        assert_eq!(check_opened(&d.path().join("ok.md")), Some(fs::canonicalize(&real).unwrap()));
    }

    #[test]
    fn check_refuses_files_over_16_mib() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("big.md");
        fs::File::create(&p).unwrap().set_len(MAX_OPENED_BYTES + 1).unwrap();
        assert_eq!(check_opened(&p), None);
    }

    #[test]
    fn route_picks_deepest_root_by_component() {
        let roots = vec!["/x/Notes".to_owned(), "/x/Notes/Work".to_owned()];
        assert_eq!(route(Path::new("/x/Notes/Work/a.md"), &roots), Route::Space { root: "/x/Notes/Work".into(), page: "a.md".into() });
        assert_eq!(route(Path::new("/x/Notes 2/a.md"), &roots), Route::Loose(PathBuf::from("/x/Notes 2/a.md")));
        assert_eq!(route(Path::new("/x/Notes/sub/b.md"), &roots), Route::Space { root: "/x/Notes".into(), page: "sub/b.md".into() });
    }
}
