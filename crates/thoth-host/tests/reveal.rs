//! `vault.reveal`: shows an open vault's folder in the file manager. The webview names the vault by its handle,
//! so it can only ever reveal a folder the user opened, and never a path it makes up.
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

/// Records what it was asked to reveal instead of launching anything.
#[derive(Default)]
struct Recorder(Mutex<Vec<PathBuf>>);
impl FileManager for Recorder {
    fn reveal(&self, root: &Path) -> HostResult<()> {
        self.0.lock().unwrap().push(root.to_owned());
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
    assert_eq!(*recorder.0.lock().unwrap(), vec![thoth_host::paths::canonicalize_path(&vault).unwrap()]);

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
