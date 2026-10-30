//! `diag.report` and `diag.collect` (0.3.0): the webview's errors into the local log, capped, and the redacted log back.
use log::{LevelFilter, Log, Metadata, Record};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Once};
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

/// Counts the records aimed at `webview`. `log::set_logger` works once per process, so one is shared.
struct Counter(AtomicUsize);
impl Log for Counter {
    fn enabled(&self, _: &Metadata) -> bool {
        true
    }
    fn log(&self, record: &Record) {
        if record.target() == "webview" {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn flush(&self) {}
}
static COUNTER: Counter = Counter(AtomicUsize::new(0));
static SERIAL: Mutex<()> = Mutex::new(());

/// Installs the shared logger and returns a guard that keeps other logger-using tests out while the count is read.
fn logging() -> MutexGuard<'static, ()> {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        log::set_logger(&COUNTER).unwrap();
        log::set_max_level(LevelFilter::Trace);
    });
    SERIAL.lock().unwrap_or_else(|p| p.into_inner())
}

fn collect(host: &Host) -> Value {
    host.call("diag.collect", &json!({}), None).unwrap().0
}

#[test]
fn collect_without_log_dir_is_empty() {
    let bundle = collect(&host());
    assert_eq!(bundle["log"], json!([]));
    assert_eq!(bundle["arch"], std::env::consts::ARCH);
    assert_eq!(bundle["os"], std::env::consts::OS);
    assert_eq!(bundle["version"], "");
}

#[test]
fn collect_has_the_running_version() {
    let host = host().with_updates(thoth_host::updates::UpdateOptions::new("1.2.3", ""));
    assert_eq!(collect(&host)["version"], "1.2.3");
}

#[test]
fn collect_reads_and_redacts() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("thoth.log"), "failed to open /Users/a/My Notes/Secret plan.md: denied\n").unwrap();
    let host = host().with_log_dir(Some(dir.path().to_owned()));
    assert_eq!(collect(&host)["log"], json!(["failed to open <path>: denied"]));
    // A folder that is not there is no log, not a failure.
    let host = self::host().with_log_dir(Some(dir.path().join("missing")));
    assert_eq!(collect(&host)["log"], json!([]));
}

#[test]
fn report_refuses_bad_arguments() {
    let host = host();
    for args in [
        json!({ "kind": "x", "message": "m" }),
        json!({ "message": "m" }),
        json!({ "kind": "error" }),
        json!({ "kind": "error", "message": 1 }),
        json!({ "kind": "error", "message": "m", "stack": 1 }),
    ] {
        assert_eq!(host.call("diag.report", &args, None).unwrap_err().code, "BAD_ARGUMENT", "{args}");
    }
}

#[test]
fn report_caps_at_50() {
    let _serial = logging();
    let host = host();
    let before = COUNTER.0.load(Ordering::SeqCst);
    let args = json!({ "kind": "rejection", "message": "boom", "stack": "a\nb\nc\nd\ne\nf\ng" });
    for _ in 0..60 {
        assert_eq!(host.call("diag.report", &args, None).unwrap().0, Value::Null);
    }
    assert_eq!(COUNTER.0.load(Ordering::SeqCst) - before, 50);
}
