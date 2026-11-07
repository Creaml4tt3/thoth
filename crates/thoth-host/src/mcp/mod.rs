//! Connected apps (ADR-0021): other apps on this computer read the Private Spaces the user shares, through the MCP
//! server `thoth-mcp` that they start. `thoth-mcp` opens no vault: it relays each tool call over a local socket to
//! this host, which checks it, asks the user about an app it has not seen, and has the window that holds the Private
//! Space answer from its open `Vault` (one index per window, ADR-0019). Apps read, and they may propose changes
//! (ADR-0048), which the host keeps (`proposals.rs`) until the user reviews them in a window. The one exception is the
//! memory folder (ADR-0052): `remember`, `update_memory` and `forget` write there without review while the user's
//! switches allow it, within limits, and each such write is kept in the history (`memory.rs`) for Undo.
//!
//! Off by default. What is shared (the switch, the Private Spaces, each app's Allow or Deny) is kept in
//! `<data>/mcp/settings.json`; every request is logged in `<data>/mcp/log/` (`log.rs`).
//!
//! An app is known by the name it gives (MCP `clientInfo.name`). That name is self-reported: any program of this
//! user can give any name. Allow and Deny are the user's consent for a name, not proof of who connects; the socket
//! being the user's own (`0600` in a `0700` folder) is what keeps other users out.
pub mod log;
pub mod memory;
pub mod proposals;
mod socket;
pub mod tools;

use crate::EventSink;
use crate::error::{HostError, HostResult};
use crate::handles::new_handle;
use log::Log;
use memory::History;
use proposals::{Kind, Proposals, Status};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use socket::Listener;
use std::collections::{BTreeMap, HashMap};
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
/// Sent to the windows when the apps waiting for an answer change (Allow or Deny, or "May propose changes"). Payload:
/// `{ apps: [name], proposers: [name], folders: [root] }`.
pub const PENDING_EVENT: &str = "mcp.pending";
/// Sent to the windows when proposals are added or settled. Payload: `{ open }`, how many wait for review.
pub const PROPOSALS_EVENT: &str = "mcp.proposals";
/// Sent to the windows when an app saved, changed or forgot a memory without review (ADR-0052 rule 5). Payload:
/// `{ app, action, root, space, path, title }`.
pub const MEMORIES_EVENT: &str = "mcp.memories";
/// Longest request line from `thoth-mcp`: a proposed page of 1 MB (ADR-0048), JSON-escaped, and the rest of the call.
pub const MAX_REQUEST: usize = 2 * MAX_RESPONSE + 64 * 1024;
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    enabled: bool,
    /// Canonical roots, each shared by the user.
    #[serde(default)]
    spaces: Vec<String>,
    #[serde(default)]
    apps: Vec<App>,
    /// "Agents save memories without asking" (ADR-0052 rule 5): on by default.
    #[serde(default = "on")]
    memories: bool,
    /// The memory folder of each Private Space (canonical root → folder), recorded the first time an app used memory
    /// there (ADR-0052 rule 1).
    #[serde(default)]
    memory_folders: BTreeMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: false, spaces: Vec::new(), apps: Vec::new(), memories: true, memory_folders: BTreeMap::new() }
    }
}

fn on() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct App {
    name: String,
    allowed: bool,
    decided_at: String,
    /// "May propose changes" (ADR-0048): None until the user answers, asked the first time the app proposes.
    #[serde(default)]
    propose: Option<bool>,
    /// "Save memories without asking" for this app (ADR-0052 rule 5): None is on, the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remember: Option<bool>,
}

struct Waiting {
    owner: String,
    answer: SyncSender<HostResult<Value>>,
}

struct State {
    settings: Settings,
    /// Apps that asked and wait for Allow or Deny, oldest first.
    pending: Vec<String>,
    /// Allowed apps that proposed a change and wait for "May propose changes", oldest first.
    proposers: Vec<String>,
    /// Private Spaces (canonical roots) whose `Memory` folder is the user's own: a window asks which folder agents use.
    folders: Vec<String>,
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
    proposals: Proposals,
    history: History,
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
        let proposals = Proposals::new(dir.as_deref(), Arc::new(log::now_secs));
        let history = History::new(dir.as_deref(), Arc::new(log::now_secs));
        let state = State { settings, pending: Vec::new(), proposers: Vec::new(), folders: Vec::new(), waiting: HashMap::new(), error: None };
        let relay = Self {
            inner: Arc::new(Inner { dir, events, spaces, options, state: Mutex::new(state), decided: Condvar::new(), log, proposals, history }),
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
        let apps: Vec<Value> = state
            .settings
            .apps
            .iter()
            .map(|a| json!({ "name": a.name, "allowed": a.allowed, "decidedAt": a.decided_at, "propose": a.propose, "remember": a.remember.unwrap_or(true) }))
            .collect();
        json!({
            "available": cfg!(unix) && self.inner.dir.is_some(),
            "enabled": state.settings.enabled,
            "listening": listening,
            "error": state.error,
            "spaces": state.settings.spaces,
            "apps": apps,
            "pending": state.pending,
            "proposers": state.proposers,
            "memories": state.settings.memories,
            "memoryFolders": state.settings.memory_folders,
            "folders": state.folders,
            "setup": self.setup(),
        })
    }

    /// `mcp.configure { enabled?, spaces?, memories? }`. `spaces` replaces the shared list; each must be in `opened` (the
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
        match args.get("memories") {
            None | Some(Value::Null) => {}
            Some(Value::Bool(on)) => {
                let mut state = self.inner.state();
                state.settings.memories = *on;
                self.inner.save(&state.settings)?;
            }
            Some(_) => return Err(HostError::bad_argument("memories must be a boolean")),
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
            match known {
                Some(i) => {
                    let app = &mut state.settings.apps[i];
                    app.allowed = allow;
                    app.decided_at = log::timestamp();
                }
                None => state.settings.apps.push(App { name: name.clone(), allowed: allow, decided_at: log::timestamp(), propose: None, remember: None }),
            }
            state.pending.retain(|p| p != &name);
            if !allow {
                // An app that may not read is not asked whether it may propose either.
                state.proposers.retain(|p| p != &name);
            }
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
            state.proposers.retain(|p| p != &name);
            self.inner.save(&state.settings)?;
        }
        self.inner.decided.notify_all();
        self.inner.emit_pending();
        Ok(self.settings())
    }

    /// `mcp.mayPropose { app, allow }`: the per-app switch "May propose changes" (ADR-0048), and the answer to the
    /// question asked when an allowed app first proposes.
    pub fn may_propose(&self, app: &str, allow: bool) -> HostResult<Value> {
        let name = app_name(app).ok_or_else(|| HostError::bad_argument("app must be an app's name"))?;
        {
            let mut state = self.inner.state();
            let known =
                state.settings.apps.iter_mut().find(|a| a.name == name).ok_or_else(|| HostError::bad_argument(format!("No app called {name:?} connected")))?;
            known.propose = Some(allow);
            state.proposers.retain(|p| p != &name);
            self.inner.save(&state.settings)?;
        }
        self.inner.decided.notify_all();
        self.inner.emit_pending();
        Ok(self.settings())
    }

    /// The per-app switch "Save memories without asking" (ADR-0052 rule 5). Off, the app's memories wait for review.
    pub fn may_remember(&self, app: &str, allow: bool) -> HostResult<Value> {
        let name = app_name(app).ok_or_else(|| HostError::bad_argument("app must be an app's name"))?;
        {
            let mut state = self.inner.state();
            let known =
                state.settings.apps.iter_mut().find(|a| a.name == name).ok_or_else(|| HostError::bad_argument(format!("No app called {name:?} connected")))?;
            known.remember = Some(allow);
            self.inner.save(&state.settings)?;
        }
        Ok(self.settings())
    }

    /// `mcp.memoryFolder { root, folder }` from the window `owner`, which must have that Private Space open: the folder
    /// agents use for memory there (ADR-0052 rule 1), the user's answer when Thoth found a `Memory` folder of their own.
    pub fn memory_folder(&self, owner: &str, root: &str, folder: &str) -> HostResult<Value> {
        let folder = tools::memory_folder(folder)?;
        if !(self.inner.spaces)().iter().any(|s| s.owner == owner && s.root.to_string_lossy() == root) {
            return Err(HostError::not_allowed("Only a window with this Private Space open can choose its memory folder"));
        }
        {
            let mut state = self.inner.state();
            state.settings.memory_folders.insert(root.to_owned(), folder);
            state.folders.retain(|r| r != root);
            self.inner.save(&state.settings)?;
        }
        self.inner.decided.notify_all();
        self.inner.emit_pending();
        Ok(self.settings())
    }

    /// `mcp.memoryHistory { id? }` from the window `owner`: the memory writes of the last 30 days in the Private Spaces
    /// it has open, newest first (without text); with `id`, one of them with the text before and after, for Undo.
    pub fn memory_history(&self, owner: &str, id: Option<&str>) -> HostResult<Value> {
        let open: Vec<String> = (self.inner.spaces)().iter().filter(|s| s.owner == owner).map(|s| s.root.to_string_lossy().into_owned()).collect();
        let Some(id) = id else {
            let list = self.inner.history.list();
            let mine = list.iter().rev().filter(|c| open.contains(&c.root));
            return Ok(json!({ "changes": mine.map(memory::Change::to_json).collect::<Vec<_>>() }));
        };
        let (change, before, after) = self.inner.history.get(id)?;
        if !open.contains(&change.root) {
            return Err(HostError::not_allowed("Only a window with this Private Space open can read its memory history"));
        }
        let mut out = change.to_json();
        out["before"] = json!(before);
        out["after"] = json!(after);
        Ok(out)
    }

    /// `mcp.proposals`: every proposal remembered (without text), oldest first, and how many wait for review.
    pub fn proposals(&self) -> Value {
        let list = self.inner.proposals.list();
        let open = list.iter().filter(|r| r.status.open()).count();
        json!({ "proposals": list.iter().map(proposals::Record::to_json).collect::<Vec<_>>(), "open": open })
    }

    /// `mcp.proposal { id }`: one proposal, with the page as it was and as proposed while it waits.
    pub fn proposal(&self, id: &str) -> HostResult<Value> {
        let (record, before, after) = self.inner.proposals.get(id)?;
        let mut out = record.to_json();
        out["before"] = json!(before);
        out["after"] = json!(after);
        Ok(out)
    }

    /// `mcp.settle { id, status }` from the window `owner`, which must have the proposal's Private Space open: it
    /// applied the proposal (with compare-and-swap), the user declined it, or the page had changed (conflicted).
    pub fn settle(&self, owner: &str, id: &str, status: &str) -> HostResult<Value> {
        let status = match status {
            "applied" => Status::Applied,
            "declined" => Status::Declined,
            "conflicted" => Status::Conflicted,
            _ => return Err(HostError::bad_argument("status must be applied, declined or conflicted")),
        };
        let root = self
            .inner
            .proposals
            .list()
            .into_iter()
            .find(|r| r.id == id)
            .map(|r| r.root)
            .ok_or_else(|| HostError::new("NOT_FOUND", format!("No proposal {id}")))?;
        if !(self.inner.spaces)().iter().any(|s| s.owner == owner && s.root.to_string_lossy() == root.as_str()) {
            return Err(HostError::not_allowed("Only a window with this Private Space open can settle its proposals"));
        }
        let record = self.inner.proposals.settle(id, status)?;
        self.inner.emit_proposals();
        Ok(record.to_json())
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
        let (apps, proposers, folders) = {
            let state = self.state();
            (state.pending.clone(), state.proposers.clone(), state.folders.clone())
        };
        (self.events)(PENDING_EVENT, json!({ "apps": apps, "proposers": proposers, "folders": folders }));
    }

    fn emit_proposals(&self) {
        (self.events)(PROPOSALS_EVENT, json!({ "open": self.proposals.open() }));
    }

    /// Switched off or quitting: the apps waiting for an answer are no longer asked about.
    fn end_waits(&self) {
        let had = {
            let mut state = self.state();
            let had = !state.pending.is_empty() || !state.proposers.is_empty() || !state.folders.is_empty();
            state.pending.clear();
            state.proposers.clear();
            state.folders.clear();
            had
        };
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
        if call.about_proposals() {
            let answer = self.about_proposals(&app, &call)?;
            entry.paths = answer.paths.clone();
            return Ok(answer);
        }
        if call.is_proposal() {
            self.permit_propose(&app)?;
        }
        let targets = self.targets(&call)?;
        entry.spaces = targets.iter().map(|t| t.label.clone()).collect();
        let mut folders = Vec::new();
        if call.is_memory() {
            for target in &targets {
                folders.push(self.memory_folder_of(target)?);
            }
        }
        if call.is_memory_write() {
            tools::check_memory_page(&call, &folders[0])?;
            let answer = self.memory_write(&app, &call, &targets[0], &folders[0])?;
            entry.paths = answer.paths.clone();
            return Ok(answer);
        }

        let deadline = Instant::now() + self.options.answer_timeout;
        let mut asked: Vec<(String, Receiver<HostResult<Value>>)> = Vec::new();
        for (i, target) in targets.iter().enumerate() {
            let mut args = call.window_args();
            if let Some(folder) = folders.get(i) {
                args["folder"] = json!(folder);
            }
            match self.ask_window(target, call.window_tool(), args) {
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
                // A new page is proposed where there is none.
                Ok(Err(error)) if error.code == "NOT_FOUND" && matches!(call, Call::ProposeCreate { .. }) => values.push(Value::Null),
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
        if call.is_proposal() {
            let answer = self.propose(&app, &call, &targets[0], &values[0])?;
            entry.paths = answer.paths.clone();
            return Ok(answer);
        }
        let found: Vec<Found<'_>> = targets.iter().zip(&values).map(|(t, value)| Found { space: &t.label, value }).collect();
        let answer = tools::answer(&call, &found)?;
        entry.paths = answer.paths.clone();
        Ok(answer)
    }

    /// Waits until `app` may read (allowed), or says why not. An app never seen is added to the apps waiting for the
    /// user's answer, and the windows are told; the request waits for that answer up to `prompt_timeout`.
    fn permit(&self, app: &str) -> HostResult<()> {
        let denied = || HostError::new("DENIED", format!("{app} may not read your notes: allow it in Thoth, under Settings → Connected apps"));
        self.wait_for(
            app,
            |settings| settings.apps.iter().find(|a| a.name == app).map(|known| if known.allowed { Ok(()) } else { Err(denied()) }),
            |state| &mut state.pending,
            denied,
            || HostError::not_allowed(format!("Thoth is asking whether {app} may read your notes: answer in Thoth's window, then try again")),
        )
    }

    /// Waits until the allowed `app` may propose changes ("May propose changes", ADR-0048). Asked once, the first
    /// time it proposes, as `permit` asks; off until the user turns it on.
    fn permit_propose(&self, app: &str) -> HostResult<()> {
        let refused = || {
            HostError::new("DENIED", format!("{app} may not propose changes: turn on “May propose changes” for it in Thoth, under Settings → Connected apps"))
        };
        self.wait_for(
            app,
            |settings| match settings.apps.iter().find(|a| a.name == app) {
                None | Some(App { allowed: false, .. }) => Some(Err(refused())),
                Some(known) => known.propose.map(|on| if on { Ok(()) } else { Err(refused()) }),
            },
            |state| &mut state.proposers,
            refused,
            || HostError::not_allowed(format!("Thoth is asking whether {app} may propose changes: answer in Thoth's window, then try again")),
        )
    }

    /// The question both permissions share: `decided` says the answer once there is one; until then the app waits in
    /// `queue` (the windows are told) for up to `prompt_timeout`.
    fn wait_for(
        &self,
        app: &str,
        decided: impl Fn(&Settings) -> Option<HostResult<()>>,
        queue: fn(&mut State) -> &mut Vec<String>,
        gone: impl Fn() -> HostError,
        timed_out: impl Fn() -> HostError,
    ) -> HostResult<()> {
        let deadline = Instant::now() + self.options.prompt_timeout;
        let mut state = self.state();
        let mut asked = false;
        loop {
            if !state.settings.enabled {
                return Err(HostError::new("NOT_ENABLED", "Connected apps are off: open Thoth and switch on Connected apps in Settings"));
            }
            if let Some(answer) = decided(&state.settings) {
                return answer;
            }
            if !queue(&mut state).iter().any(|p| p == app) {
                if asked {
                    // It was waiting and is gone without a decision: forgotten, or Connected apps went off.
                    return Err(gone());
                }
                if state.pending.len() + state.proposers.len() + state.folders.len() >= MAX_PENDING
                    || state.settings.apps.len() + state.pending.len() >= MAX_APPS
                {
                    return Err(HostError::new(
                        "BUSY",
                        "Too many apps are waiting for an answer in Thoth: answer them, or remove some under Settings → Connected apps",
                    ));
                }
                queue(&mut state).push(app.to_owned());
                drop(state);
                self.emit_pending();
                state = self.state();
            }
            asked = true;
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(timed_out());
            }
            state = self.decided.wait_timeout(state, left).unwrap_or_else(|p| p.into_inner()).0;
        }
    }

    /// Keeps a proposal (ADR-0048) made from `found`, the window's `read_page` answer (null: no page at that path),
    /// and answers at once with its id. Nothing is written: the user reviews it in a window.
    fn propose(&self, app: &str, call: &Call, target: &Target, found: &Value) -> HostResult<tools::Answer> {
        let malformed = || HostError::internal("Thoth's window sent an answer it should not have");
        // The text an addition to a new page goes after (today's note as the window would start it).
        let mut start_text: Option<String> = None;
        let (kind, path, page_id, base_hash, before) = match call {
            Call::ProposeCreate { path, .. } => {
                if !found.is_null() {
                    return Err(HostError::new("EXISTS", format!("{path} is already a page: propose an edit instead, or another path")));
                }
                (Kind::Create, path.clone(), None, None, None)
            }
            // Today's note does not exist yet: a new page, as the window would start it (its template), with the addition.
            Call::ProposeAppend { page: tools::PageRef::Today, .. } if found.get("page").is_some_and(Value::is_null) => {
                let today = found.get("today").ok_or_else(malformed)?;
                let path = today.get("path").and_then(Value::as_str).map(str::to_owned).ok_or_else(malformed)?;
                let start = today.get("markdown").and_then(Value::as_str).map(str::to_owned).ok_or_else(malformed)?;
                tools::check_new_page(&path).map_err(|_| malformed())?;
                start_text = Some(start);
                (Kind::Create, path, None, None, None)
            }
            _ => {
                let page = found.get("page").ok_or_else(malformed)?;
                let text = |key: &str| page.get(key).and_then(Value::as_str).map(str::to_owned).ok_or_else(malformed);
                let path = text("path")?;
                if path.split('/').any(|part| part.starts_with('.')) {
                    return Err(HostError::bad_argument("Pages in hidden folders cannot be changed"));
                }
                let kind = if matches!(call, Call::ProposeAppend { .. }) { Kind::Append } else { Kind::Edit };
                (kind, path, Some(text("id")?), Some(text("hash")?), Some(text("markdown")?))
            }
        };
        let expected = match call {
            Call::ProposeEdit { expected, .. } | Call::ProposeAppend { expected, .. } => expected.as_deref(),
            _ => None,
        };
        if let Some(expected) = expected
            && Some(expected) != base_hash.as_deref()
        {
            return Err(HostError::new("CONFLICT", format!("{path} changed since version {expected}: read it again, then propose the change again")));
        }
        let after = tools::proposed_text(call, before.as_deref().or(start_text.as_deref()))?;
        if after.len() > tools::MAX_MARKDOWN {
            return Err(HostError::new("TOO_LARGE", "The page would be over 1 MB: propose a smaller change"));
        }
        if before.as_deref() == Some(after.as_str()) {
            return Err(HostError::bad_argument("That would not change the page"));
        }
        let record = self.proposals.add(proposals::New {
            app: app.to_owned(),
            kind,
            root: target.root.clone(),
            space: target.label.clone(),
            path: path.clone(),
            page_id,
            base_hash,
            before,
            after,
        })?;
        self.emit_proposals();
        let what = match kind {
            Kind::Create if start_text.is_some() => "today's note, new,",
            Kind::Create => "a new page",
            Kind::Edit => "a change to",
            Kind::Append => "an addition to",
        };
        let text = format!(
            "Proposed {what} {path} in {}. It waits for the user's review in Thoth and nothing is written until they apply it. Proposal {} (pending); check it later with get_proposal.",
            target.label, record.id
        );
        let structured =
            json!({ "id": record.id, "status": "pending", "space": target.label, "path": path, "expiresAt": log::iso(record.created + proposals::KEEP_SECS) });
        Ok(tools::Answer { text, structured, paths: vec![path] })
    }

    /// `list_proposals` and `get_proposal`: what happened to this app's own proposals. Never their text.
    fn about_proposals(&self, app: &str, call: &Call) -> HostResult<tools::Answer> {
        let mine: Vec<proposals::Record> = self.proposals.list().into_iter().filter(|r| r.app == app).collect();
        let shown = |r: &proposals::Record| {
            let mut out = r.to_json();
            if let Some(map) = out.as_object_mut() {
                for private in ["root", "app", "baseHash"] {
                    map.remove(private);
                }
            }
            out
        };
        let (structured, paths) = match call {
            Call::ListProposals { status, limit } => {
                let chosen: Vec<&proposals::Record> = mine.iter().rev().filter(|r| status.as_deref().is_none_or(|s| s == r.status.name())).collect();
                let total = chosen.len();
                let listed: Vec<&proposals::Record> = chosen.into_iter().take(*limit as usize).collect();
                let paths = listed.iter().map(|r| r.path.clone()).take(tools::LOGGED_PATHS).collect();
                (json!({ "proposals": listed.iter().map(|r| shown(r)).collect::<Vec<_>>(), "total": total }), paths)
            }
            Call::GetProposal { id } => {
                let record = mine.iter().find(|r| &r.id == id).ok_or_else(|| HostError::new("NOT_FOUND", format!("No proposal {id} from {app}")))?;
                (shown(record), vec![record.path.clone()])
            }
            _ => return Err(HostError::internal("Not about proposals")),
        };
        Ok(tools::Answer { text: serde_json::to_string_pretty(&structured).unwrap_or_default(), structured, paths })
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
    fn ask_window(&self, target: &Target, tool: &str, args: Value) -> HostResult<(String, Receiver<HostResult<Value>>)> {
        let id = new_handle("mcp")?;
        let (tx, rx) = sync_channel(1);
        self.state().waiting.insert(id.clone(), Waiting { owner: target.owner.clone(), answer: tx });
        (self.events)(REQUEST_EVENT, json!({ "id": id, "owner": target.owner, "root": target.root, "space": target.label, "tool": tool, "args": args }));
        Ok((id, rx))
    }

    /// Asks `target`'s window and waits for its answer.
    fn request(&self, target: &Target, tool: &str, args: Value) -> HostResult<Value> {
        let waiting = self.ask_window(target, tool, args)?;
        let answer = waiting.1.recv_timeout(self.options.answer_timeout);
        self.forget_waits(std::slice::from_ref(&waiting));
        answer.unwrap_or_else(|_| Err(HostError::new("TIMEOUT", "Thoth did not answer in time: try again")))
    }

    /// The memory folder of `target` (ADR-0052 rule 1). The first time, `Memory` is recorded if it is empty or Thoth set
    /// it up; if it holds pages of the user's own, the windows ask which folder agents should use, and the request waits
    /// for that answer (up to `prompt_timeout`) as it waits for Allow or Deny.
    fn memory_folder_of(&self, target: &Target) -> HostResult<String> {
        let recorded = |settings: &Settings| settings.memory_folders.get(&target.root).cloned();
        if let Some(folder) = recorded(&self.state().settings) {
            return Ok(folder);
        }
        let found = self.request(target, "memory_folder", json!({ "folder": tools::MEMORY_FOLDER }))?;
        let pages = found.get("pages").and_then(Value::as_u64).ok_or_else(|| HostError::internal("Thoth's window sent an answer it should not have"))?;
        let thoth = found.get("thoth").and_then(Value::as_bool).unwrap_or(false);
        if pages == 0 || thoth {
            let mut state = self.state();
            let folder = state.settings.memory_folders.entry(target.root.clone()).or_insert_with(|| tools::MEMORY_FOLDER.to_owned()).clone();
            self.save(&state.settings)?;
            return Ok(folder);
        }
        let space = &target.label;
        self.wait_for(
            &target.root,
            |settings| recorded(settings).map(|_| Ok(())),
            |state| &mut state.folders,
            || HostError::not_allowed(format!("Thoth asked which folder agents may use for memory in {space}, and it was not answered: try again")),
            || {
                HostError::not_allowed(format!(
                    "{space} already has a Memory folder of the user's own: Thoth is asking which folder agents should use. Tell the user to answer in Thoth's window, then try again"
                ))
            },
        )?;
        recorded(&self.state().settings).ok_or_else(|| HostError::internal("The memory folder was not recorded"))
    }

    /// `remember`, `update_memory` or `forget` (ADR-0052 rules 5 and 6): the window works the change out, the host checks
    /// it, then has the window write it without review if the user's switches allow it, or keeps it as a proposal.
    fn memory_write(&self, app: &str, call: &Call, target: &Target, folder: &str) -> HostResult<tools::Answer> {
        let mut args = call.memory_change_args(app);
        args["folder"] = json!(folder);
        let change = tools::memory_change(&self.request(target, "memory_change", args)?, folder)?;
        let paths = vec![change.path.clone()];
        if change.before == change.after {
            let structured = json!({ "status": "unchanged", "space": target.label, "path": change.path, "id": change.id });
            return Ok(tools::Answer { text: format!("{} already says this; nothing changed.", change.path), structured, paths });
        }
        let without_review = {
            let state = self.state();
            state.settings.memories && state.settings.apps.iter().find(|a| a.name == app).is_some_and(|a| a.remember != Some(false))
        };
        if !without_review {
            if change.op == "forget" {
                return Err(HostError::new(
                    "DENIED",
                    format!("Saving memories without asking is off for {app}: ask the user to delete {} in Thoth", change.path),
                ));
            }
            let create = change.op == "create";
            let record = self.proposals.add(proposals::New {
                app: app.to_owned(),
                kind: if create { Kind::Create } else { Kind::Edit },
                root: target.root.clone(),
                space: target.label.clone(),
                path: change.path.clone(),
                page_id: (!create).then(|| change.id.clone()),
                base_hash: change.base_hash.clone(),
                before: change.before.clone(),
                after: change.after.clone().unwrap_or_default(),
            })?;
            self.emit_proposals();
            let text = format!(
                "The user reviews memories from {app} before they are saved: this one waits in Thoth as proposal {} (pending). Nothing is saved until they apply it.",
                record.id
            );
            let structured = json!({ "status": "pending", "proposal": record.id, "space": target.label, "path": change.path, "expiresAt": log::iso(record.created + proposals::KEEP_SECS) });
            return Ok(tools::Answer { text, structured, paths });
        }
        if self.history.today(app) >= memory::DAILY_LIMIT {
            return Err(HostError::new(
                "BUSY",
                format!("{app} saved {} memories without review today, the most it may: save only what matters, and try again tomorrow", memory::DAILY_LIMIT),
            ));
        }
        let commit = match &change.after {
            Some(after) => json!({ "op": "write", "path": change.path, "text": after, "expected": change.base_hash, "folder": folder }),
            None => json!({ "op": "trash", "path": change.path, "expected": change.base_hash, "folder": folder }),
        };
        let written = self.request(target, "memory_commit", commit)?;
        let after_hash = match change.after {
            Some(_) => Some(
                written
                    .get("hash")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| HostError::internal("Thoth's window sent an answer it should not have"))?,
            ),
            None => None,
        };
        let action = match change.op.as_str() {
            "create" => memory::Action::Created,
            "update" => memory::Action::Updated,
            _ => memory::Action::Forgot,
        };
        // Written either way: a history that could not be kept only loses Undo for this one.
        let _ = self.history.add(memory::New {
            app: app.to_owned(),
            action,
            root: target.root.clone(),
            space: target.label.clone(),
            path: change.path.clone(),
            page_id: change.id.clone(),
            title: change.title.clone(),
            before_hash: change.base_hash.clone(),
            after_hash: after_hash.clone(),
            before: change.before.clone(),
            after: change.after.clone(),
        });
        (self.events)(
            MEMORIES_EVENT,
            json!({ "app": app, "action": action, "root": target.root, "space": target.label, "path": change.path, "title": change.title }),
        );
        let (status, said) = match action {
            memory::Action::Created => ("saved", "Saved"),
            memory::Action::Updated => ("saved", "Updated"),
            memory::Action::Forgot => ("forgotten", "Forgot"),
        };
        let mut structured = json!({ "status": status, "space": target.label, "path": change.path, "id": change.id });
        if let Some(hash) = after_hash {
            structured["version"] = json!(hash);
        }
        let text = match action {
            memory::Action::Forgot => format!("Forgot {}: it is in the system Trash, and will not be saved again.", change.path),
            _ => format!("{said} {} in {}.", change.path, target.label),
        };
        Ok(tools::Answer { text, structured, paths })
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
        // The memory tools' refusals (ADR-0052), which tell the app what to do instead.
        Some("BAD_ARGUMENT") => HostError::new("BAD_ARGUMENT", message),
        Some("CONFLICT") => HostError::new("CONFLICT", message),
        Some("FORGOTTEN") => HostError::new("FORGOTTEN", message),
        Some("STATED") => HostError::new("STATED", message),
        Some("TOO_LARGE") => HostError::new("TOO_LARGE", message),
        Some("TOO_MANY") => HostError::new("TOO_MANY", message),
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
