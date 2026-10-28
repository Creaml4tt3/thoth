//! `file.save` (Download as Markdown): the webview sends a suggested name and the bytes; the host shows "Save as" and
//! writes only where the person chose. The webview never names a path, and a cancelled dialog writes nothing.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use thoth_host::{Browser, FileManager, Host, HostConfig, HostResult, MemorySecretStore, Picker};

/// Answers "Save as" with a file in the folder the test sets, and records the suggested name.
#[derive(Default)]
struct SavePicker {
    folder: Mutex<Option<PathBuf>>,
    asked: Mutex<Vec<String>>,
}
impl Picker for SavePicker {
    fn pick_vault(&self) -> Option<PathBuf> {
        None
    }
    fn pick_source(&self, _: bool) -> Option<PathBuf> {
        None
    }
    fn pick_save(&self, name: &str) -> Option<PathBuf> {
        self.asked.lock().unwrap().push(name.to_owned());
        self.folder.lock().unwrap().as_ref().map(|dir| dir.join(name))
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

fn host(picker: Arc<SavePicker>) -> Host {
    Host::new(HostConfig {
        data_dir: None,
        allow_roots: vec![],
        picker,
        events: Arc::new(|_, _| {}),
        disable_hardlink: false,
        secrets: Arc::new(MemorySecretStore::default()),
        browser: Arc::new(Nothing),
        file_manager: Arc::new(Nothing),
        agent_search_dirs: None,
        link_preview_loopback: false,
    })
}

#[test]
fn saves_the_bytes_where_the_person_chose_under_a_clean_name() {
    let dir = tempfile::tempdir().unwrap();
    let picker = Arc::new(SavePicker::default());
    *picker.folder.lock().unwrap() = Some(dir.path().to_owned());
    let host = host(picker.clone());

    let saved = host.call("file.save", &json!({ "name": "../Plan: Q3" }), Some(b"# Plan\n")).unwrap().0;
    assert_eq!(saved, Value::Bool(true));
    assert_eq!(*picker.asked.lock().unwrap(), vec!["Plan  Q3.md".to_owned()]);
    assert_eq!(std::fs::read(dir.path().join("Plan  Q3.md")).unwrap(), b"# Plan\n");
}

#[test]
fn a_cancelled_dialog_writes_nothing_and_bytes_are_required() {
    let dir = tempfile::tempdir().unwrap();
    let picker = Arc::new(SavePicker::default());
    let host = host(picker.clone());
    assert_eq!(host.call("file.save", &json!({ "name": "Plan" }), Some(b"x")).unwrap().0, Value::Bool(false));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    assert_eq!(host.call("file.save", &json!({ "name": "Plan" }), None).unwrap_err().code, "BAD_ARGUMENT");
    assert_eq!(host.call("file.save", &json!({}), Some(b"x")).unwrap_err().code, "BAD_ARGUMENT");
    assert_eq!(picker.asked.lock().unwrap().len(), 1);
}
