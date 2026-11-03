//! Where a Private Space's search index lives (ADR-0046): in the app's data folder on this computer, never in the
//! notes folder. One folder per Private Space root, `<data>/indexes/<digest>/index.sqlite` (with SQLite's `-wal` and
//! `-shm` next to it), where `<digest>` is the SHA-256 of the canonical root path. The notes folder may be a network
//! share or a synced folder: SQLite over a network file system can corrupt, and a sync tool copies the changing index
//! to every computer.
//!
//! A host without a data folder (a test harness) keeps its indexes in a temporary folder of its own, removed when the
//! host ends.
use crate::error::{HostError, HostResult};
use crate::mcp::private_dir;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The folder under the data folder that holds one folder per Private Space.
pub const DIR: &str = "indexes";
/// The database file, in its Private Space's folder (and, before ADR-0046, in `.thoth/`).
pub const FILE: &str = "index.sqlite";
/// The database and the files SQLite keeps next to it.
pub const FILES: [&str; 4] = ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm", "index.sqlite-journal"];

/// The name of `root`'s folder: hex SHA-256 of the canonical root path's bytes. Stable for a root, and says nothing
/// readable about it.
pub fn digest(root: &Path) -> String {
    Sha256::digest(root.as_os_str().as_encoded_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The index database of `root` under `base` (a canonical folder: no links in it). Makes `indexes/` and the root's
/// folder owner-only and refuses either if it is a link. SQLite then refuses a link at the database files themselves
/// (`SQLITE_OPEN_NOFOLLOW`); on Windows, where SQLite ignores that flag, this checks them too.
pub fn database(base: &Path, root: &Path) -> HostResult<PathBuf> {
    let indexes = base.join(DIR);
    private_dir(&indexes)?;
    let dir = indexes.join(digest(root));
    private_dir(&dir)?;
    #[cfg(windows)]
    refuse_links(&indexes, &dir)?;
    Ok(dir.join(FILE))
}

/// `base` made and in canonical form, so the path SQLite opens has no link in it that `SQLITE_OPEN_NOFOLLOW` would
/// refuse (the user's own data folder may be reached through one).
pub fn canonical_base(base: &Path) -> HostResult<PathBuf> {
    std::fs::create_dir_all(base).map_err(|e| HostError::io(&e, "mkdir", &base.to_string_lossy()))?;
    crate::paths::canonicalize_path(base).map_err(|e| HostError::io(&e, "open", &base.to_string_lossy()))
}

#[cfg(windows)]
fn refuse_links(indexes: &Path, dir: &Path) -> HostResult<()> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let linked = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0);
    if linked(indexes) || linked(dir) {
        return Err(HostError::new("UNAVAILABLE", format!("{} is not a folder of this user", dir.display())));
    }
    if let Some(name) = FILES.iter().find(|f| linked(&dir.join(f))) {
        return Err(HostError::new("SQLITE_ERROR", format!("The index database {name} is a symlink")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_folder_per_root_named_by_a_digest() {
        let a = digest(Path::new("/Users/a/Notes"));
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(a, digest(Path::new("/Users/a/Notes")));
        assert_ne!(a, digest(Path::new("/Users/a/Notes2")));
        assert!(!a.contains("Notes"));
    }

    #[test]
    fn the_database_is_under_the_base_and_its_folders_are_owner_only() {
        let data = tempfile::tempdir().unwrap();
        let base = canonical_base(&data.path().join("app")).unwrap();
        let db = database(&base, Path::new("/Users/a/Notes")).unwrap();
        assert_eq!(db, base.join(DIR).join(digest(Path::new("/Users/a/Notes"))).join(FILE));
        assert!(db.parent().unwrap().is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for dir in [db.parent().unwrap(), &base.join(DIR)] {
                assert_eq!(std::fs::metadata(dir).unwrap().permissions().mode() & 0o777, 0o700);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_is_a_link_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let base = canonical_base(data.path()).unwrap();
        let elsewhere = base.join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, base.join(DIR)).unwrap();
        assert_eq!(database(&base, Path::new("/n")).unwrap_err().code, "UNAVAILABLE");
        std::fs::remove_file(base.join(DIR)).unwrap();
        std::fs::create_dir(base.join(DIR)).unwrap();
        std::os::unix::fs::symlink(&elsewhere, base.join(DIR).join(digest(Path::new("/n")))).unwrap();
        assert_eq!(database(&base, Path::new("/n")).unwrap_err().code, "UNAVAILABLE");
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
    }
}
