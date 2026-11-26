//! A Markdown file the system handed to Thoth (Open With, a Dock drop; ADR-0057): which files are accepted, and
//! whether one belongs to a Private Space Thoth knows or opens on its own.

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
    let real = std::fs::canonicalize(path).ok()?;
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
        assert_eq!(check_opened(&file(d.path(), "a.md")), Some(fs::canonicalize(d.path().join("a.md")).unwrap()));
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
