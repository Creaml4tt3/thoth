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
pub mod data_dir;
pub mod diagnostics;
pub mod error;
mod handles;
pub mod install;
pub mod links;
pub mod mcp;
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
pub use remote::{Browser, KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE, MemorySecretStore, MovingSecretStore, SecretStore};

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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use updates::{UpdateOptions, Updates};
use vault_fs::VaultFs;
use watch::Watcher;

/// Every command name in the contract (`Commands` in ipc.ts).
#[rustfmt::skip] // grouped by family, one family per line
pub const COMMANDS: &[&str] = &[
    "vault.pick", "vault.recent", "vault.open", "vault.close", "vault.reveal", "vault.shared", "vault.trash",
    "fs.stat", "fs.read", "fs.list", "fs.mkdirp", "fs.write", "fs.rename", "fs.remove",
    "sql.exec", "sql.run", "sql.all", "sql.get",
    "watch.start", "watch.stop",
    "source.pick", "source.open", "source.list", "source.file.open", "source.file.read", "source.file.close",
    "source.temp.create", "source.temp.write", "source.close",
    "image.pick", "image.read",
    "file.save",
    "server.list", "server.add", "server.remove", "server.signIn", "server.signInCancel", "server.useToken", "server.signOut",
    "api.call",
    "agent.detect", "agent.run.create", "agent.fs.stat", "agent.fs.read", "agent.fs.list", "agent.fs.mkdirp", "agent.fs.write",
    "agent.start", "agent.events", "agent.cancel", "agent.run.dispose", "agent.sweep",
    "agent.history.write", "agent.history.read", "agent.history.list", "agent.history.delete",
    "link.preview", "link.preview.clear", "link.open",
    "update.check", "update.settings", "update.install", "update.cancel", "update.status", "update.restart",
    "mcp.settings", "mcp.configure", "mcp.decide", "mcp.forget", "mcp.answer", "mcp.log",
    "diag.report", "diag.collect", "diag.settings",
];

pub const VAULT_CHANGED: &str = "vault.changed";
const MAX_OPEN_VAULTS: usize = 64;
const MAX_OPEN_SOURCES: usize = 64;
const MAX_RECENT: usize = 20;
/// The Private Space to open again after an update's restart (ADR-0034), in the app data folder; read once.
const REOPEN_FILE: &str = "update-reopen.json";
/// The largest image a page accepts (ADR-0028), and the image types it shows.
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"];
const MAX_PICKED_IMAGES: usize = 16;
/// The most webview error reports one Host logs (`diag.report`); later ones are accepted and dropped.
const MAX_REPORTS: usize = 50;
/// A reported message or stack is cut to this many characters before it is formatted, so a huge one costs little.
const MAX_REPORT_CHARS: usize = 4096;
/// A reported stack keeps its first lines only.
const MAX_STACK_LINES: usize = 5;

/// Native pickers. The desktop shell shows dialogs; the harness returns fixed paths.
pub trait Picker: Send + Sync {
    fn pick_vault(&self) -> Option<PathBuf>;
    fn pick_source(&self, directory: bool) -> Option<PathBuf>;
    /// An image file to add to a page (ADR-0028). None: cancelled, or no picker (the default).
    fn pick_image(&self) -> Option<PathBuf> {
        None
    }
    /// Where to save a downloaded page (`file.save`): a "Save as" dialog that starts with `name`. None: cancelled, or no
    /// dialog (the default).
    fn pick_save(&self, _name: &str) -> Option<PathBuf> {
        None
    }
}

/// Shows an open vault's folder in the system file manager (Finder, File Explorer, Files), or an entry in it selected.
/// The desktop shell launches it; the harness and tests record the paths. `root` is always the canonical root of an
/// open vault; `entry`, when given, is `root` joined with a vault-relative path the host has checked: an existing file
/// or folder inside the root, reached without following a symlink, and not in `.thoth/`.
pub trait FileManager: Send + Sync {
    fn reveal(&self, root: &Path, entry: Option<&Path>) -> HostResult<()>;
    /// Moves `entry` (checked as for `reveal`, and never the root) to the system Trash, where it can be put back from.
    /// Refused where there is none.
    fn trash(&self, _root: &Path, _entry: &Path) -> HostResult<()> {
        Err(HostError::not_allowed("There is no Trash here"))
    }
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
    /// Images the user picked and the page has not read yet (`image.pick`, then `image.read` once).
    picked_images: HashMap<String, PathBuf>,
    vaults: HashMap<String, Arc<VaultEntry>>,
    sources: HashMap<String, Arc<Mutex<Source>>>,
    files: HashMap<String, Arc<FileEntry>>,
}

pub struct Host {
    config: HostConfig,
    home: Option<PathBuf>,
    allow_roots: Vec<PathBuf>,
    /// Shared with Connected apps (`mcp`), which asks which Private Spaces are open and in which window.
    state: Arc<Mutex<State>>,
    remote: Remote,
    agents: Agents,
    links: LinkPreviews,
    updates: Updates,
    mcp: mcp::Relay,
    /// Where the app's log files are (`diag.collect`); `None`: no log.
    log_dir: Option<PathBuf>,
    /// The running version, from the update options; "" until `with_updates`.
    version: String,
    /// Webview error reports logged so far (`diag.report`), per Host, which is per app run in the desktop shell.
    reported: AtomicUsize,
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
        let state = Arc::new(Mutex::new(State::default()));
        let open: mcp::OpenSpaces = {
            let state = state.clone();
            Arc::new(move || lock(&state).vaults.values().map(|v| mcp::OpenSpace { root: v.root.clone(), owner: v.owner.clone() }).collect())
        };
        let mcp = mcp::Relay::new(config.data_dir.as_ref().map(|d| d.join(mcp::DIR)), config.events.clone(), open, mcp::McpOptions::default());
        let updates = Updates::new(config.data_dir.clone(), UpdateOptions::off());
        Self {
            config,
            home,
            allow_roots,
            state,
            remote,
            agents,
            links,
            updates,
            mcp,
            log_dir: None,
            version: String::new(),
            reported: AtomicUsize::new(0),
            replace: Mutex::new(()),
        }
    }

    /// Turns the update notice on (ADR-0022): `options` name the running version and where `latest.json` is. A host
    /// built with `Host::new` alone has no notice and never makes that request. The test switch of link previews
    /// (`link_preview_loopback`) applies to it too, so a test can serve `latest.json` from a local server.
    #[must_use]
    pub fn with_updates(mut self, mut options: UpdateOptions) -> Self {
        // The desktop shell may set it for a local test of a debug build (ADR-0034); the harness's switch adds to it.
        options.allow_loopback |= self.config.link_preview_loopback;
        options.events = Some(self.config.events.clone());
        self.version = options.current.clone();
        self.updates = Updates::new(self.config.data_dir.clone(), options);
        self
    }

    /// Where `diag.collect` reads the app's log from (0.3.0); `None` (the default) means there is no log.
    #[must_use]
    pub fn with_log_dir(mut self, dir: Option<PathBuf>) -> Self {
        self.log_dir = dir;
        self
    }

    /// `diag.report`: the webview's uncaught error, into the local log (never redacted here: the logger's formatter
    /// does that for every record).
    fn report(&self, args: &Value) -> HostResult<()> {
        let kind = str_arg(args, "kind")?;
        if !matches!(kind, "error" | "rejection") {
            return Err(HostError::bad_argument("kind must be \"error\" or \"rejection\""));
        }
        let cut = |s: &str| s.chars().take(MAX_REPORT_CHARS).collect::<String>();
        let message = cut(str_arg(args, "message")?);
        let stack = match args.get("stack") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) => cut(s).lines().take(MAX_STACK_LINES).collect::<Vec<_>>().join(" | "),
            Some(_) => return Err(HostError::bad_argument("stack must be a string")),
        };
        if self.reported.fetch_add(1, Ordering::Relaxed) < MAX_REPORTS {
            log::error!(target: "webview", "{kind}: {message}{}{stack}", if stack.is_empty() { "" } else { " | " });
        }
        Ok(())
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
        let wants_bytes =
            matches!(command, "fs.write" | "source.temp.write" | "api.call" | "agent.fs.write" | "agent.start" | "agent.history.write" | "file.save");
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
            // Names a vault by its handle, never a path: only a folder the user opened can be shown, and in it only an
            // entry its own path checks accept (`revealable`).
            "vault.reveal" => {
                let entry = self.vault(args)?;
                match args.get("path") {
                    None | Some(Value::Null) => self.config.file_manager.reveal(&entry.root, None)?,
                    Some(Value::String(path)) => {
                        let target = revealable(&entry, path)?;
                        self.config.file_manager.reveal(&entry.root, Some(&target))?;
                    }
                    Some(_) => return Err(HostError::bad_argument("path must be a string")),
                }
                null()
            }
            // Deleting a page or folder of the Private Space: to the system Trash, where it can be put back from. By
            // handle, with the same checks as `vault.reveal`.
            "vault.trash" => {
                let entry = self.vault(args)?;
                let target = revealable(&entry, str_arg(args, "path")?)?;
                self.config.file_manager.trash(&entry.root, &target)?;
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
            "image.pick" => json(self.pick_image()?),
            "image.read" => Ok((Value::Null, Some(self.read_picked_image(str_arg(args, "image")?)?))),
            "file.save" => {
                let data = bytes.ok_or_else(|| HostError::bad_argument("file.save needs request bytes"))?;
                json(json!(self.save_file(str_arg(args, "name")?, data)?))
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
                    Some(Value::Array(items)) => items
                        .iter()
                        .map(|v| v.as_str().map(str::to_owned))
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(|| HostError::bad_argument("argv must be strings"))?,
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
            // In-app updates (ADR-0034): only after the person clicked Update; progress comes as `update.progress`.
            "update.install" => json(self.updates.install()?),
            "update.cancel" => json(self.updates.cancel()),
            "update.status" => json(self.update_status(bool_arg(args, "reopen")?)),
            "update.restart" => json(self.update_restart(args)?),
            // Connected apps (ADR-0021): the switch, the shared Private Spaces and each app's Allow or Deny, set by the
            // user in a window; `mcp.answer` is a window's answer to an app's request (`mcp.request` event).
            "mcp.settings" => json(self.mcp.settings()),
            "mcp.configure" => {
                let mut opened = self.recent();
                opened.extend(self.open_roots().iter().map(|r| r.to_string_lossy().into_owned()));
                json(self.mcp.configure(args, &opened)?)
            }
            "mcp.decide" => {
                let allow = match args.get("allow") {
                    Some(Value::Bool(b)) => *b,
                    _ => return Err(HostError::bad_argument("allow must be a boolean")),
                };
                json(self.mcp.decide(str_arg(args, "app")?, allow)?)
            }
            "mcp.forget" => json(self.mcp.forget(str_arg(args, "app")?)?),
            "mcp.answer" => {
                self.mcp.answer(owner, str_arg(args, "id")?, args)?;
                null()
            }
            "mcp.log" => json(self.mcp.log()),
            // Problem reports (ADR-0040): the webview's errors into the local log, and the redacted log back.
            "diag.report" => {
                self.report(args)?;
                null()
            }
            "diag.collect" => {
                let log = self.log_dir.as_deref().map_or_else(Vec::new, |d| diagnostics::tail(d, diagnostics::TAIL_LINES, diagnostics::TAIL_BYTES));
                json(json!({ "version": self.version, "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "log": log }))
            }
            // The local log's switch (Settings): off stops the log and deletes what it holds.
            "diag.settings" => {
                match args.get("enabled") {
                    None | Some(Value::Null) => {}
                    Some(Value::Bool(on)) => diagnostics::set_switch(*on, self.config.data_dir.as_deref(), self.log_dir.as_deref()),
                    Some(_) => return Err(HostError::bad_argument("enabled must be a boolean")),
                }
                json(json!({ "enabled": diagnostics::log_enabled() }))
            }
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

    // ------------------------------------------------------- in-app updates (ADR-0034)

    fn reopen_path(&self) -> Option<PathBuf> {
        self.config.data_dir.as_ref().map(|d| d.join(REOPEN_FILE))
    }

    /// `update.restart`: `reopen` names the Private Space the asking window has open (one the person opened), which the
    /// new version's first window opens again.
    fn update_restart(&self, args: &Value) -> HostResult<Value> {
        let reopen = match args.get("reopen") {
            None | Some(Value::Null) => None,
            Some(Value::String(root)) if self.recent().contains(root) => Some(root.clone()),
            Some(Value::String(_)) => return Err(HostError::not_allowed("Only a Private Space that was opened can be opened again")),
            Some(_) => return Err(HostError::bad_argument("reopen must be a string")),
        };
        let answer = self.updates.restart(bool_arg(args, "evenIfRunning")?, self.agents.running())?;
        if answer["state"] == "restarting"
            && let (Some(root), Some(path)) = (reopen, self.reopen_path())
        {
            // Lost if it cannot be written: the new version then starts on the picker, as any start does.
            let _ = std::fs::write(path, json!({ "root": root }).to_string());
        }
        Ok(answer)
    }

    /// `update.status`; with `reopen`, also the Private Space to open again after an update's restart, once.
    fn update_status(&self, reopen: bool) -> Value {
        let mut status = self.updates.status();
        if reopen {
            let root = self.reopen_path().and_then(|path| {
                let text = std::fs::read_to_string(&path).ok();
                let _ = std::fs::remove_file(&path);
                let root = serde_json::from_str::<Value>(&text?).ok()?.get("root")?.as_str()?.to_owned();
                self.recent().contains(&root).then_some(root)
            });
            status["reopen"] = root.map_or(Value::Null, Value::String);
        }
        status
    }

    // ------------------------------------------------------- recent list

    fn recent_path(&self) -> Option<PathBuf> {
        self.config.data_dir.as_ref().map(|d| d.join("recent-vaults.json"))
    }

    pub fn recent(&self) -> Vec<String> {
        let Some(path) = self.recent_path() else { return Vec::new() };
        let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
        value
            .get("roots")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).take(MAX_RECENT).collect())
            .unwrap_or_default()
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

    /// The image picker (ADR-0028): `{ image, name, size }` for a picked image file, or null when cancelled. The page
    /// never learns the path; `image.read` with the handle gives the bytes once.
    fn pick_image(&self) -> HostResult<Value> {
        let Some(picked) = self.config.picker.pick_image() else { return Ok(Value::Null) };
        let Ok(path) = canonicalize_path(&picked) else { return Ok(Value::Null) };
        let name = path.file_name().and_then(|n| n.to_str()).map(str::to_owned).ok_or_else(|| HostError::bad_argument("The picked file has no usable name"))?;
        let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
        if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            return Err(HostError::new("NOT_AN_IMAGE", "This file is not an image a page can show"));
        }
        let meta = std::fs::metadata(&path).map_err(|e| HostError::io(&e, "stat", &name))?;
        if !meta.is_file() {
            return Err(HostError::new("NOT_A_REGULAR_FILE", format!("Not a regular file: {name}")));
        }
        if meta.len() > MAX_IMAGE_BYTES {
            return Err(HostError::new("TOO_LARGE", "The image is larger than 20 MB"));
        }
        let handle = handles::new_handle("image")?;
        let mut state = self.state();
        // Picks that were never read (a page closed meanwhile) do not pile up.
        if state.picked_images.len() >= MAX_PICKED_IMAGES {
            state.picked_images.clear();
        }
        state.picked_images.insert(handle.clone(), path);
        Ok(json!({ "image": handle, "name": name, "size": meta.len() }))
    }

    /// Downloading a page as Markdown: the person picks where in a "Save as" dialog, and only that file is written (the
    /// webview names no path). `name` is a suggestion; it is cleaned to one `.md` file name. True when saved, false
    /// when cancelled.
    fn save_file(&self, name: &str, data: &[u8]) -> HostResult<bool> {
        if data.len() > vault_fs::MAX_FILE_BYTES {
            return Err(HostError::new("TOO_LARGE", "The file is too large"));
        }
        let Some(path) = self.config.picker.pick_save(&save_name(name)) else { return Ok(false) };
        let shown = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        std::fs::write(&path, data).map_err(|e| HostError::io(&e, "write", &shown))?;
        Ok(true)
    }

    /// The bytes of a picked image; the handle is used up.
    fn read_picked_image(&self, handle: &str) -> HostResult<Vec<u8>> {
        let path = self.state().picked_images.remove(handle).ok_or_else(|| HostError::bad_handle("image"))?;
        let shown = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let file = std::fs::File::open(&path).map_err(|e| HostError::io(&e, "open", &shown))?;
        let meta = file.metadata().map_err(|e| HostError::io(&e, "stat", &shown))?;
        if !meta.is_file() {
            return Err(HostError::new("NOT_A_REGULAR_FILE", format!("Not a regular file: {shown}")));
        }
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(file, MAX_IMAGE_BYTES + 1), &mut out).map_err(|e| HostError::io(&e, "read", &shown))?;
        if out.len() as u64 > MAX_IMAGE_BYTES {
            return Err(HostError::new("TOO_LARGE", "The image is larger than 20 MB"));
        }
        Ok(out)
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
    /// every agent run (deleting its working directory), and stops listening for connected apps (ADR-0021; their
    /// settings are kept for the next start).
    /// The host stays usable.
    pub fn shutdown(&self) {
        self.mcp.stop();
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

/// The absolute path of `raw` in the vault, for the file manager: a vault-relative path (no `..`, no absolute path, no
/// backslash), not in `.thoth/`, that names an existing file or folder. The confined file layer looks it up (`openat`
/// on Unix, the NT layer on Windows), so a symlinked folder on the way or a symlink at the end is refused.
fn revealable(entry: &VaultEntry, raw: &str) -> HostResult<PathBuf> {
    let segments = paths::vault_segments(raw, false)?;
    if segments.first().is_some_and(|first| paths::is_reserved_first_segment(first)) {
        return Err(HostError::not_allowed(format!("{raw} is managed by Thoth and is not shown")));
    }
    match entry.fs.stat(raw)?.get("kind").and_then(Value::as_str) {
        Some("file" | "directory") => Ok(segments.iter().fold(entry.root.clone(), |path, segment| path.join(segment))),
        Some("symlink") => Err(HostError::unsafe_path(raw, "symlink")),
        Some(_) => Err(HostError::not_allowed(format!("{raw} is not a file or folder"))),
        None => Err(HostError::new("ENOENT", format!("ENOENT: no such file or directory, reveal '{raw}'"))),
    }
}

/// A file name for the "Save as" dialog: no folder separators or characters a system refuses, at most 120 characters,
/// ending in `.md`; "Untitled.md" when nothing is left.
fn save_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { ' ' } else { c }).collect();
    let stem = cleaned.trim().trim_end_matches(".md").trim().trim_matches('.').trim();
    let stem: String = stem.chars().take(120).collect();
    format!("{}.md", if stem.is_empty() { "Untitled" } else { stem.trim_end() })
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
    args.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n < (1u64 << 53))
        .ok_or_else(|| HostError::bad_argument(format!("{key} must be a non-negative safe integer")))
}

#[cfg(test)]
mod save_name_tests {
    use super::save_name;

    #[test]
    fn makes_one_md_file_name() {
        assert_eq!(save_name("Plan"), "Plan.md");
        assert_eq!(save_name("Plan.md"), "Plan.md");
        assert_eq!(save_name("../a/b:c*?"), "a b c.md");
        assert_eq!(save_name("  "), "Untitled.md");
        assert_eq!(save_name("..."), "Untitled.md");
        assert_eq!(save_name(&"x".repeat(300)), format!("{}.md", "x".repeat(120)));
    }
}
