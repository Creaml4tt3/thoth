//! Baseline for the 0.3.0 logging work: how long `fs.write` of a 20 KB page takes. Run on its own, in release:
//! `cargo test --release -p thoth-host --test save_latency -- --ignored --nocapture`
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
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

#[test]
#[ignore = "a measurement, not a check: run it by hand"]
fn save_latency_median() {
    let base = tempfile::tempdir().unwrap();
    let notes = base.path().join("Notes");
    std::fs::create_dir(&notes).unwrap();
    let data = tempfile::tempdir().unwrap();
    let host = Host::new(HostConfig {
        data_dir: Some(data.path().to_owned()),
        allow_roots: vec![base.path().to_owned()],
        picker: Arc::new(NoPicker),
        events: Arc::new(|_, _| {}),
        disable_hardlink: false,
        secrets: Arc::new(MemorySecretStore::default()),
        browser: Arc::new(Nothing),
        file_manager: Arc::new(Nothing),
        agent_search_dirs: Some(Vec::new()),
        link_preview_loopback: false,
    });
    let vault = host.call_as("main", "vault.open", &json!({ "root": notes.to_string_lossy() }), None).unwrap().0["vault"].clone();
    let bytes = vec![b'a'; 20 * 1024];
    let mut micros: Vec<u128> = (0..1000)
        .map(|_| {
            let start = Instant::now();
            host.call("fs.write", &json!({ "vault": vault, "path": "Page.md", "exclusive": false }), Some(&bytes)).unwrap();
            start.elapsed().as_micros()
        })
        .collect();
    micros.sort_unstable();
    println!("save_median {} us", micros[micros.len() / 2]);
    println!("save_p95 {} us", micros[micros.len() * 95 / 100]);
}
