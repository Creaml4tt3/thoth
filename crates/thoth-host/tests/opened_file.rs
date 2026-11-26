//! A Markdown file the system handed over (ADR-0057): the window it was given to reads and writes it through a token,
//! never a path; another window cannot; a stale write is refused; a closed window's token is gone.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thoth_host::{Browser, FileManager, Host, HostConfig, HostResult, MemorySecretStore, Picker};

struct Nothing;
impl Picker for Nothing {
    fn pick_vault(&self) -> Option<PathBuf> {
        None
    }
    fn pick_source(&self, _: bool) -> Option<PathBuf> {
        None
    }
}
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

fn host() -> Host {
    Host::new(HostConfig {
        data_dir: None,
        allow_roots: vec![],
        picker: Arc::new(Nothing),
        events: Arc::new(|_, _| {}),
        disable_hardlink: false,
        secrets: Arc::new(MemorySecretStore::default()),
        browser: Arc::new(Nothing),
        file_manager: Arc::new(Nothing),
        agent_search_dirs: None,
        link_preview_loopback: false,
    })
}

fn sha(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn setup() -> (tempfile::TempDir, PathBuf, Host, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(dir.path()).unwrap().join("Note.md");
    std::fs::write(&path, b"# Hello\n").unwrap();
    let host = host();
    let token = host.grant_file("file-a", path.clone());
    (dir, path, host, token)
}

fn code(result: HostResult<(Value, Option<Vec<u8>>)>) -> &'static str {
    result.err().expect("expected an error").code
}

fn leftovers(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.contains("thoth-tmp")).collect()
}

#[test]
fn opened_read_and_stat_for_owner_only() {
    let (dir, _path, host, token) = setup();
    let (_, bytes) = host.call_as("file-a", "opened.read", &json!({ "token": token }), None).unwrap();
    assert_eq!(bytes.unwrap(), b"# Hello\n");
    assert_eq!(code(host.call_as("file-b", "opened.read", &json!({ "token": token }), None)), "NOT_ALLOWED");
    let (stat, _) = host.call_as("file-a", "opened.stat", &json!({ "token": token }), None).unwrap();
    assert_eq!(stat["name"], "Note.md");
    let folder = std::fs::canonicalize(dir.path()).unwrap();
    assert_eq!(stat["folder"], folder.file_name().unwrap().to_string_lossy().as_ref());
    assert!(!stat.to_string().contains(&*folder.to_string_lossy()), "stat must not carry the path");
    assert_eq!(stat["size"], 8);
}

#[test]
fn write_refuses_stale_hash() {
    let (dir, path, host, token) = setup();
    let old = sha(b"# Hello\n");
    let (answer, _) = host.call_as("file-a", "opened.write", &json!({ "token": token, "expectedHash": old }), Some(b"# Changed\n")).unwrap();
    assert_eq!(answer["hash"], sha(b"# Changed\n"));
    assert_eq!(std::fs::read(&path).unwrap(), b"# Changed\n");
    assert_eq!(code(host.call_as("file-a", "opened.write", &json!({ "token": token, "expectedHash": old }), Some(b"x"))), "CONFLICT");
    assert_eq!(std::fs::read(&path).unwrap(), b"# Changed\n");
    std::fs::remove_file(&path).unwrap();
    assert_eq!(code(host.call_as("file-a", "opened.write", &json!({ "token": token, "expectedHash": sha(b"# Changed\n") }), Some(b"x"))), "CONFLICT");
    assert!(!path.exists(), "a deleted file is not written back");
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
fn copy_is_exclusive_and_one_segment() {
    let (dir, _path, host, token) = setup();
    let copy = |name: &str| host.call_as("file-a", "opened.copy", &json!({ "token": token, "name": name }), Some(b"mine"));
    let (answer, _) = copy("Note (conflict).md").unwrap();
    assert_eq!(answer["name"], "Note (conflict).md");
    assert_eq!(std::fs::read(dir.path().join("Note (conflict).md")).unwrap(), b"mine");
    assert_eq!(code(copy("Note (conflict).md")), "EEXIST");
    for bad in ["../x.md", "x.txt", "a/b.md", "a\\b.md", ".md", ""] {
        assert_eq!(code(copy(bad)), "BAD_ARGUMENT", "{bad}");
    }
}

#[test]
fn release_drops_tokens() {
    let (_dir, path, host, token) = setup();
    assert_eq!(host.file_owner(&path).as_deref(), Some("file-a"));
    host.release("file-a");
    assert_eq!(code(host.call_as("file-a", "opened.read", &json!({ "token": token }), None)), "NOT_ALLOWED");
    assert_eq!(host.file_owner(&path), None);
}

#[test]
fn take_file_hands_over_once() {
    let (_dir, path, host, token) = setup();
    assert_eq!(host.take_file("file-b", &token), None);
    assert_eq!(host.take_file("file-a", &token), Some(path));
    assert_eq!(host.take_file("file-a", &token), None);
}
