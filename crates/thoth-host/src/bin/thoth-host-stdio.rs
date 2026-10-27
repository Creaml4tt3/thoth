//! JSON-lines harness over `thoth_host::Host`, for the port contract tests and
//! the e2e dev bridge. TEST INFRASTRUCTURE ONLY: never bundled into the app
//! (the desktop crate links the library, not this binary).
//!
//! Request:  {"id", "command", "args", "bytes"?: base64, "owner"?: string (the window that asks, ADR-0019)}
//! Response: {"id", "ok", "result"?, "bytes"?: base64, "error"?: {code, message}}
//! Event:    {"event": "vault.changed", "payload"}
//!           {"event": "browser.open", "payload": {"url"}}   (server sign-in: the test plays the browser)
//!
//! Workspace-server commands (`server.*`, `api.call`) run on their own thread, so `server.signInCancel` and
//! other calls are answered while a sign-in waits for its browser; responses may then arrive out of order
//! (match them by `id`). Every other command runs in order on the main thread, as before. Secrets are kept
//! in memory only and die with the process, unless `--secrets-file` names a file for them.
//!
//! `agent.events` (a long poll) and `agent.detect` (runs the CLI's probes) also run on their own thread, and so do
//! `link.*` (link previews fetch from the network) and `update.*` (the update check does too).
//!
//! Flags: --allow-root <dir> (repeatable), --pick-vault <dir>,
//! --pick-source <path>, --pick-image <path> (the image picker's answer, ADR-0028), --data-dir <dir>, --agent-search-dir <dir> (repeatable: look for agent CLIs only
//! there, so tests run a fake `claude` and can make it missing), --secrets-file <path> (keep server secrets in
//! that file instead of memory: it stands in for the system keychain, so a test can restart the host and still
//! be signed in, as the desktop app is), --link-preview-loopback (link previews may fetch from loopback
//! addresses, so tests run a local page server; ADR-0020), --update-url <url> (turn the update notice on, reading
//! `latest.json` from that address; an `http` address on loopback needs --link-preview-loopback), --update-current
//! <version> (the app version it compares with, default 0.1.0) and --update-now <seconds> (its clock is fixed at that
//! Unix time, so a test can let the 24 hours pass; ADR-0022). Env: THOTH_TEST_DISABLE_HARDLINK=1 makes no-replace rename take the
//! exclusive-copy fallback.
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use thoth_host::{Browser, FileManager, Host, HostConfig, HostError, HostResult, MemorySecretStore, Picker, SecretStore};
use thoth_host::updates::UpdateOptions;

/// Longest request line accepted (1 GiB of base64 plus JSON overhead).
const MAX_LINE: usize = 1024 * 1024 * 1024 / 3 * 4 + 1024 * 1024;

struct FixedPicker {
    vault: Option<PathBuf>,
    source: Option<PathBuf>,
    image: Option<PathBuf>,
}

impl Picker for FixedPicker {
    fn pick_vault(&self) -> Option<PathBuf> {
        self.vault.clone()
    }
    fn pick_source(&self, _directory: bool) -> Option<PathBuf> {
        self.source.clone()
    }
    fn pick_image(&self) -> Option<PathBuf> {
        self.image.clone()
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

/// Reports `vault.reveal` as a `vault.revealed` event instead of opening a file manager: `{ root }`, and `entry` when an
/// entry in it was asked for.
struct EventFileManager {
    emit: Arc<dyn Fn(Value) + Send + Sync>,
}

impl FileManager for EventFileManager {
    fn reveal(&self, root: &std::path::Path, entry: Option<&std::path::Path>) -> HostResult<()> {
        let mut payload = json!({ "root": root.to_string_lossy() });
        if let Some(entry) = entry {
            payload["entry"] = json!(entry.to_string_lossy());
        }
        (self.emit)(json!({ "event": "vault.revealed", "payload": payload }));
        Ok(())
    }
}

/// `--secrets-file`: server secrets in a JSON file (server → secret), in place of the system keychain, so that they
/// outlive the process as the desktop app's do. Test infrastructure only; the file is created owner-only.
struct FileSecretStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl FileSecretStore {
    fn read(&self) -> BTreeMap<String, String> {
        std::fs::read(&self.path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    fn write(&self, secrets: &BTreeMap<String, String>) -> HostResult<()> {
        let bytes = serde_json::to_vec(secrets).map_err(|_| HostError::internal("Could not encode the secrets file"))?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(&self.path).and_then(|mut file| file.write_all(&bytes)).map_err(|_| HostError::internal("Could not write the secrets file"))
    }
}

impl SecretStore for FileSecretStore {
    fn get(&self, server: &str) -> HostResult<Option<String>> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        Ok(self.read().remove(server))
    }
    fn set(&self, server: &str, secret: &str) -> HostResult<()> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut secrets = self.read();
        secrets.insert(server.to_owned(), secret.to_owned());
        self.write(&secrets)
    }
    fn delete(&self, server: &str) -> HostResult<()> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut secrets = self.read();
        if secrets.remove(server).is_some() {
            self.write(&secrets)?;
        }
        Ok(())
    }
}

fn usage(message: &str) -> ! {
    eprintln!("thoth-host-stdio: {message}\nusage: thoth-host-stdio [--allow-root DIR]... [--pick-vault DIR] [--pick-source PATH] [--pick-image PATH] [--data-dir DIR] [--agent-search-dir DIR]... [--secrets-file PATH] [--link-preview-loopback] [--update-url URL] [--update-current VERSION] [--update-now SECONDS]");
    std::process::exit(2);
}

fn main() {
    let mut allow_roots = Vec::new();
    let mut vault = None;
    let mut source = None;
    let mut image = None;
    let mut data_dir = None;
    let mut agent_dirs: Option<Vec<PathBuf>> = None;
    let mut secrets_file = None;
    let mut link_preview_loopback = false;
    let mut update_url: Option<String> = None;
    let mut update_current = String::from("0.1.0");
    let mut update_now: Option<u64> = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(flag) = args.next() {
        if flag.to_str() == Some("--link-preview-loopback") {
            link_preview_loopback = true;
            continue;
        }
        let mut value = || args.next().map(PathBuf::from).unwrap_or_else(|| usage("missing flag value"));
        match flag.to_str() {
            Some("--allow-root") => allow_roots.push(value()),
            Some("--pick-vault") => vault = Some(value()),
            Some("--pick-source") => source = Some(value()),
            Some("--pick-image") => image = Some(value()),
            Some("--data-dir") => data_dir = Some(value()),
            Some("--agent-search-dir") => agent_dirs.get_or_insert_with(Vec::new).push(value()),
            Some("--secrets-file") => secrets_file = Some(value()),
            Some("--update-url") => update_url = Some(value().to_string_lossy().into_owned()),
            Some("--update-current") => update_current = value().to_string_lossy().into_owned(),
            Some("--update-now") => update_now = Some(value().to_string_lossy().parse().unwrap_or_else(|_| usage("--update-now takes seconds"))),
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
    let host = Host::new(HostConfig {
        data_dir,
        allow_roots,
        picker: Arc::new(FixedPicker { vault, source, image }),
        events: Arc::new(move |event, payload| event_emit(json!({ "event": event, "payload": payload }))),
        disable_hardlink: std::env::var_os("THOTH_TEST_DISABLE_HARDLINK").is_some_and(|v| v == "1"),
        secrets: match secrets_file {
            Some(path) => Arc::new(FileSecretStore { path, lock: Mutex::new(()) }),
            None => Arc::new(MemorySecretStore::default()),
        },
        browser: Arc::new(EventBrowser { emit: Arc::new(browser_emit) }),
        file_manager: Arc::new(EventFileManager { emit: Arc::new(reveal_emit) }),
        agent_search_dirs: agent_dirs,
        link_preview_loopback,
    });
    // The update notice (ADR-0022) is off unless a test names an address for it.
    let host = Arc::new(match update_url {
        Some(url) => {
            let mut options = UpdateOptions::new(update_current, url);
            if let Some(now) = update_now {
                options.clock = Arc::new(move || std::time::UNIX_EPOCH + std::time::Duration::from_secs(now));
            }
            host.with_updates(options)
        }
        None => host,
    });
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
            r.get("command").and_then(Value::as_str).map(|c| c.starts_with("server.") || c.starts_with("sql.") || c.starts_with("fs.") || c.starts_with("link.") || c.starts_with("update.") || matches!(c, "api.call" | "agent.events" | "agent.detect"))
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
        // Which window asked (ADR-0019): a test or the e2e bridge names one per connection, as the desktop shell names
        // the webview. "" when absent.
        let owner = match request.get("owner") {
            None | Some(Value::Null) => "",
            Some(Value::String(s)) => s.as_str(),
            Some(_) => return Err(HostError::bad_argument("owner must be a string")),
        };
        host.call_as(owner, command, &args, bytes.as_deref())
    })();
    match result {
        Ok((value, None)) => json!({ "id": id, "ok": true, "result": value }),
        Ok((_, Some(bytes))) => json!({ "id": id, "ok": true, "bytes": B64.encode(bytes) }),
        Err(e) => json!({ "id": id, "ok": false, "error": e }),
    }
}
