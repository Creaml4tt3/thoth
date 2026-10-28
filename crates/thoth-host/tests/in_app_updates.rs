//! In-app updates (ADR-0034) through the host's commands, with a scripted updater in place of the Tauri updater plugin
//! (the desktop shell's `PluginInstaller` is the real one): `update.install` downloads, checks and installs only when
//! the person asked, with progress as `update.progress` events; `update.cancel`; the failures the popup tells apart;
//! `update.restart` refused unless the update is ready, and held back while an assistant run is going.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use thoth_host::install::{Failure, Fetched, ScriptedInstaller};
use thoth_host::updates::UpdateOptions;
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
struct NoFiles;
impl FileManager for NoFiles {
    fn reveal(&self, _: &Path, _: Option<&Path>) -> HostResult<()> {
        Ok(())
    }
}

type Events = Arc<Mutex<Vec<(String, Value)>>>;

struct Fixture {
    host: Host,
    events: Events,
    installer: Arc<ScriptedInstaller>,
    data: tempfile::TempDir,
    _vault: tempfile::TempDir,
}

fn fake_claude() -> PathBuf {
    thoth_host::paths::canonicalize_path(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/agent-claude/test/fake-claude")).unwrap()
}

fn fixture_in(data: tempfile::TempDir, installer: ScriptedInstaller) -> Fixture {
    let vault = tempfile::tempdir().unwrap();
    let events: Events = Arc::default();
    let sink = events.clone();
    let installer = Arc::new(installer);
    let host = Host::new(HostConfig {
        data_dir: Some(data.path().to_owned()),
        allow_roots: vec![vault.path().to_owned()],
        picker: Arc::new(NoPicker),
        events: Arc::new(move |event, payload| sink.lock().unwrap().push((event.to_owned(), payload))),
        disable_hardlink: false,
        secrets: Arc::new(MemorySecretStore::default()),
        browser: Arc::new(NoBrowser),
        file_manager: Arc::new(NoFiles),
        agent_search_dirs: Some(vec![fake_claude()]),
        link_preview_loopback: false,
    })
    .with_updates(UpdateOptions { installer: installer.clone(), ..UpdateOptions::new("0.2.3", "https://download.thothnotes.com/latest.json") });
    Fixture { host, events, installer, data, _vault: vault }
}

fn fixture(installer: ScriptedInstaller) -> Fixture {
    fixture_in(tempfile::tempdir().unwrap(), installer)
}

fn call(f: &Fixture, command: &str, args: Value) -> Value {
    f.host.call(command, &args, None).unwrap_or_else(|e| panic!("{command}: {e}")).0
}

fn refused(f: &Fixture, command: &str, args: Value) -> &'static str {
    f.host.call(command, &args, None).unwrap_err().code
}

/// Waits for `update.status` to leave `downloading`, and returns it.
fn settled(f: &Fixture) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = call(f, "update.status", json!({}));
        if status["phase"] != "downloading" {
            return status;
        }
        assert!(Instant::now() < deadline, "still downloading: {status}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn progress(f: &Fixture) -> Vec<Value> {
    f.events.lock().unwrap().iter().filter(|(e, _)| e == "update.progress").map(|(_, p)| p.clone()).collect()
}

const VERSION: &str = "0.2.4";

fn works() -> ScriptedInstaller {
    ScriptedInstaller::new(Ok(Fetched { version: VERSION.into(), installed: true }))
}

#[test]
fn a_copy_that_cannot_update_itself_keeps_the_notice_only() {
    // The shell's default (a .deb install, a build run from the source tree, a host without the shell): no installer.
    let f = fixture(ScriptedInstaller::unsupported());
    let settings = call(&f, "update.settings", json!({}));
    assert_eq!(settings["canInstall"], false);
    assert_eq!(refused(&f, "update.install", json!({})), "NOT_ALLOWED");
    assert_eq!(call(&f, "update.status", json!({})), json!({ "phase": "idle" }));
    assert_eq!(f.installer.fetches(), 0);
    // A host made without `with_updates` has none of it either.
    let plain = Host::new(HostConfig {
        data_dir: None,
        allow_roots: vec![],
        picker: Arc::new(NoPicker),
        events: Arc::new(|_, _| {}),
        disable_hardlink: false,
        secrets: Arc::new(MemorySecretStore::default()),
        browser: Arc::new(NoBrowser),
        file_manager: Arc::new(NoFiles),
        agent_search_dirs: None,
        link_preview_loopback: false,
    });
    assert_eq!(plain.call("update.settings", &json!({}), None).unwrap().0["canInstall"], false);
    assert_eq!(plain.call("update.install", &json!({}), None).unwrap_err().code, "NOT_ALLOWED");
}

#[test]
fn the_switch_is_on_by_default_kept_by_the_host_and_off_means_no_download() {
    let f = fixture(works());
    let settings = call(&f, "update.settings", json!({}));
    assert_eq!((settings["canInstall"].clone(), settings["install"].clone()), (json!(true), json!(true)));
    assert_eq!(call(&f, "update.settings", json!({ "install": false }))["install"], false);
    assert_eq!(refused(&f, "update.settings", json!({ "install": "no" })), "BAD_ARGUMENT");
    assert_eq!(refused(&f, "update.install", json!({})), "NOT_ALLOWED");
    assert_eq!(f.installer.fetches(), 0);
    // Kept across a restart of the app, next to the notice's own choice.
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(f.data.path().join("update.json")).unwrap()).unwrap();
    assert_eq!(kept["install"], false);
    let again = fixture_in(f.data, works());
    assert_eq!(call(&again, "update.settings", json!({}))["install"], false);

    // The notice turned off means no request at all, the download included.
    let g = fixture(works());
    call(&g, "update.settings", json!({ "notify": false }));
    assert_eq!(refused(&g, "update.install", json!({})), "NOT_ALLOWED");
    assert_eq!(g.installer.fetches(), 0);
}

#[test]
fn update_downloads_with_progress_then_waits_for_restart() {
    let f = fixture(works().chunks(&[(0, Some(300)), (100, Some(300)), (200, Some(300)), (300, Some(300))]));
    let started = call(&f, "update.install", json!({}));
    assert_eq!(started["phase"], "downloading");
    let done = settled(&f);
    assert_eq!(done, json!({ "phase": "ready", "version": VERSION, "installed": true }));
    let seen = progress(&f);
    // Progress as events, last of all the ready state; the received count only goes up.
    assert!(seen.iter().any(|p| p["phase"] == "downloading" && p["received"] == 200 && p["total"] == 300), "{seen:?}");
    assert_eq!(seen.last().unwrap(), &done);
    let received: Vec<u64> = seen.iter().filter_map(|p| p["received"].as_u64()).collect();
    assert!(received.windows(2).all(|w| w[0] <= w[1]), "{received:?}");
    // Once only: a second click, or another window, gets the same state, not a second download.
    assert_eq!(call(&f, "update.install", json!({}))["phase"], "ready");
    assert_eq!(f.installer.fetches(), 1);
    assert_eq!(f.installer.restarts(), 0, "nothing restarts until the person says so");
}

#[test]
fn a_second_window_asking_while_it_downloads_joins_the_same_download() {
    let f = fixture(works().chunks(&[(1, Some(4)), (2, Some(4)), (3, Some(4)), (4, Some(4))]).step(Duration::from_millis(80)));
    call(&f, "update.install", json!({}));
    assert_eq!(f.host.call_as("space-2", "update.install", &json!({}), None).unwrap().0["phase"], "downloading");
    assert_eq!(settled(&f)["phase"], "ready");
    assert_eq!(f.installer.fetches(), 1);
}

#[test]
fn cancel_stops_the_download_and_update_can_start_again() {
    let f = fixture(works().chunks(&[(1, Some(100)); 100]).step(Duration::from_millis(30)));
    call(&f, "update.install", json!({}));
    std::thread::sleep(Duration::from_millis(100));
    call(&f, "update.cancel", json!({}));
    assert_eq!(settled(&f), json!({ "phase": "failed", "reason": "cancelled" }));
    assert!(f.installer.saw_cancel.load(Ordering::SeqCst));
    // Cancel with nothing going is harmless.
    assert_eq!(call(&f, "update.cancel", json!({}))["phase"], "failed");
    f.installer.saw_cancel.store(false, Ordering::SeqCst);
    *f.installer.chunks.lock().unwrap() = vec![(1, Some(1))];
    assert_eq!(call(&f, "update.install", json!({}))["phase"], "downloading");
    assert_eq!(settled(&f)["phase"], "ready");
    assert_eq!(f.installer.fetches(), 2);
}

#[test]
fn each_failure_is_told_apart_and_nothing_is_installed() {
    for (failure, reason) in [(Failure::Verify, "verify"), (Failure::Offline, "offline"), (Failure::Disk, "disk"), (Failure::Failed, "failed")] {
        let f = fixture(ScriptedInstaller::new(Err(failure)));
        call(&f, "update.install", json!({}));
        assert_eq!(settled(&f), json!({ "phase": "failed", "reason": reason }));
        assert_eq!(progress(&f).last().unwrap()["reason"], reason);
        // A failed update cannot be restarted into.
        assert_eq!(refused(&f, "update.restart", json!({})), "NOT_ALLOWED");
        assert_eq!(f.installer.restarts(), 0);
    }
}

#[test]
fn restart_needs_a_ready_update() {
    let f = fixture(works());
    assert_eq!(refused(&f, "update.restart", json!({})), "NOT_ALLOWED");
    call(&f, "update.install", json!({}));
    settled(&f);
    assert_eq!(refused(&f, "update.restart", json!({ "evenIfRunning": "yes" })), "BAD_ARGUMENT");
    assert_eq!(call(&f, "update.restart", json!({})), json!({ "state": "restarting" }));
    assert_eq!(f.installer.restarts(), 1);
    assert_eq!(call(&f, "update.status", json!({}))["phase"], "restarting");
}

#[test]
fn the_private_space_open_at_restart_opens_again_once_after_it() {
    let vault = tempfile::tempdir().unwrap();
    let f = fixture(works());
    let root = thoth_host::paths::canonicalize_path(vault.path()).unwrap().to_string_lossy().into_owned();
    // Only a Private Space the person opened (one of the recent ones) is remembered.
    std::fs::write(f.data.path().join("recent-vaults.json"), json!({ "roots": [root] }).to_string()).unwrap();
    call(&f, "update.install", json!({}));
    settled(&f);
    assert_eq!(refused(&f, "update.restart", json!({ "reopen": "/somewhere/else" })), "NOT_ALLOWED");
    assert_eq!(refused(&f, "update.restart", json!({ "reopen": 7 })), "BAD_ARGUMENT");
    assert_eq!(f.installer.restarts(), 0);
    call(&f, "update.restart", json!({ "reopen": root }));
    // The new version starts: its first window asks once, and gets it; a second ask, or another window, gets nothing.
    let next = fixture_in(f.data, works());
    assert_eq!(call(&next, "update.status", json!({}))["reopen"], Value::Null, "only when asked for");
    assert_eq!(call(&next, "update.status", json!({ "reopen": true }))["reopen"], json!(root));
    assert_eq!(call(&next, "update.status", json!({ "reopen": true }))["reopen"], Value::Null);
}

#[cfg(not(windows))]
#[test]
fn restart_waits_for_the_person_while_an_assistant_run_is_going() {
    let f = fixture(works());
    call(&f, "update.install", json!({}));
    settled(&f);
    // A real run of the fake Claude CLI that does not end on its own.
    let created = call(&f, "agent.run.create", json!({ "provider": "claude" }));
    let run = created["run"].as_str().unwrap().to_owned();
    let argv: Value = serde_json::from_str::<Value>(include_str!("../../../packages/agent-claude/test/fixtures/argv.json")).unwrap()["cases"][0]["argv"].clone();
    f.host.call("agent.start", &json!({ "run": run, "argv": argv }), Some(b"@hang\n")).unwrap();

    assert_eq!(call(&f, "update.restart", json!({})), json!({ "state": "busy", "runs": 1 }));
    assert_eq!(f.installer.restarts(), 0);
    assert_eq!(call(&f, "update.status", json!({}))["phase"], "ready", "still ready: the person chooses");
    // The person chose to restart anyway.
    assert_eq!(call(&f, "update.restart", json!({ "evenIfRunning": true }))["state"], "restarting");
    assert_eq!(f.installer.restarts(), 1);
    call(&f, "agent.cancel", json!({ "run": run }));
}
