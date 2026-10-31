//! Several desktop windows on one host (ADR-0019): each window is an owner of the vaults it opens and the agent runs
//! it starts. A second window on a folder is told the folder is shared, a closed window takes its own handles and
//! runs with it, and a compare-and-rename lets two windows save one page without losing a write.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
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

fn host(allow: &Path, data: &Path) -> Host {
    Host::new(HostConfig {
        data_dir: Some(data.to_owned()),
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

fn open(host: &Host, owner: &str, root: &Path) -> Value {
    host.call_as(owner, "vault.open", &json!({ "root": root.to_string_lossy() }), None).unwrap().0
}

fn hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn a_second_window_on_a_folder_is_told_it_is_shared() {
    let base = tempfile::tempdir().unwrap();
    let (notes, other) = (base.path().join("Notes"), base.path().join("Other"));
    std::fs::create_dir(&notes).unwrap();
    std::fs::create_dir(&other).unwrap();
    let data = tempfile::tempdir().unwrap();
    let host = host(base.path(), data.path());

    let first = open(&host, "main", &notes);
    assert_eq!(first["shared"], false);
    let second = open(&host, "space-1", &notes);
    assert_eq!(second["shared"], true);
    assert_ne!(first["vault"], second["vault"], "each window has its own handle (its own index connection and watcher)");
    assert_eq!(open(&host, "space-1", &other)["shared"], false);

    // Once the first window's handle is gone, the next window to open the folder is the only one again.
    host.call("vault.close", &json!({ "vault": first["vault"] }), None).unwrap();
    host.call("vault.close", &json!({ "vault": second["vault"] }), None).unwrap();
    assert_eq!(open(&host, "space-2", &notes)["shared"], false);
}

#[test]
fn shared_means_another_window_not_another_handle_of_the_same_window() {
    let base = tempfile::tempdir().unwrap();
    let notes = base.path().join("Notes");
    std::fs::create_dir(&notes).unwrap();
    let data = tempfile::tempdir().unwrap();
    let host = host(base.path(), data.path());
    let shared = |vault: &Value| host.call("vault.shared", &json!({ "vault": vault }), None).unwrap().0;

    let old = open(&host, "main", &notes);
    // The main window reloads: its old page's handle may still be open, but no other window is.
    let reloaded = open(&host, "main", &notes);
    assert_eq!(reloaded["shared"], false);
    assert_eq!(shared(&reloaded["vault"]), false);
    assert_eq!(shared(&old["vault"]), false);

    let other = open(&host, "space-1", &notes);
    assert_eq!(other["shared"], true);
    assert_eq!(shared(&reloaded["vault"]), true);
    assert_eq!(shared(&other["vault"]), true);

    host.release("space-1");
    assert_eq!(shared(&reloaded["vault"]), false, "the other window closed: this one is the only one again");
}

#[test]
fn a_closed_window_takes_its_own_vaults_and_agent_runs_with_it() {
    let base = tempfile::tempdir().unwrap();
    let notes = base.path().join("Notes");
    std::fs::create_dir(&notes).unwrap();
    std::fs::write(notes.join("Plan.md"), "# Plan\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let host = host(base.path(), data.path());

    let mine = open(&host, "space-1", &notes)["vault"].clone();
    let theirs = open(&host, "main", &notes)["vault"].clone();
    let my_run = host.call_as("space-1", "agent.run.create", &json!({ "provider": "claude" }), None).unwrap().0;
    let their_run = host.call_as("main", "agent.run.create", &json!({ "provider": "claude" }), None).unwrap().0;
    let my_dir = PathBuf::from(my_run["dir"].as_str().unwrap()).parent().unwrap().to_owned();
    assert!(my_dir.is_dir());

    host.release("space-1");

    let gone = host.call("fs.stat", &json!({ "vault": mine, "path": "Plan.md" }), None).unwrap_err();
    assert_eq!(gone.code, "BAD_HANDLE");
    assert!(host.call("fs.stat", &json!({ "vault": theirs, "path": "Plan.md" }), None).is_ok(), "the other window's vault stays open");
    assert_eq!(host.call("agent.fs.list", &json!({ "run": my_run["run"], "dir": "" }), None).unwrap_err().code, "BAD_HANDLE");
    assert!(!my_dir.exists(), "the closed window's run folder is deleted");
    assert!(host.call("agent.fs.list", &json!({ "run": their_run["run"], "dir": "" }), None).is_ok(), "the other window's run goes on");
    // A window that never opened anything closes without touching anyone's.
    host.release("space-9");
    assert!(host.call("fs.stat", &json!({ "vault": theirs, "path": "Plan.md" }), None).is_ok());
}

#[test]
fn a_reloaded_page_lets_go_of_what_the_old_page_held_and_keeps_what_it_opens_next() {
    let base = tempfile::tempdir().unwrap();
    let notes = base.path().join("Notes");
    std::fs::create_dir(&notes).unwrap();
    std::fs::write(notes.join("Plan.md"), "# Plan\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let host = host(base.path(), data.path());

    let old = open(&host, "main", &notes)["vault"].clone();
    let old_run = host.call_as("main", "agent.run.create", &json!({ "provider": "claude" }), None).unwrap().0;
    let old_dir = PathBuf::from(old_run["dir"].as_str().unwrap()).parent().unwrap().to_owned();

    // The page starts loading again: the old page's handles stop working at once (the shell ends the rest off the
    // event loop), so the new page's own handle, opened meanwhile, is never caught up in it.
    let detached = host.detach("main");
    assert_eq!(host.call("fs.stat", &json!({ "vault": old, "path": "Plan.md" }), None).unwrap_err().code, "BAD_HANDLE");
    assert_eq!(host.call("agent.fs.list", &json!({ "run": old_run["run"], "dir": "" }), None).unwrap_err().code, "BAD_HANDLE");
    let new = open(&host, "main", &notes);
    assert_eq!(new["shared"], false);
    detached.end();
    assert!(!old_dir.exists(), "the old page's run folder is deleted");
    assert!(host.call("fs.stat", &json!({ "vault": new["vault"], "path": "Plan.md" }), None).is_ok());
}

#[test]
fn rename_with_replace_hash_replaces_only_the_expected_bytes() {
    let base = tempfile::tempdir().unwrap();
    let notes = base.path().join("Notes");
    std::fs::create_dir(&notes).unwrap();
    std::fs::write(notes.join("Plan.md"), "# Plan\n\nFrom A.\n").unwrap();
    let data = tempfile::tempdir().unwrap();
    let host = host(base.path(), data.path());
    let vault = open(&host, "main", &notes)["vault"].clone();
    let write = |path: &str, text: &str| host.call("fs.write", &json!({ "vault": vault, "path": path, "exclusive": false }), Some(text.as_bytes())).unwrap();
    let rename = |from: &str, to: &str, hash: &str| {
        host.call("fs.rename", &json!({ "vault": vault, "from": from, "to": to, "noReplace": false, "replaceHash": hash }), None)
    };

    write("b.tmp", "# Plan\n\nFrom B.\n");
    // B expected the version before A's save: refused, and nothing moved.
    let stale = rename("b.tmp", "Plan.md", &hex(b"# Plan\n\nFirst draft.\n")).unwrap_err();
    assert_eq!(stale.code, "CONFLICT");
    assert_eq!(std::fs::read_to_string(notes.join("Plan.md")).unwrap(), "# Plan\n\nFrom A.\n");
    assert!(notes.join("b.tmp").exists());
    // With the version that is there, it replaces it.
    rename("b.tmp", "Plan.md", &hex(b"# Plan\n\nFrom A.\n")).unwrap();
    assert_eq!(std::fs::read_to_string(notes.join("Plan.md")).unwrap(), "# Plan\n\nFrom B.\n");
    // A page that is gone has no expected bytes any more.
    write("c.tmp", "C");
    assert_eq!(rename("c.tmp", "Gone.md", &hex(b"anything")).unwrap_err().code, "CONFLICT");
    assert_eq!(
        host.call("fs.rename", &json!({ "vault": vault, "from": "c.tmp", "to": "Plan.md", "noReplace": false, "replaceHash": 7 }), None).unwrap_err().code,
        "BAD_ARGUMENT"
    );
}
