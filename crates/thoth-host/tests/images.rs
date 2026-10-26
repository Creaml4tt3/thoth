//! `image.pick` and `image.read` (ADR-0028): the page asks for an image to add, the host shows the picker, and the
//! page gets the file's name and, once, its bytes. It never learns the path, cannot name one, and gets nothing that
//! is not an image of at most 20 MB.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use thoth_host::{Browser, FileManager, Host, HostConfig, HostResult, MAX_IMAGE_BYTES, MemorySecretStore, Picker};

/// Answers the image picker with whatever the test sets.
#[derive(Default)]
struct ImagePicker(Mutex<Option<PathBuf>>);
impl Picker for ImagePicker {
    fn pick_vault(&self) -> Option<PathBuf> {
        None
    }
    fn pick_source(&self, _: bool) -> Option<PathBuf> {
        None
    }
    fn pick_image(&self) -> Option<PathBuf> {
        self.0.lock().unwrap().clone()
    }
}

struct Nothing;
impl Browser for Nothing {
    fn open(&self, _: &str) -> HostResult<()> {
        Ok(())
    }
}
impl FileManager for Nothing {
    fn reveal(&self, _: &Path) -> HostResult<()> {
        Ok(())
    }
}

fn host(picker: Arc<ImagePicker>) -> Host {
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

const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

#[test]
fn a_picked_image_gives_its_name_and_then_its_bytes_once() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("Bird photo.png");
    std::fs::write(&file, PNG).unwrap();
    let picker = Arc::new(ImagePicker::default());
    let host = host(picker.clone());

    // Cancelled: null.
    assert_eq!(host.call("image.pick", &json!({}), None).unwrap().0, Value::Null);

    *picker.0.lock().unwrap() = Some(file.clone());
    let picked = host.call("image.pick", &json!({}), None).unwrap().0;
    assert_eq!(picked["name"], "Bird photo.png");
    assert_eq!(picked["size"], PNG.len());
    assert!(picked.get("path").is_none());
    assert!(!picked.to_string().contains(&dir.path().to_string_lossy().into_owned()), "the path never reaches the page: {picked}");
    let handle = picked["image"].as_str().unwrap().to_owned();

    let (value, bytes) = host.call("image.read", &json!({ "image": handle }), None).unwrap();
    assert_eq!(value, Value::Null);
    assert_eq!(bytes.as_deref(), Some(PNG));
    // Once only, and never by a path or a made-up handle.
    assert_eq!(host.call("image.read", &json!({ "image": handle }), None).unwrap_err().code, "BAD_HANDLE");
    assert_eq!(host.call("image.read", &json!({ "image": file.to_string_lossy() }), None).unwrap_err().code, "BAD_HANDLE");
    assert_eq!(host.call("image.read", &json!({}), None).unwrap_err().code, "BAD_ARGUMENT");
    assert_eq!(host.call("image.pick", &json!({}), Some(b"x")).unwrap_err().code, "BAD_ARGUMENT");
}

#[test]
fn only_image_files_of_at_most_20_mb_can_be_picked() {
    let dir = tempfile::tempdir().unwrap();
    let picker = Arc::new(ImagePicker::default());
    let host = host(picker.clone());
    let pick = |path: PathBuf| {
        *picker.0.lock().unwrap() = Some(path);
        host.call("image.pick", &json!({}), None)
    };

    let page = dir.path().join("page.html");
    std::fs::write(&page, "<script>alert(1)</script>").unwrap();
    assert_eq!(pick(page).unwrap_err().code, "NOT_AN_IMAGE");

    let folder = dir.path().join("folder.png");
    std::fs::create_dir(&folder).unwrap();
    assert_eq!(pick(folder).unwrap_err().code, "NOT_A_REGULAR_FILE");

    let big = dir.path().join("big.jpg");
    std::fs::File::create(&big).unwrap().set_len(MAX_IMAGE_BYTES + 1).unwrap();
    assert_eq!(pick(big).unwrap_err().code, "TOO_LARGE");

    let max = dir.path().join("max.JPG");
    std::fs::File::create(&max).unwrap().set_len(MAX_IMAGE_BYTES).unwrap();
    assert_eq!(pick(max).unwrap().0["size"], MAX_IMAGE_BYTES);

    let svg = dir.path().join("drawing.svg");
    std::fs::write(&svg, "<svg/>").unwrap();
    assert_eq!(pick(svg).unwrap().0["name"], "drawing.svg");

    // A file that is gone by the time the picker answers: cancelled.
    assert_eq!(pick(dir.path().join("gone.png")).unwrap().0, Value::Null);
}

#[test]
fn a_picked_image_that_grew_past_the_cap_is_not_read() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("grows.png");
    std::fs::write(&file, PNG).unwrap();
    let picker = Arc::new(ImagePicker(Mutex::new(Some(file.clone()))));
    let host = host(picker);
    let handle = host.call("image.pick", &json!({}), None).unwrap().0["image"].as_str().unwrap().to_owned();
    std::fs::OpenOptions::new().write(true).open(&file).unwrap().set_len(MAX_IMAGE_BYTES + 1).unwrap();
    assert_eq!(host.call("image.read", &json!({ "image": handle }), None).unwrap_err().code, "TOO_LARGE");
}
