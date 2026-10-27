//! `vault.reveal`: shows an open vault's folder in the file manager, or an entry in it selected. The webview names the
//! vault by its handle, so it can only ever reveal a folder the user opened, and an entry by a vault-relative path the
//! host checks itself: never a path it makes up, nothing outside the root, no symlink, nothing in `.thoth/`.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
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

struct NoBrowser;
impl Browser for NoBrowser {
    fn open(&self, _: &str) -> HostResult<()> {
        Ok(())
    }
}

/// Records what it was asked to reveal instead of launching anything: the root, and the entry when there is one.
#[derive(Default)]
struct Recorder(Mutex<Vec<(PathBuf, Option<PathBuf>)>>);
impl FileManager for Recorder {
    fn reveal(&self, root: &Path, entry: Option<&Path>) -> HostResult<()> {
        self.0.lock().unwrap().push((root.to_owned(), entry.map(Path::to_owned)));
        Ok(())
    }
}

fn host(allow: &Path, data: &Path, recorder: Arc<Recorder>) -> Host {
    Host::new(HostConfig {
        data_dir: Some(data.to_owned()),
        allow_roots: vec![allow.to_owned()],
        picker: Arc::new(NoPicker),
        events: Arc::new(|_, _| {}),
        disable_hardlink: false,
        secrets: Arc::new(MemorySecretStore::default()),
        browser: Arc::new(NoBrowser),
        file_manager: recorder,
        agent_search_dirs: None,
        link_preview_loopback: false,
    })
}

#[test]
fn reveals_only_the_root_of_an_open_vault_named_by_its_handle() {
    let base = tempfile::tempdir().unwrap();
    let vault = base.path().join("Notes");
    std::fs::create_dir(&vault).unwrap();
    let data = tempfile::tempdir().unwrap();
    let recorder = Arc::new(Recorder::default());
    let host = host(&vault, data.path(), recorder.clone());

    let opened = host.call("vault.open", &json!({ "root": vault.to_string_lossy() }), None).unwrap().0;
    let handle = opened["vault"].as_str().unwrap().to_owned();
    assert_eq!(host.call("vault.reveal", &json!({ "vault": handle }), None).unwrap().0, Value::Null);
    assert_eq!(*recorder.0.lock().unwrap(), vec![(thoth_host::paths::canonicalize_path(&vault).unwrap(), None)]);

    // A path, an unknown handle, a missing argument or request bytes reveal nothing.
    let refused = [
        json!({ "vault": vault.to_string_lossy() }),
        json!({ "vault": "vault_0000" }),
        json!({ "root": vault.to_string_lossy() }),
        json!({ "vault": 1 }),
    ];
    for args in refused {
        let code = host.call("vault.reveal", &args, None).unwrap_err().code;
        assert!(code == "BAD_HANDLE" || code == "BAD_ARGUMENT", "{args}: {code}");
    }
    assert_eq!(host.call("vault.reveal", &json!({ "vault": handle }), Some(b"x")).unwrap_err().code, "BAD_ARGUMENT");

    // A closed vault cannot be revealed.
    host.call("vault.close", &json!({ "vault": handle }), None).unwrap();
    assert_eq!(host.call("vault.reveal", &json!({ "vault": handle }), None).unwrap_err().code, "BAD_HANDLE");
    assert_eq!(recorder.0.lock().unwrap().len(), 1);
}

#[test]
fn reveals_a_file_or_folder_inside_the_vault_selected_and_nothing_else() {
    let base = tempfile::tempdir().unwrap();
    let vault = base.path().join("Notes");
    std::fs::create_dir_all(vault.join("Plans/Deep")).unwrap();
    std::fs::create_dir_all(vault.join(".thoth")).unwrap();
    std::fs::write(vault.join("Plans/Deep/Q3.md"), "# Q3\n").unwrap();
    std::fs::write(vault.join(".thoth/order.json"), "{}").unwrap();
    std::fs::write(base.path().join("Outside.md"), "# Outside\n").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(base.path().join("Outside.md"), vault.join("Link.md")).unwrap();
        std::os::unix::fs::symlink(base.path(), vault.join("LinkDir")).unwrap();
    }
    let data = tempfile::tempdir().unwrap();
    let recorder = Arc::new(Recorder::default());
    let host = host(&vault, data.path(), recorder.clone());
    let opened = host.call("vault.open", &json!({ "root": vault.to_string_lossy() }), None).unwrap().0;
    let handle = opened["vault"].as_str().unwrap().to_owned();
    let root = thoth_host::paths::canonicalize_path(&vault).unwrap();

    // A page and a folder go to the file manager as the entry, under the canonical root.
    for (path, entry) in [("Plans/Deep/Q3.md", root.join("Plans").join("Deep").join("Q3.md")), ("Plans", root.join("Plans"))] {
        assert_eq!(host.call("vault.reveal", &json!({ "vault": handle, "path": path }), None).unwrap().0, Value::Null, "{path}");
        assert_eq!(recorder.0.lock().unwrap().last().cloned(), Some((root.clone(), Some(entry))), "{path}");
    }
    // A null path is the root, as before.
    host.call("vault.reveal", &json!({ "vault": handle, "path": null }), None).unwrap();
    assert_eq!(recorder.0.lock().unwrap().last().cloned(), Some((root.clone(), None)));
    let shown = recorder.0.lock().unwrap().len();

    // Outside the root, a parent segment, an absolute path, a missing entry, the reserved folder, a symlink (to a file
    // or through a folder): refused, and nothing is launched.
    let mut refused = vec![
        ("../Outside.md", "UNSAFE_PATH"),
        ("Plans/../../Outside.md", "UNSAFE_PATH"),
        ("/etc/passwd", "UNSAFE_PATH"),
        ("", "UNSAFE_PATH"),
        ("Plans\\Deep", "UNSAFE_PATH"),
        ("Nope.md", "ENOENT"),
        (".thoth", "NOT_ALLOWED"),
        (".thoth/order.json", "NOT_ALLOWED"),
        (".THOTH/order.json", "NOT_ALLOWED"),
    ];
    if cfg!(unix) {
        refused.push(("Link.md", "UNSAFE_PATH"));
        refused.push(("LinkDir/Outside.md", "UNSAFE_PATH"));
    }
    for (path, code) in refused {
        let error = host.call("vault.reveal", &json!({ "vault": handle, "path": path }), None).unwrap_err();
        assert_eq!(error.code, code, "{path}: {}", error.message);
    }
    assert_eq!(host.call("vault.reveal", &json!({ "vault": handle, "path": 7 }), None).unwrap_err().code, "BAD_ARGUMENT");
    assert_eq!(recorder.0.lock().unwrap().len(), shown);
}
