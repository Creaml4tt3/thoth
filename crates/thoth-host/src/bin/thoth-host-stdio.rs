//! JSON-lines harness over `thoth_host::Host`, for the port contract tests and
//! the e2e dev bridge. TEST INFRASTRUCTURE ONLY: never bundled into the app
//! (the desktop crate links the library, not this binary).
//!
//! Request:  {"id", "command", "args", "bytes"?: base64}
//! Response: {"id", "ok", "result"?, "bytes"?: base64, "error"?: {code, message}}
//! Event:    {"event": "vault.changed", "payload"}
//!           {"event": "browser.open", "payload": {"url"}}   (server sign-in: the test plays the browser)
//!
//! Workspace-server commands (`server.*`, `api.call`) run on their own thread, so `server.signInCancel` and
//! other calls are answered while a sign-in waits for its browser; responses may then arrive out of order
//! (match them by `id`). Every other command runs in order on the main thread, as before. Secrets are kept
//! in memory only and die with the process.
//!
//! `agent.events` (a long poll) and `agent.detect` (runs the CLI's probes) also run on their own thread.
//!
//! Flags: --allow-root <dir> (repeatable), --pick-vault <dir>,
//! --pick-source <path>, --data-dir <dir>, --agent-search-dir <dir> (repeatable: look for agent CLIs only
//! there, so tests run a fake `claude` and can make it missing). Env: THOTH_TEST_DISABLE_HARDLINK=1
//! makes no-replace rename take the exclusive-copy fallback.
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use thoth_host::{Browser, FileManager, Host, HostConfig, HostError, HostResult, MemorySecretStore, Picker};

/// Longest request line accepted (1 GiB of base64 plus JSON overhead).
const MAX_LINE: usize = 1024 * 1024 * 1024 / 3 * 4 + 1024 * 1024;

struct FixedPicker {
    vault: Option<PathBuf>,
    source: Option<PathBuf>,
}

impl Picker for FixedPicker {
    fn pick_vault(&self) -> Option<PathBuf> {
        self.vault.clone()
    }
    fn pick_source(&self, _directory: bool) -> Option<PathBuf> {
        self.source.clone()
    }
}

/// Hands the sign-in URL to the test as a `browser.open` event instead of opening a browser.
struct EventBrowser {
    emit: Arc<dyn Fn(Value) + Send + Sync>,
}

impl Browser for EventBrowser {
    fn open(&self, url: &str) -> HostResult<()> {
        (self.emit)(json!({ "event": "browser.open", "payload": { "url": url } }));
        Ok(())
    }
}

/// Reports `vault.reveal` as a `vault.revealed` event instead of opening a file manager.
struct EventFileManager {
    emit: Arc<dyn Fn(Value) + Send + Sync>,
}

impl FileManager for EventFileManager {
    fn reveal(&self, root: &std::path::Path) -> HostResult<()> {
        (self.emit)(json!({ "event": "vault.revealed", "payload": { "root": root.to_string_lossy() } }));
        Ok(())
    }
}

fn usage(message: &str) -> ! {
    eprintln!("thoth-host-stdio: {message}\nusage: thoth-host-stdio [--allow-root DIR]... [--pick-vault DIR] [--pick-source PATH] [--data-dir DIR] [--agent-search-dir DIR]...");
    std::process::exit(2);
}

fn main() {
    let mut allow_roots = Vec::new();
    let mut vault = None;
    let mut source = None;
    let mut data_dir = None;
    let mut agent_dirs: Option<Vec<PathBuf>> = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(flag) = args.next() {
        let mut value = || args.next().map(PathBuf::from).unwrap_or_else(|| usage("missing flag value"));
        match flag.to_str() {
            Some("--allow-root") => allow_roots.push(value()),
            Some("--pick-vault") => vault = Some(value()),
            Some("--pick-source") => source = Some(value()),
            Some("--data-dir") => data_dir = Some(value()),
            Some("--agent-search-dir") => agent_dirs.get_or_insert_with(Vec::new).push(value()),
            _ => usage(&format!("unknown flag {flag:?}")),
        }
    }

    let out = Arc::new(Mutex::new(std::io::stdout()));
    let emit = {
        let out = out.clone();
        move |line: Value| {
            let mut out = out.lock().unwrap_or_else(|p| p.into_inner());
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }
    };
    let event_emit = emit.clone();
    let browser_emit = emit.clone();
    let reveal_emit = emit.clone();
    let host = Arc::new(Host::new(HostConfig {
        data_dir,
        allow_roots,
        picker: Arc::new(FixedPicker { vault, source }),
        events: Arc::new(move |event, payload| event_emit(json!({ "event": event, "payload": payload }))),
        disable_hardlink: std::env::var_os("THOTH_TEST_DISABLE_HARDLINK").is_some_and(|v| v == "1"),
        secrets: Arc::new(MemorySecretStore::default()),
        browser: Arc::new(EventBrowser { emit: Arc::new(browser_emit) }),
        file_manager: Arc::new(EventFileManager { emit: Arc::new(reveal_emit) }),
        agent_search_dirs: agent_dirs,
    }));
    let mut workers = Vec::new();

    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut line = String::new();
    loop {
        line.clear();
        match (&mut reader).take(MAX_LINE as u64).read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if !line.ends_with('\n') && line.len() >= MAX_LINE {
            emit(json!({ "id": null, "ok": false, "error": { "code": "BAD_ARGUMENT", "message": "Request line too long" } }));
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        if runs_off_main(&line) {
            let (host, emit, line) = (host.clone(), emit.clone(), line.clone());
            workers.push(std::thread::spawn(move || emit(handle(&host, &line))));
            workers.retain(|w| !w.is_finished());
        } else {
            emit(handle(&host, &line));
        }
    }
    // Cancels sign-ins still waiting for a browser, then lets in-flight server calls answer before exiting.
    host.shutdown();
    for worker in workers {
        let _ = worker.join();
    }
}

/// `server.*` and `api.call` may block on the network or a browser, `agent.events` waits for output and
/// `agent.detect` runs the CLI; they run off the main loop. So do `sql.*` and `fs.*`, as the desktop shell runs every
/// call on its own blocking thread: with two windows on one folder (ADR-0019), one window's `BEGIN IMMEDIATE` waits
/// in SQLite's busy handler for the other's transaction, which must be able to go on meanwhile.
fn runs_off_main(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|r| {
            r.get("command").and_then(Value::as_str).map(|c| c.starts_with("server.") || c.starts_with("sql.") || c.starts_with("fs.") || matches!(c, "api.call" | "agent.events" | "agent.detect"))
        })
        .unwrap_or(false)
}

fn handle(host: &Host, line: &str) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({ "id": null, "ok": false, "error": { "code": "BAD_ARGUMENT", "message": format!("Invalid JSON: {e}") } }),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let result = (|| {
        let command = request.get("command").and_then(Value::as_str).ok_or_else(|| HostError::bad_argument("command must be a string"))?;
        let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
        let bytes = match request.get("bytes") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(B64.decode(s).map_err(|_| HostError::bad_argument("bytes is not valid base64"))?),
            Some(_) => return Err(HostError::bad_argument("bytes must be a base64 string")),
        };
        host.call(command, &args, bytes.as_deref())
    })();
    match result {
        Ok((value, None)) => json!({ "id": id, "ok": true, "result": value }),
        Ok((_, Some(bytes))) => json!({ "id": id, "ok": true, "bytes": B64.encode(bytes) }),
        Err(e) => json!({ "id": id, "ok": false, "error": e }),
    }
}
