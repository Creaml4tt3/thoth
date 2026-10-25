//! Native host for Thoth's platform ports (ADR-0008, Decision 5).
//!
//! `Host::call` is one transport-independent dispatch for every command in
//! `packages/platform/src/ipc.ts`. The Tauri shell and the stdio test harness
//! are thin adapters over it. The caller (the webview) is untrusted:
//!
//! - Vault roots and import sources open only if the user picked them in this
//!   process, the root is in the host's own recent list, or the embedder
//!   allowed it explicitly; roots are canonicalized and system/home roots are
//!   refused.
//! - Every later call names an opaque, unguessable handle; handles are typed by
//!   prefix and file handles are bound to the source that opened them.
//! - Paths are vault/source-relative and resolved with `openat` from a root
//!   directory fd that is held for the life of the handle.
//! - Workspace servers are reached only by the host (`remote`): the webview names a server by its handle and
//!   never receives an access token, refresh token or personal access token.
//! - Agent CLIs (`agent`, ADR-0007) run only as a known provider's binary found by the host, with an argument list
//!   the provider's policy accepts, in a private working directory under the data folder.
//!
//! On Windows the file layer is `win/` (`NtCreateFile` relative to a directory handle, reparse points refused),
//! `vault_fs_windows.rs` and `source_windows.rs`, with the same module names and contract.
pub mod agent;
#[cfg(unix)]
mod at;
pub mod error;
mod handles;
pub mod links;
pub mod paths;
pub mod remote;
#[cfg_attr(windows, path = "source_windows.rs")]
pub mod source;
pub mod sql;
pub mod updates;
#[cfg_attr(windows, path = "vault_fs_windows.rs")]
pub mod vault_fs;
pub mod watch;
#[cfg(windows)]
mod win;

pub use error::{HostError, HostResult};
pub use remote::{Browser, KEYCHAIN_SERVICE, MemorySecretStore, SecretStore};

use agent::Agents;
use links::{LinkOptions, LinkPreviews};
use paths::{canonical, canonicalize_path, check_root_policy};
use remote::Remote;
#[cfg(unix)]
use rustix::fs::{Mode, OFlags};
use serde_json::{Value, json};
use source::{OpenFile, Source};
use sql::Sql;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use updates::{UpdateOptions, Updates};
use vault_fs::VaultFs;
use watch::Watcher;

/// Every command name in the contract (`Commands` in ipc.ts).
pub const COMMANDS: &[&str] = &[
    "vault.pick", "vault.recent", "vault.open", "vault.close", "vault.reveal", "vault.shared",
    "fs.stat", "fs.read", "fs.list", "fs.mkdirp", "fs.write", "fs.rename", "fs.remove",
    "sql.exec", "sql.run", "sql.all", "sql.get",
    "watch.start", "watch.stop",
    "source.pick", "source.open", "source.list", "source.file.open", "source.file.read", "source.file.close",
    "source.temp.create", "source.temp.write", "source.close",
    "server.list", "server.add", "server.remove", "server.signIn", "server.signInCancel", "server.useToken", "server.signOut",
    "api.call",
    "agent.detect", "agent.run.create", "agent.fs.stat", "agent.fs.read", "agent.fs.list", "agent.fs.mkdirp", "agent.fs.write",
    "agent.start", "agent.events", "agent.cancel", "agent.run.dispose", "agent.sweep",
    "agent.history.write", "agent.history.read", "agent.history.list", "agent.history.delete",
    "link.preview", "link.preview.clear", "link.open",
    "update.check", "update.settings",
];

pub const VAULT_CHANGED: &str = "vault.changed";
const MAX_OPEN_VAULTS: usize = 64;
const MAX_OPEN_SOURCES: usize = 64;
const MAX_RECENT: usize = 20;

/// Native pickers. The desktop shell shows dialogs; the harness returns fixed paths.
pub trait Picker: Send + Sync {
    fn pick_vault(&self) -> Option<PathBuf>;
    fn pick_source(&self, directory: bool) -> Option<PathBuf>;
}

/// Shows an open vault's folder in the system file manager (Finder, File Explorer, Files). The desktop shell
/// launches it; the harness and tests record the path. `root` is always the canonical root of an open vault.
pub trait FileManager: Send + Sync {
    fn reveal(&self, root: &Path) -> HostResult<()>;
}

/// Receives host events (`vault.changed` with its JSON payload).
pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub struct HostConfig {
    /// Where the recent-vaults list is persisted. `None` keeps it in memory only.
    pub data_dir: Option<PathBuf>,
    /// Roots the embedder trusts outright (test harness); they and their descendants may be opened.
    pub allow_roots: Vec<PathBuf>,
    pub picker: Arc<dyn Picker>,
    pub events: EventSink,
    /// Test hook: make `link()` fail so no-replace rename takes the exclusive-copy fallback.
    pub disable_hardlink: bool,
    /// Refresh tokens and personal access tokens of workspace servers (the OS keychain on desktop).
    pub secrets: Arc<dyn SecretStore>,
    /// Opens the browser for server sign-in.
    pub browser: Arc<dyn Browser>,
    /// Shows a vault folder in the file manager (`vault.reveal`).
    pub file_manager: Arc<dyn FileManager>,
    /// Test hook (stdio harness only): search only these folders for agent CLIs instead of `PATH` and the usual
    /// install locations. The desktop shell always passes `None`.
    pub agent_search_dirs: Option<Vec<PathBuf>>,
    /// Test hook (stdio harness only, `--link-preview-loopback`): link previews may fetch from loopback addresses (a
    /// local test server). Every other address rule still applies. The desktop shell always passes `false`.
    pub link_preview_loopback: bool,
}

struct VaultEntry {
    /// Who opened it (a window of the desktop app, ADR-0019; "" in the harness): `Host::release` closes it with the window.
    owner: String,
    root: PathBuf,
    fs: VaultFs,
    sql: Mutex<Sql>,
    watcher: Mutex<Option<Watcher>>,
}

struct FileEntry {
    source: String,
    file: Mutex<OpenFile>,
}

#[derive(Default)]
struct State {
    picked_vaults: HashSet<PathBuf>,
    picked_sources: HashSet<PathBuf>,
    vaults: HashMap<String, Arc<VaultEntry>>,
    sources: HashMap<String, Arc<Mutex<Source>>>,
    files: HashMap<String, Arc<FileEntry>>,
}

pub struct Host {
    config: HostConfig,
    home: Option<PathBuf>,
    allow_roots: Vec<PathBuf>,
    state: Mutex<State>,
    remote: Remote,
    agents: Agents,
    links: LinkPreviews,
    updates: Updates,
    /// One compare-and-rename (`fs.rename` with `replaceHash`) at a time, across every handle: two windows saving the
    /// same page cannot both pass the check (ADR-0019).
    replace: Mutex<()>,
}

type Reply = (Value, Option<Vec<u8>>);

impl Host {
    pub fn new(config: HostConfig) -> Self {
        let home = std::env::var_os(HOME_VAR).map(PathBuf::from).and_then(|h| canonicalize_path(&h).ok());
        let allow_roots = config.allow_roots.iter().filter_map(|r| canonicalize_path(r).ok()).collect();
        let remote = Remote::new(config.data_dir.clone(), config.secrets.clone(), config.browser.clone());
        let agents = Agents::new(config.data_dir.clone(), config.agent_search_dirs.clone());
        let links = LinkPreviews::new(config.data_dir.clone(), LinkOptions { allow_loopback: config.link_preview_loopback, ..LinkOptions::default() });
        let updates = Updates::new(config.data_dir.clone(), UpdateOptions::off());
        Self { config, home, allow_roots, state: Mutex::new(State::default()), remote, agents, links, updates, replace: Mutex::new(()) }
    }

    /// Turns the update notice on (ADR-0022): `options` name the running version and where `latest.json` is. A host
    /// built with `Host::new` alone has no notice and never makes that request. The test switch of link previews
    /// (`link_preview_loopback`) applies to it too, so a test can serve `latest.json` from a local server.
    #[must_use]
    pub fn with_updates(mut self, mut options: UpdateOptions) -> Self {
        options.allow_loopback = self.config.link_preview_loopback;
        self.updates = Updates::new(self.config.data_dir.clone(), options);
        self
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Dispatches one command. `bytes` is the out-of-band request body (`fs.write`, `source.temp.write`, `api.call`).
    pub fn call(&self, command: &str, args: &Value, bytes: Option<&[u8]>) -> HostResult<Reply> {
        self.call_as("", command, args, bytes)
    }

    /// `call`, made by `owner` (the label of the desktop window that asked). Vaults it opens and agent runs it creates
    /// are that owner's: `release(owner)` ends them when the window closes. Handles stay usable by any caller.
    pub fn call_as(&self, owner: &str, command: &str, args: &Value, bytes: Option<&[u8]>) -> HostResult<Reply> {
        let json = |v: Value| Ok((v, None));
        let null = || Ok((Value::Null, None));
        if !args.is_object() {
            return Err(HostError::bad_argument("Arguments must be an object"));
        }
        let wants_bytes = matches!(command, "fs.write" | "source.temp.write" | "api.call" | "agent.fs.write" | "agent.start" | "agent.history.write");
        if bytes.is_some() && !wants_bytes {
            return Err(HostError::bad_argument(format!("{command} takes no request bytes")));
        }
        match command {
            "vault.pick" => json(self.pick_vault()),
            "vault.recent" => json(json!(self.recent())),
            "vault.open" => json(self.open_vault(owner, str_arg(args, "root")?)?),
            "vault.close" => {
                self.close_vault(str_arg(args, "vault")?)?;
                null()
            }
            // Is another window open on this vault's folder right now? (ADR-0019) Its owner's other handles (a page that
            // reloaded) do not count.
            "vault.shared" => {
                let entry = self.vault(args)?;
                json(json!(self.shared_with_others(&entry.root, &entry.owner)))
            }
            // Names a vault by its handle, never a path: only a folder the user opened can be shown.
            "vault.reveal" => {
                let entry = self.vault(args)?;
                self.config.file_manager.reveal(&entry.root)?;
                null()
            }
            "fs.stat" => json(self.vault(args)?.fs.stat(str_arg(args, "path")?)?),
            "fs.read" => Ok((Value::Null, Some(self.vault(args)?.fs.read(str_arg(args, "path")?)?))),
            "fs.list" => json(self.vault(args)?.fs.list(str_arg(args, "dir")?)?),
            "fs.mkdirp" => {
                self.vault(args)?.fs.mkdirp(str_arg(args, "dir")?)?;
                null()
            }
            "fs.write" => {
                let data = bytes.ok_or_else(|| HostError::bad_argument("fs.write needs request bytes"))?;
                self.vault(args)?.fs.write(str_arg(args, "path")?, data, bool_arg(args, "exclusive")?)?;
                null()
            }
            "fs.rename" => {
                let vault = self.vault(args)?;
                let (from, to) = (str_arg(args, "from")?, str_arg(args, "to")?);
                match args.get("replaceHash") {
                    None | Some(Value::Null) => vault.fs.rename(from, to, bool_arg(args, "noReplace")?)?,
                    Some(Value::String(expected)) => {
                        let _one_at_a_time = lock(&self.replace);
                        let current = match vault.fs.read(to) {
                            Ok(bytes) => Some(hex_digest(&bytes)),
                            Err(e) if e.code == "ENOENT" => None,
                            Err(e) => return Err(e),
                        };
                        if current.as_deref() != Some(expected.as_str()) {
                            return Err(HostError::new("CONFLICT", format!("\"{to}\" changed before it could be replaced")));
                        }
                        vault.fs.rename(from, to, false)?;
                    }
                    Some(_) => return Err(HostError::bad_argument("replaceHash must be a string")),
                }
                null()
            }
            "fs.remove" => {
                self.vault(args)?.fs.remove(str_arg(args, "path")?)?;
                null()
            }
            "sql.exec" => {
                let vault = self.vault(args)?;
                lock(&vault.sql).exec(str_arg(args, "sql")?)?;
                null()
            }
            "sql.run" | "sql.all" | "sql.get" => {
                let vault = self.vault(args)?;
                let text = str_arg(args, "sql")?;
                let params = match args.get("params") {
                    None => &[][..],
                    Some(Value::Array(p)) => p.as_slice(),
                    Some(_) => return Err(HostError::bad_argument("params must be an array")),
                };
                let sql = lock(&vault.sql);
                json(match command {
                    "sql.run" => sql.run(text, params)?,
                    "sql.all" => sql.all(text, params)?,
                    _ => sql.get(text, params)?,
                })
            }
            "watch.start" => {
                self.watch_start(str_arg(args, "vault")?)?;
                null()
            }
            "watch.stop" => {
                lock(&self.vault(args)?.watcher).take();
                null()
            }
            "source.pick" => {
                let directory = match str_arg(args, "kind")? {
                    "file" => false,
                    "directory" => true,
                    _ => return Err(HostError::bad_argument("kind must be \"file\" or \"directory\"")),
                };
                json(self.pick_source(directory))
            }
            "source.open" => json(self.open_source(str_arg(args, "location")?)?),
            "source.list" => {
                let source = self.source(str_arg(args, "source")?)?;
                let listed = lock(&source).list(str_arg(args, "dir")?)?;
                json(listed)
            }
            "source.file.open" => {
                let id = str_arg(args, "source")?;
                let source = self.source(id)?;
                let file = lock(&source).open_file(str_arg(args, "path")?)?;
                let size = file.size;
                let handle = self.add_file(id, file)?;
                json(json!({ "file": handle, "size": size }))
            }
            "source.file.read" => {
                let entry = self.file(str_arg(args, "file")?)?;
                let position = u64_arg(args, "position")?;
                let length = usize::try_from(u64_arg(args, "length")?).map_err(|_| HostError::bad_argument("length is too large"))?;
                let data = lock(&entry.file).read(position, length)?;
                Ok((Value::Null, Some(data)))
            }
            "source.file.close" => {
                self.close_file(str_arg(args, "file")?)?;
                null()
            }
            "source.temp.create" => {
                let id = str_arg(args, "source")?;
                let source = self.source(id)?;
                let file = lock(&source).create_temp()?;
                json(json!({ "file": self.add_file(id, file)? }))
            }
            "source.temp.write" => {
                let data = bytes.ok_or_else(|| HostError::bad_argument("source.temp.write needs request bytes"))?;
                if data.len() as u64 > source::MAX_TEMP_BYTES {
                    return Err(HostError::bad_argument("Write is too large"));
                }
                let entry = self.file(str_arg(args, "file")?)?;
                lock(&entry.file).write(u64_arg(args, "position")?, data)?;
                null()
            }
            "source.close" => {
                self.close_source(str_arg(args, "source")?)?;
                null()
            }
            "server.list" => json(self.remote.list()),
            "server.add" => json(self.remote.add(str_arg(args, "url")?)?),
            "server.remove" => {
                self.remote.remove(str_arg(args, "server")?)?;
                null()
            }
            "server.signIn" => {
                let provider = match args.get("provider") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(p)) => Some(p.as_str()),
                    Some(_) => return Err(HostError::bad_argument("provider must be a string")),
                };
                json(self.remote.sign_in(str_arg(args, "server")?, provider)?)
            }
            "server.signInCancel" => {
                self.remote.cancel_sign_in(str_arg(args, "server")?)?;
                null()
            }
            "server.useToken" => json(self.remote.use_token(str_arg(args, "server")?, str_arg(args, "token")?)?),
            "server.signOut" => json(self.remote.sign_out(str_arg(args, "server")?)?),
            "api.call" => json(self.remote.api_call(args, bytes)?),
            "agent.detect" => json(self.agents.detect(str_arg(args, "provider")?, &self.open_roots())?),
            "agent.run.create" => json(self.agents.create_for(owner, str_arg(args, "provider")?)?),
            "agent.fs.stat" => json(self.agents.stat(str_arg(args, "run")?, str_arg(args, "path")?)?),
            "agent.fs.read" => Ok((Value::Null, Some(self.agents.read(str_arg(args, "run")?, str_arg(args, "path")?)?))),
            "agent.fs.list" => json(self.agents.list(str_arg(args, "run")?, str_arg(args, "dir")?)?),
            "agent.fs.mkdirp" => {
                self.agents.mkdirp(str_arg(args, "run")?, str_arg(args, "dir")?)?;
                null()
            }
            "agent.fs.write" => {
                let data = bytes.ok_or_else(|| HostError::bad_argument("agent.fs.write needs request bytes"))?;
                self.agents.write(str_arg(args, "run")?, str_arg(args, "path")?, data, bool_arg(args, "readOnly")?)?;
                null()
            }
            "agent.start" => {
                let argv = match args.get("argv") {
                    Some(Value::Array(items)) => items.iter().map(|v| v.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>().ok_or_else(|| HostError::bad_argument("argv must be strings"))?,
                    _ => return Err(HostError::bad_argument("argv must be an array")),
                };
                let timeout = match args.get("timeoutMs") {
                    None | Some(Value::Null) => None,
                    Some(_) => Some(u64_arg(args, "timeoutMs")?),
                };
                self.agents.start(str_arg(args, "run")?, &argv, bytes.unwrap_or_default(), timeout, &self.open_roots())?;
                null()
            }
            "agent.events" => json(self.agents.events(str_arg(args, "run")?, u64_arg(args, "after")?, u64_arg(args, "waitMs")?)?),
            "agent.cancel" => {
                self.agents.cancel(str_arg(args, "run")?)?;
                null()
            }
            "agent.run.dispose" => {
                self.agents.dispose(str_arg(args, "run")?)?;
                null()
            }
            "agent.sweep" => json(json!({ "removed": self.agents.sweep()? })),
            "agent.history.write" => {
                let data = bytes.ok_or_else(|| HostError::bad_argument("agent.history.write needs request bytes"))?;
                self.agents.history_write(str_arg(args, "id")?, str_arg(args, "name")?, data)?;
                null()
            }
            "agent.history.read" => Ok((Value::Null, Some(self.agents.history_read(str_arg(args, "id")?, str_arg(args, "name")?)?))),
            "agent.history.list" => json(self.agents.history_list()?),
            "agent.history.delete" => {
                self.agents.history_delete(str_arg(args, "id")?)?;
                null()
            }
            // Link previews (ADR-0020): the host fetches, under its own address and size rules; the webview gets text.
            "link.preview" => json(self.links.preview(str_arg(args, "url")?)?),
            "link.preview.clear" => {
                self.links.clear()?;
                null()
            }
            // Opens a web link in the system browser (the webview has no opener permission).
            "link.open" => {
                let url = links::openable(str_arg(args, "url")?)?;
                self.config.browser.open(url.as_str())?;
                null()
            }
            // The update notice (ADR-0022): the host asks `latest.json`; the webview gets a verdict, never a page.
            "update.check" => json(self.updates.check(bool_arg(args, "force")?)),
            "update.settings" => json(self.updates.settings(args)?),
            _ => Err(HostError::bad_argument(format!("Unknown command {command:?}"))),
        }
    }

    // ------------------------------------------------------------- vaults

    fn pick_vault(&self) -> Value {
        let Some(picked) = self.config.picker.pick_vault() else { return Value::Null };
        let Ok(root) = canonicalize_path(&picked) else { return Value::Null };
        let shown = root.to_string_lossy().into_owned();
        self.state().picked_vaults.insert(root);
        Value::String(shown)
    }

    fn vault_allowed(&self, root: &Path) -> bool {
        self.state().picked_vaults.contains(root) || self.allow_roots.iter().any(|r| root.starts_with(r)) || self.recent().iter().any(|r| Path::new(r) == root)
    }

    fn open_vault(&self, owner: &str, raw: &str) -> HostResult<Value> {
        let root = canonical(raw)?;
        if !self.vault_allowed(&root) {
            return Err(HostError::not_allowed(format!("{raw} was not picked by the user")));
        }
        check_root_policy(&root, self.home.as_deref(), self.config.data_dir.as_deref())?;
        if self.state().vaults.len() >= MAX_OPEN_VAULTS {
            return Err(HostError::bad_argument("Too many open vaults"));
        }
        let fd = open_root_dir(&root)?;
        let fs = VaultFs::new(fd, self.config.disable_hardlink);
        fs.mkdirp(".thoth")?;
        // SQLITE_OPEN_NOFOLLOW refuses a symlink anywhere in this path; `.thoth` was just checked through the root fd.
        // On Windows SQLite ignores that flag, so the host checks the database files through the root handle.
        #[cfg(windows)]
        fs.refuse_linked_index()?;
        let db = root.join(".thoth").join("index.sqlite");
        #[cfg(windows)]
        let db = win::paths::for_win32(&db);
        let sql = Sql::open(&db)?;
        let label = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let handle = handles::new_handle("vault")?;
        let shown = root.to_string_lossy().into_owned();
        let entry = Arc::new(VaultEntry { owner: owner.to_owned(), root: root.clone(), fs, sql: Mutex::new(sql), watcher: Mutex::new(None) });
        // Another window has this folder open: it ran recovery, and what is in `.thoth/tmp` may be its work in flight.
        // A handle this owner opened before (its page reloaded) is not another window.
        let shared = {
            let mut state = self.state();
            let shared = state.vaults.values().any(|v| v.root == root && v.owner != owner);
            state.vaults.insert(handle.clone(), entry);
            shared
        };
        self.remember(&shown);
        Ok(json!({ "vault": handle, "root": shown, "label": label, "shared": shared }))
    }

    /// Has an owner other than `owner` (another window) a handle open on `root`?
    fn shared_with_others(&self, root: &Path, owner: &str) -> bool {
        self.state().vaults.values().any(|v| v.root == root && v.owner != owner)
    }

    fn close_vault(&self, handle: &str) -> HostResult<()> {
        let entry = self.state().vaults.remove(handle).ok_or_else(|| HostError::bad_handle("vault"))?;
        lock(&entry.watcher).take();
        Ok(())
    }

    fn vault(&self, args: &Value) -> HostResult<Arc<VaultEntry>> {
        let handle = str_arg(args, "vault")?;
        self.state().vaults.get(handle).cloned().ok_or_else(|| HostError::bad_handle("vault"))
    }

    /// Canonical roots of the open vaults: an agent's environment never names one.
    fn open_roots(&self) -> Vec<PathBuf> {
        self.state().vaults.values().map(|v| v.root.clone()).collect()
    }

    fn watch_start(&self, handle: &str) -> HostResult<()> {
        let entry = self.state().vaults.get(handle).cloned().ok_or_else(|| HostError::bad_handle("vault"))?;
        let mut slot = lock(&entry.watcher);
        if slot.is_some() {
            return Ok(());
        }
        let events = self.config.events.clone();
        let vault = handle.to_owned();
        let sink: watch::ChangeSink = Arc::new(move |paths, rescan| events(VAULT_CHANGED, json!({ "vault": vault, "paths": paths, "rescan": rescan })));
        *slot = Some(Watcher::start(&entry.root, sink)?);
        Ok(())
    }

    // ------------------------------------------------------- recent list

    fn recent_path(&self) -> Option<PathBuf> {
        self.config.data_dir.as_ref().map(|d| d.join("recent-vaults.json"))
    }

    pub fn recent(&self) -> Vec<String> {
        let Some(path) = self.recent_path() else { return Vec::new() };
        let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
        value.get("roots").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).take(MAX_RECENT).collect()).unwrap_or_default()
    }

    /// Moves `root` to the front of the persisted recent list (atomic replace).
    fn remember(&self, root: &str) {
        let Some(path) = self.recent_path() else { return };
        let mut roots = self.recent();
        roots.retain(|r| r != root);
        roots.insert(0, root.to_owned());
        roots.truncate(MAX_RECENT);
        let Some(dir) = path.parent() else { return };
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        let tmp = dir.join("recent-vaults.json.tmp");
        let body = json!({ "version": 1, "roots": roots }).to_string();
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    // ------------------------------------------------------------ sources

    fn pick_source(&self, directory: bool) -> Value {
        let Some(picked) = self.config.picker.pick_source(directory) else { return Value::Null };
        let Ok(location) = canonicalize_path(&picked) else { return Value::Null };
        let shown = location.to_string_lossy().into_owned();
        self.state().picked_sources.insert(location);
        Value::String(shown)
    }

    fn open_source(&self, raw: &str) -> HostResult<Value> {
        let location = canonical(raw)?;
        let allowed = self.state().picked_sources.contains(&location) || self.allow_roots.iter().any(|r| location.starts_with(r));
        if !allowed {
            return Err(HostError::not_allowed(format!("{raw} was not picked by the user")));
        }
        let source = Source::open(&location)?;
        if source.root_kind() == "directory" {
            check_root_policy(&location, self.home.as_deref(), self.config.data_dir.as_deref())?;
        }
        let mut state = self.state();
        if state.sources.len() >= MAX_OPEN_SOURCES {
            return Err(HostError::bad_argument("Too many open import sources"));
        }
        let handle = handles::new_handle("source")?;
        let reply = json!({ "source": handle, "rootKind": source.root_kind(), "label": source.label, "location": source.location.to_string_lossy() });
        state.sources.insert(handle, Arc::new(Mutex::new(source)));
        Ok(reply)
    }

    fn source(&self, handle: &str) -> HostResult<Arc<Mutex<Source>>> {
        self.state().sources.get(handle).cloned().ok_or_else(|| HostError::bad_handle("source"))
    }

    fn add_file(&self, source: &str, file: OpenFile) -> HostResult<String> {
        let mut state = self.state();
        // The source may have been closed while the file was opening.
        if !state.sources.contains_key(source) {
            file.discard();
            return Err(HostError::bad_handle("source"));
        }
        if state.files.values().filter(|f| f.source == source).count() >= source::MAX_OPEN_FILES {
            file.discard();
            return Err(HostError::bad_argument("Too many open files for this source"));
        }
        let handle = handles::new_handle("file")?;
        state.files.insert(handle.clone(), Arc::new(FileEntry { source: source.to_owned(), file: Mutex::new(file) }));
        Ok(handle)
    }

    fn file(&self, handle: &str) -> HostResult<Arc<FileEntry>> {
        let state = self.state();
        let entry = state.files.get(handle).cloned().ok_or_else(|| HostError::bad_handle("file"))?;
        // A file handle is valid only while the source that opened it is open.
        if !state.sources.contains_key(&entry.source) {
            return Err(HostError::bad_handle("file"));
        }
        Ok(entry)
    }

    /// Idempotent, as `RandomAccessFile.close` is.
    fn close_file(&self, handle: &str) -> HostResult<()> {
        if let Some(entry) = self.state().files.remove(handle) {
            discard(entry);
        }
        Ok(())
    }

    /// Releases every file and temp file of the source. Idempotent.
    fn close_source(&self, handle: &str) -> HostResult<()> {
        let (source, files) = {
            let mut state = self.state();
            let source = state.sources.remove(handle);
            let ids: Vec<String> = state.files.iter().filter(|(_, f)| f.source == handle).map(|(id, _)| id.clone()).collect();
            let files: Vec<_> = ids.iter().filter_map(|id| state.files.remove(id)).collect();
            (source, files)
        };
        for entry in files {
            discard(entry);
        }
        // Dropping the source drops its TempDir, which deletes the private directory.
        drop(source);
        Ok(())
    }
}

impl Host {
    /// A window closed (ADR-0019): closes the vaults it opened (and their watchers) and ends the agent runs it started,
    /// deleting their working directories, as quitting does for all of them. Other windows' handles are untouched.
    pub fn release(&self, owner: &str) {
        self.detach(owner).end();
    }

    /// The quick half of `release`, safe to call on the shell's event loop: `owner`'s vault and run handles stop
    /// working at once (and no longer count for `shared`), so a page that loads next in the same window never loses a
    /// handle it opens after this. `Detached::end` does the slow part (watchers, index connections, processes, folders).
    pub fn detach(&self, owner: &str) -> Detached {
        let vaults = {
            let mut state = self.state();
            let mine: Vec<String> = state.vaults.iter().filter(|(_, v)| v.owner == owner).map(|(h, _)| h.clone()).collect();
            mine.iter().filter_map(|h| state.vaults.remove(h)).collect()
        };
        Detached { vaults, runs: self.agents.detach(owner) }
    }

    /// Closes every vault (stopping watchers) and source (deleting temp files), cancels server sign-ins, and stops
    /// every agent run (deleting its working directory).
    /// The host stays usable.
    pub fn shutdown(&self) {
        self.remote.shutdown();
        self.agents.shutdown();
        let (vaults, sources): (Vec<String>, Vec<String>) = {
            let state = self.state();
            (state.vaults.keys().cloned().collect(), state.sources.keys().cloned().collect())
        };
        for handle in vaults {
            let _ = self.close_vault(&handle);
        }
        for handle in sources {
            let _ = self.close_source(&handle);
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// What `Host::detach` took from one window, still to be ended.
#[must_use = "watchers and agent runs go on until `end` is called"]
pub struct Detached {
    vaults: Vec<Arc<VaultEntry>>,
    runs: agent::DetachedRuns,
}

impl Detached {
    /// Stops the watchers, closes the index connections (once no call in flight still uses them) and ends the agent
    /// runs, deleting their folders. Blocks: call it off the event loop.
    pub fn end(self) {
        for entry in self.vaults {
            lock(&entry.watcher).take();
        }
        self.runs.end();
    }
}

fn discard(entry: Arc<FileEntry>) {
    match Arc::try_unwrap(entry) {
        Ok(entry) => entry.file.into_inner().unwrap_or_else(|p| p.into_inner()).discard(),
        // A read is in flight; delete the temp file's name now, the fd closes when the read finishes.
        Err(shared) => {
            if let Some(path) = &lock(&shared.file).temp_path {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// The user's home folder: `HOME`, or `USERPROFILE` on Windows.
#[cfg(not(windows))]
const HOME_VAR: &str = "HOME";
#[cfg(windows)]
const HOME_VAR: &str = "USERPROFILE";

/// Opens a canonical root directory. On macOS `O_NOFOLLOW_ANY` refuses a symlink in any component,
/// so a component swapped for a symlink after canonicalization cannot redirect the vault.
#[cfg(unix)]
pub(crate) fn open_root_dir(root: &Path) -> HostResult<std::os::fd::OwnedFd> {
    rustix::fs::openat(rustix::fs::CWD, root, no_symlinks(at::DIR_FLAGS), Mode::empty()).map_err(|e| HostError::errno(e, "open", &root.to_string_lossy()))
}

/// Opens a canonical root directory on Windows: refused if it is a reparse point or if its final path is not
/// `root` (a component swapped for a junction after canonicalization), see `win::open_root`.
#[cfg(windows)]
pub(crate) fn open_root_dir(root: &Path) -> HostResult<std::os::windows::io::OwnedHandle> {
    win::open_root(root)
}

/// Adds "refuse symlinks": every component on macOS (`O_NOFOLLOW_ANY`), the final one elsewhere.
#[cfg(unix)]
pub(crate) fn no_symlinks(flags: OFlags) -> OFlags {
    #[cfg(target_os = "macos")]
    {
        // macOS rejects O_NOFOLLOW together with O_NOFOLLOW_ANY (EINVAL); the latter covers the final component too.
        (flags - OFlags::NOFOLLOW) | OFlags::NOFOLLOW_ANY
    }
    #[cfg(not(target_os = "macos"))]
    {
        flags | OFlags::NOFOLLOW
    }
}

/// The SHA-256 of `bytes` as lowercase hex, the form `@thoth/domain`'s `sha256Hex` writes.
fn hex_digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn str_arg<'a>(args: &'a Value, key: &str) -> HostResult<&'a str> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| HostError::bad_argument(format!("{key} must be a string")))
}

fn bool_arg(args: &Value, key: &str) -> HostResult<bool> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(HostError::bad_argument(format!("{key} must be a boolean"))),
    }
}

/// A non-negative safe integer (≤ 2^53 - 1).
fn u64_arg(args: &Value, key: &str) -> HostResult<u64> {
    args.get(key).and_then(Value::as_u64).filter(|n| *n < (1u64 << 53)).ok_or_else(|| HostError::bad_argument(format!("{key} must be a non-negative safe integer")))
}
