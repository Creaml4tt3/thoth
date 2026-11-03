//! The search index outside the notes folder (ADR-0046): one index per Private Space in the app's data folder, never
//! through a link; the index an older Thoth kept in `.thoth/` is deleted (not copied) when no other Thoth has it open,
//! and rebuilt in the new place.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thoth_host::index_home::{self, digest};
use thoth_host::sql::Sql;
use thoth_host::{Browser, FileManager, Host, HostConfig, HostResult, MemorySecretStore, Picker};

struct NoPicker;
impl Picker for NoPicker {
    fn pick_vault(&self) -> Option<PathBuf> {
        None
    }
    fn pick_source(&self, _: bool) -> Option<PathBuf> {
        None
    }
}

struct Nothing;
impl Browser for Nothing {
    fn open(&self, _: &str) -> HostResult<()> {
        Ok(())
    }
}
impl FileManager for Nothing {
    fn reveal(&self, _: &Path, _: Option<&Path>) -> HostResult<()> {
        Ok(())
    }
}

fn host(allow: &Path, data: Option<&Path>) -> Host {
    Host::new(HostConfig {
        data_dir: data.map(Path::to_owned),
        allow_roots: vec![allow.to_owned()],
        picker: Arc::new(NoPicker),
        events: Arc::new(|_, _| {}),
        disable_hardlink: false,
        secrets: Arc::new(MemorySecretStore::default()),
        browser: Arc::new(Nothing),
        file_manager: Arc::new(Nothing),
        agent_search_dirs: Some(Vec::new()),
        link_preview_loopback: false,
    })
}

fn canonical(p: &Path) -> PathBuf {
    thoth_host::paths::canonicalize_path(p).unwrap()
}

/// A folder of notes and an app data folder, both canonical (macOS temp folders are under a link).
fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let base = tempfile::tempdir().unwrap();
    let b = canonical(base.path());
    std::fs::create_dir_all(b.join("Notes")).unwrap();
    std::fs::create_dir_all(b.join("data")).unwrap();
    (base, b.join("Notes"), b.join("data"))
}

fn open(host: &Host, owner: &str, root: &Path) -> HostResult<Value> {
    host.call_as(owner, "vault.open", &json!({ "root": root.to_string_lossy() }), None).map(|r| r.0)
}

fn close(host: &Host, opened: &Value) {
    host.call("vault.close", &json!({ "vault": opened["vault"] }), None).unwrap();
}

fn sql(host: &Host, opened: &Value, text: &str) -> Value {
    host.call("sql.get", &json!({ "vault": opened["vault"], "sql": text }), None).unwrap().0
}

fn new_index(data: &Path, root: &Path) -> PathBuf {
    data.join(index_home::DIR).join(digest(root)).join(index_home::FILE)
}

/// What an older Thoth leaves: a WAL-mode index with its own rows in `.thoth/`.
fn old_index(root: &Path) -> PathBuf {
    std::fs::create_dir_all(root.join(".thoth")).unwrap();
    let path = root.join(".thoth/index.sqlite");
    let old = Sql::open(&path).unwrap();
    old.exec("CREATE TABLE left_by_old (x); INSERT INTO left_by_old VALUES (1);").unwrap();
    path
}

fn old_files(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root.join(".thoth"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("index.sqlite"))
        .collect();
    names.sort();
    names
}

#[test]
fn the_index_is_in_the_data_folder_one_per_private_space() {
    let (_base, notes, data) = fixture();
    let other = notes.with_file_name("Other");
    std::fs::create_dir(&other).unwrap();
    let host = host(notes.parent().unwrap(), Some(&data));
    let opened = open(&host, "main", &notes).unwrap();
    assert_eq!(opened["network"], false);
    host.call("sql.exec", &json!({ "vault": opened["vault"], "sql": "CREATE TABLE pages (x)" }), None).unwrap();
    assert!(new_index(&data, &notes).is_file());
    assert!(notes.join(".thoth").is_dir(), "the temp and journal areas stay next to the notes");
    assert!(old_files(&notes).is_empty(), "nothing of the index is in the notes folder");
    // Another Private Space has its own index.
    let second = open(&host, "main", &other).unwrap();
    assert_ne!(new_index(&data, &notes), new_index(&data, &other));
    assert!(new_index(&data, &other).is_file());
    assert_eq!(sql(&host, &second, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'pages'")["n"], 0.0);
    // A second window on the folder shares that index.
    let again = open(&host, "space-1", &notes).unwrap();
    assert_eq!(sql(&host, &again, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'pages'")["n"], 1.0);
}

#[test]
fn an_old_index_is_deleted_not_copied_and_the_new_one_starts_empty() {
    let (_base, notes, data) = fixture();
    old_index(&notes);
    // Left over from an older Thoth that did not close cleanly.
    std::fs::write(notes.join(".thoth/index.sqlite-wal"), "").unwrap();
    std::fs::write(notes.join(".thoth/index.sqlite-shm"), "").unwrap();
    std::fs::write(notes.join(".thoth/config.json"), "{}").unwrap();
    let host = host(notes.parent().unwrap(), Some(&data));
    let opened = open(&host, "main", &notes).unwrap();
    assert!(old_files(&notes).is_empty(), "{:?}", old_files(&notes));
    assert!(notes.join(".thoth/config.json").is_file(), "only the index files are deleted");
    assert!(new_index(&data, &notes).is_file());
    assert_eq!(sql(&host, &opened, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'left_by_old'")["n"], 0.0);
}

#[test]
fn an_old_index_another_thoth_has_open_is_kept_until_it_is_closed() {
    let (_base, notes, data) = fixture();
    let path = old_index(&notes);
    let older_thoth = Sql::open(&path).unwrap();
    let host = host(notes.parent().unwrap(), Some(&data));
    let opened = open(&host, "main", &notes).unwrap();
    assert!(path.is_file(), "an older Thoth has it open");
    older_thoth.exec("INSERT INTO left_by_old VALUES (2)").unwrap();
    drop(older_thoth);
    close(&host, &opened);
    open(&host, "main", &notes).unwrap();
    assert!(old_files(&notes).is_empty());
}

#[test]
fn an_old_index_is_left_while_another_window_has_the_folder_open() {
    let (_base, notes, data) = fixture();
    let host = host(notes.parent().unwrap(), Some(&data));
    let first = open(&host, "main", &notes).unwrap();
    // An older Thoth opened the folder meanwhile and made its own index again.
    let path = old_index(&notes);
    let second = open(&host, "space-1", &notes).unwrap();
    assert_eq!(second["shared"], true);
    assert!(path.is_file());
    close(&host, &first);
    close(&host, &second);
    open(&host, "main", &notes).unwrap();
    assert!(old_files(&notes).is_empty());
}

#[test]
fn a_host_without_a_data_folder_keeps_the_index_out_of_the_notes_folder_too() {
    let (_base, notes, _data) = fixture();
    let host = host(notes.parent().unwrap(), None);
    let first = open(&host, "main", &notes).unwrap();
    host.call("sql.exec", &json!({ "vault": first["vault"], "sql": "CREATE TABLE pages (x)" }), None).unwrap();
    assert!(old_files(&notes).is_empty());
    let second = open(&host, "space-1", &notes).unwrap();
    assert_eq!(sql(&host, &second, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'pages'")["n"], 1.0);
}

#[cfg(unix)]
#[test]
fn a_link_at_the_new_index_is_refused_and_an_old_one_is_removed_not_followed() {
    let (_base, notes, data) = fixture();
    let elsewhere = notes.with_file_name("elsewhere.sqlite");
    std::fs::write(&elsewhere, "").unwrap();
    let host = host(notes.parent().unwrap(), Some(&data));

    // The database file is a link: SQLite refuses it (SQLITE_OPEN_NOFOLLOW).
    let db = new_index(&data, &notes);
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &db).unwrap();
    assert_eq!(open(&host, "main", &notes).unwrap_err().code, "SQLITE_ERROR");
    std::fs::remove_file(&db).unwrap();
    // Its folder is a link.
    let folder = db.parent().unwrap();
    std::fs::remove_dir(folder).unwrap();
    std::fs::create_dir(notes.with_file_name("elsewhere")).unwrap();
    std::os::unix::fs::symlink(notes.with_file_name("elsewhere"), folder).unwrap();
    assert_eq!(open(&host, "main", &notes).unwrap_err().code, "UNAVAILABLE");
    assert_eq!(std::fs::read_dir(notes.with_file_name("elsewhere")).unwrap().count(), 0);
    std::fs::remove_file(folder).unwrap();

    // An old index that is a link is removed as a link; what it points at is left as it was.
    std::fs::create_dir_all(notes.join(".thoth")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, notes.join(".thoth/index.sqlite")).unwrap();
    open(&host, "main", &notes).unwrap();
    assert!(old_files(&notes).is_empty());
    assert_eq!(std::fs::read(&elsewhere).unwrap(), b"");
}

/// The index is a cache: a data folder that cannot hold it does not stop a Private Space from opening. The index then
/// lives in the host's temporary folder, still outside the notes folder, and two windows still share it.
#[cfg(unix)]
#[test]
fn a_data_folder_that_cannot_hold_the_index_falls_back_to_a_temporary_one() {
    use std::os::unix::fs::PermissionsExt;
    let (_base, notes, data) = fixture();
    // Read-only: `indexes/` cannot be made.
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o500)).unwrap();
    let host = host(notes.parent().unwrap(), Some(&data));
    let first = open(&host, "main", &notes).unwrap();
    host.call("sql.exec", &json!({ "vault": first["vault"], "sql": "CREATE TABLE pages (x)" }), None).unwrap();
    let second = open(&host, "space-1", &notes).unwrap();
    assert_eq!(sql(&host, &second, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'pages'")["n"], 1.0);
    assert!(old_files(&notes).is_empty());
    assert!(!data.join(index_home::DIR).exists());
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).unwrap();

    // Not a folder at all.
    let file = notes.with_file_name("data-file");
    std::fs::write(&file, "").unwrap();
    let host = self::host(notes.parent().unwrap(), Some(&file));
    open(&host, "main", &notes).unwrap();
    assert!(old_files(&notes).is_empty());
    assert_eq!(std::fs::read(&file).unwrap(), b"");
}
