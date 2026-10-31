//! Connected apps (ADR-0021): other apps on this computer read the Private Spaces the user shares, through the MCP
//! server `thoth-mcp` that they start. `thoth-mcp` opens no vault: it relays each tool call over a local socket to
//! this host, which checks it, asks the user about an app it has not seen, and has the window that holds the Private
//! Space answer from its open `Vault` (one index per window, ADR-0019). Read only.
//!
//! Off by default. What is shared (the switch, the Private Spaces, each app's Allow or Deny) is kept in
//! `<data>/mcp/settings.json`; every request is logged in `<data>/mcp/log/` (`log.rs`).
//!
//! An app is known by the name it gives (MCP `clientInfo.name`). That name is self-reported: any program of this
//! user can give any name. Allow and Deny are the user's consent for a name, not proof of who connects; the socket
//! being the user's own (`0600` in a `0700` folder) is what keeps other users out.
pub mod log;
mod socket;
pub mod tools;

use crate::EventSink;
use crate::error::{HostError, HostResult};
use crate::handles::new_handle;
use log::Log;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use socket::Listener;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tools::{Call, Found};

/// The Connected apps folder in the app data folder.
pub const DIR: &str = "mcp";
/// Sent to the windows: answer this request from your open Vault (`mcp.answer`). Payload:
/// `{ id, owner, root, space, tool, args }`; only the window `owner` may answer.
pub const REQUEST_EVENT: &str = "mcp.request";
/// Sent to the windows when the apps waiting for Allow or Deny change. Payload: `{ apps: [name] }`.
pub const PENDING_EVENT: &str = "mcp.pending";
/// Longest request line from `thoth-mcp`.
pub const MAX_REQUEST: usize = 64 * 1024;
/// Largest answer to an app (ADR-0021 rule 3).
pub const MAX_RESPONSE: usize = 1024 * 1024;
/// Requests answered at once; more are told to try again.
pub const MAX_CONNECTIONS: usize = 8;
/// Apps remembered (allowed or denied) plus apps waiting for an answer.
const MAX_APPS: usize = 64;
/// Apps waiting for an answer at once.
const MAX_PENDING: usize = 4;
/// Longest app name kept, in characters.
const MAX_APP_NAME: usize = 64;
/// The most Private Spaces shared.
const MAX_SPACES: usize = 64;
/// What an app that gives no name is called.
const UNNAMED: &str = "Unnamed app";
const SETTINGS_FILE: &str = "settings.json";
/// The sidecar's file name, next to the app's own program once installed (Tauri `externalBin`).
const SIDECAR: &str = if cfg!(windows) { "thoth-mcp.exe" } else { "thoth-mcp" };

#[derive(Clone, Copy, Debug)]
pub struct McpOptions {
    /// How long a request waits for the user to answer Allow or Deny.
    pub prompt_timeout: Duration,
    /// How long a request waits for the windows' answer.
    pub answer_timeout: Duration,
    /// How long `thoth-mcp` has to send its request line (and to read the answer).
    pub read_timeout: Duration,
}

impl Default for McpOptions {
    fn default() -> Self {
        Self { prompt_timeout: Duration::from_secs(60), answer_timeout: Duration::from_secs(15), read_timeout: Duration::from_secs(5) }
    }
}

/// A Private Space open in a window: its canonical root and the window (`owner`, the webview label).
#[derive(Clone, Debug)]
pub struct OpenSpace {
    pub root: PathBuf,
    pub owner: String,
}

/// The Private Spaces open right now.
pub type OpenSpaces = Arc<dyn Fn() -> Vec<OpenSpace> + Send + Sync>;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    enabled: bool,
    /// Canonical roots, each shared by the user.
    #[serde(default)]
    spaces: Vec<String>,
    #[serde(default)]
    apps: Vec<App>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct App {
    name: String,
    allowed: bool,
    decided_at: String,
}

struct Waiting {
    owner: String,
    answer: SyncSender<HostResult<Value>>,
}

struct State {
    settings: Settings,
    /// Apps that asked and wait for Allow or Deny, oldest first.
    pending: Vec<String>,
    /// Requests sent to a window, by id.
    waiting: HashMap<String, Waiting>,
    /// Why listening failed, when it did.
    error: Option<String>,
}

pub(crate) struct Inner {
    dir: Option<PathBuf>,
    events: EventSink,
    spaces: OpenSpaces,
    pub(crate) options: McpOptions,
    state: Mutex<State>,
    /// Signalled when an app is allowed, denied or forgotten, or the switch goes off.
    decided: Condvar,
    log: Log,
}

/// Connected apps: the settings the windows change (`mcp.*` commands) and the socket `thoth-mcp` talks to.
pub struct Relay {
    inner: Arc<Inner>,
    listener: Mutex<Option<Listener>>,
}

/// A Private Space a request goes to.
struct Target {
    label: String,
    root: String,
    owner: String,
}

/// What the log keeps of one request.
#[derive(Default)]
struct Entry {
    app: Option<String>,
    tool: String,
    spaces: Vec<String>,
    paths: Vec<String>,
}

impl Relay {
    /// `dir` is `<data>/mcp` (`None`: nothing is kept and nothing can be switched on). Starts listening when the
    /// saved settings say so.
    pub fn new(dir: Option<PathBuf>, events: EventSink, spaces: OpenSpaces, options: McpOptions) -> Self {
        let settings = dir.as_deref().map(load).unwrap_or_default();
        let enabled = settings.enabled;
        let log = Log::new(dir.as_deref());
        let state = State { settings, pending: Vec::new(), waiting: HashMap::new(), error: None };
        let relay = Self {
            inner: Arc::new(Inner { dir, events, spaces, options, state: Mutex::new(state), decided: Condvar::new(), log }),
            listener: Mutex::new(None),
        };
        if enabled {
            let _ = relay.listen();
        }
        relay
    }

    /// `mcp.settings`: the switch, the shared Private Spaces, the apps, the apps waiting for an answer and the setup
    /// to paste into an app.
    pub fn settings(&self) -> Value {
        let listening = lock(&self.listener).is_some();
        let state = self.inner.state();
        let apps: Vec<Value> = state.settings.apps.iter().map(|a| json!({ "name": a.name, "allowed": a.allowed, "decidedAt": a.decided_at })).collect();
        json!({
            "available": cfg!(unix) && self.inner.dir.is_some(),
            "enabled": state.settings.enabled,
            "listening": listening,
            "error": state.error,
            "spaces": state.settings.spaces,
            "apps": apps,
            "pending": state.pending,
            "setup": self.setup(),
        })
    }

    /// `mcp.configure { enabled?, spaces? }`. `spaces` replaces the shared list; each must be in `opened` (the
    /// Private Spaces the user opened: the host's recent list and the open ones).
    pub fn configure(&self, args: &Value, opened: &[String]) -> HostResult<Value> {
        if let Some(spaces) = args.get("spaces").filter(|v| !v.is_null()) {
            let spaces = spaces.as_array().ok_or_else(|| HostError::bad_argument("spaces must be a list of Private Space folders"))?;
            let mut chosen: Vec<String> = Vec::new();
            for space in spaces {
                let root = space.as_str().ok_or_else(|| HostError::bad_argument("spaces must be a list of Private Space folders"))?;
                if !opened.iter().any(|o| o == root) {
                    return Err(HostError::not_allowed("Only a Private Space you opened in Thoth can be shared"));
                }
                if !chosen.iter().any(|c| c == root) {
                    chosen.push(root.to_owned());
                }
            }
            if chosen.len() > MAX_SPACES {
                return Err(HostError::bad_argument("Too many Private Spaces"));
            }
            let mut state = self.inner.state();
            state.settings.spaces = chosen;
            self.inner.save(&state.settings)?;
        }
        match args.get("enabled") {
            None | Some(Value::Null) => {}
            Some(Value::Bool(true)) => {
                self.listen()?;
                let mut state = self.inner.state();
                state.settings.enabled = true;
                self.inner.save(&state.settings)?;
            }
            Some(Value::Bool(false)) => self.switch_off()?,
            Some(_) => return Err(HostError::bad_argument("enabled must be a boolean")),
        }
        Ok(self.settings())
    }

    /// `mcp.decide { app, allow }`: the user's Allow or Deny (or a later change of mind) for an app that asked.
    pub fn decide(&self, app: &str, allow: bool) -> HostResult<Value> {
        let name = app_name(app).ok_or_else(|| HostError::bad_argument("app must be an app's name"))?;
        {
            let mut state = self.inner.state();
            let known = state.settings.apps.iter().position(|a| a.name == name);
            if known.is_none() && !state.pending.contains(&name) {
                return Err(HostError::bad_argument(format!("No app called {name:?} asked")));
            }
            let decided = App { name: name.clone(), allowed: allow, decided_at: log::timestamp() };
            match known {
                Some(i) => state.settings.apps[i] = decided,
                None => state.settings.apps.push(decided),
            }
            state.pending.retain(|p| p != &name);
            self.inner.save(&state.settings)?;
        }
        self.inner.decided.notify_all();
        self.inner.emit_pending();
        Ok(self.settings())
    }

    /// `mcp.forget { app }`: removes an app; it is asked about again next time it connects.
    pub fn forget(&self, app: &str) -> HostResult<Value> {
        let name = app_name(app).ok_or_else(|| HostError::bad_argument("app must be an app's name"))?;
        {
            let mut state = self.inner.state();
            state.settings.apps.retain(|a| a.name != name);
            state.pending.retain(|p| p != &name);
            self.inner.save(&state.settings)?;
        }
        self.inner.decided.notify_all();
        self.inner.emit_pending();
        Ok(self.settings())
    }

    /// `mcp.answer { id, result | error }` from the window `owner`: its answer to an `mcp.request`.
    pub fn answer(&self, owner: &str, id: &str, args: &Value) -> HostResult<()> {
        let waiting = {
            let mut state = self.inner.state();
            let waiting = state.waiting.remove(id).ok_or_else(|| HostError::bad_argument("That request is over (it took too long, or was answered)"))?;
            if waiting.owner != owner {
                state.waiting.insert(id.to_owned(), waiting);
                return Err(HostError::not_allowed("Another window was asked"));
            }
            waiting
        };
        let reply = match (args.get("result"), args.get("error")) {
            (Some(result), None) if serde_json::to_vec(result).map_or(usize::MAX, |b| b.len()) > MAX_RESPONSE => Err(too_large()),
            (Some(result), None) => Ok(result.clone()),
            (None, Some(error)) => Err(window_error(error)),
            _ => Err(HostError::internal("Thoth's window sent an answer it should not have")),
        };
        let _ = waiting.answer.try_send(reply);
        Ok(())
    }

    /// `mcp.log`: the requests of the last 30 days, newest first.
    pub fn log(&self) -> Value {
        Value::Array(self.inner.log.read())
    }

    /// Stops listening (the app quits). The settings stay as they are.
    pub fn stop(&self) {
        lock(&self.listener).take();
        self.inner.end_waits();
    }

    fn listen(&self) -> HostResult<()> {
        let dir = self.inner.dir.as_ref().ok_or_else(|| HostError::not_allowed("Connected apps need the app data folder"))?;
        let mut slot = lock(&self.listener);
        if slot.is_some() {
            return Ok(());
        }
        match Listener::start(dir, self.inner.clone()) {
            Ok(listener) => {
                *slot = Some(listener);
                self.inner.state().error = None;
                Ok(())
            }
            Err(error) => {
                self.inner.state().error = Some(error.message.clone());
                Err(error)
            }
        }
    }

    fn switch_off(&self) -> HostResult<()> {
        lock(&self.listener).take();
        {
            let mut state = self.inner.state();
            state.settings.enabled = false;
            state.error = None;
            self.inner.save(&state.settings)?;
        }
        self.inner.end_waits();
        Ok(())
    }

    /// What an app's MCP settings need: the sidecar next to this program, and this socket.
    fn setup(&self) -> Value {
        let Some(dir) = &self.inner.dir else { return Value::Null };
        let Some(command) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.join(SIDECAR))) else { return Value::Null };
        json!({ "command": command, "args": ["--socket", socket::socket_path(dir)] })
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    fn save(&self, settings: &Settings) -> HostResult<()> {
        let Some(dir) = &self.dir else { return Ok(()) };
        private_dir(dir)?;
        let mut body = serde_json::to_value(settings).map_err(|e| HostError::internal(format!("Could not write the settings: {e}")))?;
        body["version"] = json!(1);
        write_private(&dir.join(SETTINGS_FILE), body.to_string().as_bytes())
    }

    fn emit_pending(&self) {
        let pending = self.state().pending.clone();
        (self.events)(PENDING_EVENT, json!({ "apps": pending }));
    }

    /// Switched off or quitting: the apps waiting for an answer are no longer asked about.
    fn end_waits(&self) {
        let had = !std::mem::take(&mut self.state().pending).is_empty();
        self.decided.notify_all();
        if had {
            self.emit_pending();
        }
    }

    /// One request line from `thoth-mcp` → one answer line (`{ ok, result: { text, structured } }` or
    /// `{ ok: false, error: { code, message } }`). Logs it.
    pub(crate) fn serve(&self, line: &[u8]) -> String {
        let mut entry = Entry::default();
        let outcome = self.handle(line, &mut entry).and_then(|answer| {
            let out = json!({ "ok": true, "result": { "text": answer.text, "structured": answer.structured } }).to_string();
            if out.len() > MAX_RESPONSE { Err(too_large()) } else { Ok(out) }
        });
        if let Some(app) = entry.app {
            let mut logged =
                json!({ "time": log::timestamp(), "app": app, "tool": entry.tool, "spaces": entry.spaces, "paths": entry.paths, "ok": outcome.is_ok() });
            if let Err(error) = &outcome {
                logged["error"] = json!(error.code);
            }
            self.log.append(&logged);
        }
        outcome.unwrap_or_else(|error| error_line(&error))
    }

    fn handle(&self, line: &[u8], entry: &mut Entry) -> HostResult<tools::Answer> {
        let request: Value = serde_json::from_slice(line).map_err(|_| HostError::bad_argument("The request is not JSON"))?;
        if request.get("v") != Some(&json!(1)) {
            return Err(HostError::bad_argument("This thoth-mcp does not match this Thoth: install the same version"));
        }
        let app = request.get("app").and_then(Value::as_str).and_then(app_name).unwrap_or_else(|| UNNAMED.to_owned());
        let tool = request.get("tool").and_then(Value::as_str).ok_or_else(|| HostError::bad_argument("tool must be a string"))?;
        entry.tool = if tools::TOOLS.contains(&tool) { tool.to_owned() } else { "unknown".to_owned() };
        entry.app = Some(app.clone());
        let arguments = request.get("arguments").cloned().unwrap_or_else(|| json!({}));
        self.permit(&app)?;
        let call = Call::parse(tool, &arguments)?;
        entry.paths = call.asked_paths();
        let targets = self.targets(&call)?;
        entry.spaces = targets.iter().map(|t| t.label.clone()).collect();

        let deadline = Instant::now() + self.options.answer_timeout;
        let mut asked: Vec<(String, Receiver<HostResult<Value>>)> = Vec::new();
        for target in &targets {
            match self.ask(target, &call) {
                Ok(waiting) => asked.push(waiting),
                Err(error) => {
                    self.forget_waits(&asked);
                    return Err(error);
                }
            }
        }
        let mut values = Vec::new();
        for (i, (_, answer)) in asked.iter().enumerate() {
            let left = deadline.saturating_duration_since(Instant::now());
            match answer.recv_timeout(left) {
                Ok(Ok(value)) => values.push(value),
                Ok(Err(error)) => {
                    self.forget_waits(&asked[i..]);
                    return Err(error);
                }
                Err(_) => {
                    self.forget_waits(&asked[i..]);
                    return Err(HostError::new("TIMEOUT", "Thoth did not answer in time: try again"));
                }
            }
        }
        let found: Vec<Found<'_>> = targets.iter().zip(&values).map(|(t, value)| Found { space: &t.label, value }).collect();
        let answer = tools::answer(&call, &found)?;
        entry.paths = answer.paths.clone();
        Ok(answer)
    }

    /// Waits until `app` may read (allowed), or says why not. An app never seen is added to the apps waiting for the
    /// user's answer, and the windows are told; the request waits for that answer up to `prompt_timeout`.
    fn permit(&self, app: &str) -> HostResult<()> {
        let deadline = Instant::now() + self.options.prompt_timeout;
        let mut state = self.state();
        let mut asked = false;
        loop {
            if !state.settings.enabled {
                return Err(HostError::new("NOT_ENABLED", "Connected apps are off: open Thoth and switch on Connected apps in Settings"));
            }
            if let Some(known) = state.settings.apps.iter().find(|a| a.name == app) {
                return if known.allowed {
                    Ok(())
                } else {
                    Err(HostError::new("DENIED", format!("{app} may not read your notes: allow it in Thoth, under Settings → Connected apps")))
                };
            }
            if !state.pending.iter().any(|p| p == app) {
                if asked {
                    // It was waiting and is gone without a decision: forgotten, or Connected apps went off.
                    return Err(HostError::new("DENIED", format!("{app} may not read your notes: allow it in Thoth, under Settings → Connected apps")));
                }
                if state.pending.len() >= MAX_PENDING || state.settings.apps.len() + state.pending.len() >= MAX_APPS {
                    return Err(HostError::new(
                        "BUSY",
                        "Too many apps are waiting for an answer in Thoth: answer them, or remove some under Settings → Connected apps",
                    ));
                }
                state.pending.push(app.to_owned());
                drop(state);
                self.emit_pending();
                state = self.state();
            }
            asked = true;
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(HostError::not_allowed(format!("Thoth is asking whether {app} may read your notes: answer in Thoth's window, then try again")));
            }
            state = self.decided.wait_timeout(state, left).unwrap_or_else(|p| p.into_inner()).0;
        }
    }

    /// The shared Private Spaces that are open in a window, and which window answers for each (`main` first: the
    /// window the user started with).
    fn targets(&self, call: &Call) -> HostResult<Vec<Target>> {
        let shared = self.state().settings.spaces.clone();
        let open = (self.spaces)();
        let mut targets: Vec<Target> = Vec::new();
        for root in shared {
            let mut owners: Vec<&str> = open.iter().filter(|o| o.root.to_string_lossy() == root.as_str()).map(|o| o.owner.as_str()).collect();
            owners.sort_unstable();
            let Some(owner) = owners.iter().find(|o| **o == "main").or(owners.first()).map(|o| (*o).to_owned()) else { continue };
            let name = Path::new(&root).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.clone());
            let mut label = name.clone();
            let mut n = 2;
            while targets.iter().any(|t| t.label == label) {
                label = format!("{name} ({n})");
                n += 1;
            }
            targets.push(Target { label, root, owner });
        }
        if targets.is_empty() {
            return Err(HostError::new(
                "NO_SPACE",
                "No Private Space is shared with connected apps right now: in Thoth, open one and tick it under Settings → Connected apps",
            ));
        }
        let names = || targets.iter().map(|t| format!("{:?}", t.label)).collect::<Vec<_>>().join(", ");
        if let Some(space) = call.space() {
            if !targets.iter().any(|t| t.label == space) {
                return Err(HostError::new("NO_SPACE", format!("No shared Private Space is called {space:?}. Shared and open now: {}", names())));
            }
            targets.retain(|t| t.label == space);
        } else if call.one_space() && targets.len() > 1 {
            return Err(HostError::bad_argument(format!("Say which Private Space (space): {}", names())));
        }
        Ok(targets)
    }

    /// Sends one request to the window that holds `target`.
    fn ask(&self, target: &Target, call: &Call) -> HostResult<(String, Receiver<HostResult<Value>>)> {
        let id = new_handle("mcp")?;
        let (tx, rx) = sync_channel(1);
        self.state().waiting.insert(id.clone(), Waiting { owner: target.owner.clone(), answer: tx });
        (self.events)(
            REQUEST_EVENT,
            json!({ "id": id, "owner": target.owner, "root": target.root, "space": target.label, "tool": call.tool(), "args": call.window_args() }),
        );
        Ok((id, rx))
    }

    fn forget_waits(&self, asked: &[(String, Receiver<HostResult<Value>>)]) {
        let mut state = self.state();
        for (id, _) in asked {
            state.waiting.remove(id);
        }
    }
}

/// An app's name as shown and remembered: control and invisible formatting characters (which could make one name
/// look like another) taken out, spaces collapsed, at most 64 characters. `None` when nothing is left.
pub fn app_name(raw: &str) -> Option<String> {
    let kept: String = raw.chars().map(|c| if c.is_whitespace() { ' ' } else { c }).filter(|c| !c.is_control() && !invisible(*c)).collect();
    let name = kept.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    if name.is_empty() { None } else { Some(name.chars().take(MAX_APP_NAME).collect()) }
}

/// Unicode format characters that change how text is shown without showing (bidirectional controls, zero-width
/// characters, the BOM).
fn invisible(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}' | '\u{17B4}' | '\u{17B5}' | '\u{180B}'..='\u{180F}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{3164}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}' | '\u{FFA0}' | '\u{FFF0}'..='\u{FFFB}' | '\u{E0000}'..='\u{E0FFF}')
}

/// A window's error answer: only codes the tools use pass through; the message is cut.
fn window_error(error: &Value) -> HostError {
    let message: String = error.get("message").and_then(Value::as_str).unwrap_or("The page could not be read").chars().take(300).collect();
    match error.get("code").and_then(Value::as_str) {
        Some("NOT_FOUND") => HostError::new("NOT_FOUND", message),
        _ => HostError::internal(message),
    }
}

fn too_large() -> HostError {
    HostError::new("TOO_LARGE", "The answer is over 1 MB: ask for less (a smaller limit, or one page)")
}

pub(crate) fn error_line(error: &HostError) -> String {
    json!({ "ok": false, "error": error }).to_string()
}

fn load(dir: &Path) -> Settings {
    let Ok(bytes) = std::fs::read(dir.join(SETTINGS_FILE)) else { return Settings::default() };
    let mut settings: Settings = serde_json::from_slice(&bytes).unwrap_or_default();
    settings.apps.retain(|a| app_name(&a.name).as_deref() == Some(a.name.as_str()));
    settings.apps.truncate(MAX_APPS);
    settings.spaces.truncate(MAX_SPACES);
    settings
}

/// Makes `dir` (and its parents) and checks it is a real folder of this user, readable by nobody else (`0700`).
pub(crate) fn private_dir(dir: &Path) -> HostResult<()> {
    std::fs::create_dir_all(dir).map_err(|e| HostError::io(&e, "mkdir", &dir.to_string_lossy()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let meta = std::fs::symlink_metadata(dir).map_err(|e| HostError::io(&e, "lstat", &dir.to_string_lossy()))?;
        if !meta.is_dir() || meta.uid() != rustix::process::geteuid().as_raw() {
            return Err(HostError::new("UNAVAILABLE", format!("{} is not a folder of this user", dir.display())));
        }
        if meta.mode() & 0o777 != 0o700 {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| HostError::io(&e, "chmod", &dir.to_string_lossy()))?;
        }
    }
    Ok(())
}

/// Replaces `path` atomically with an owner-only file.
fn write_private(path: &Path, bytes: &[u8]) -> HostResult<()> {
    use std::io::Write;
    let tmp = path.with_extension(format!("tmp-{}", &new_handle("t")?[2..10]));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    let renamed = written.and_then(|()| std::fs::rename(&tmp, path));
    renamed.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        HostError::io(&e, "write", &path.to_string_lossy())
    })
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_names_show_as_they_are() {
        assert_eq!(app_name("Claude Desktop").as_deref(), Some("Claude Desktop"));
        assert_eq!(app_name("  Cursor\t\n IDE ").as_deref(), Some("Cursor IDE"));
        assert_eq!(app_name("Safe\u{202E}gnp.exe").as_deref(), Some("Safegnp.exe"));
        assert_eq!(app_name("a\u{200B}b\u{FEFF}c\u{0000}").as_deref(), Some("abc"));
        assert_eq!(app_name("โธธ แอป").as_deref(), Some("โธธ แอป"));
        assert_eq!(app_name("\u{200B} \u{0007}"), None);
        assert_eq!(app_name(&"x".repeat(100)).map(|n| n.chars().count()), Some(64));
    }
}
