//! Thoth desktop shell (ADR-0008, option (a)). The TypeScript domain runs in
//! the webview; this crate only exposes `thoth_host::Host::call` as Tauri
//! commands. The webview is untrusted: it reaches the host only through the
//! contract commands granted in `capabilities/main.json`, Tauri checks that
//! ACL before this handler runs, and every argument is validated by the host.
//!
//! Each contract command `a.b` is the Tauri command `a_b`. Requests with bytes
//! (`fs.write`, `source.temp.write`) send them as the raw IPC body with the JSON
//! arguments percent-encoded in the `x-thoth-args` header; byte results
//! (`fs.read`, `source.file.read`) return a raw body. Host events are emitted
//! as `vault:changed` (Tauri event names cannot contain `.`).
//!
//! Agent Hub (ADR-0007): the host finds and runs the user's AI CLI with an argument list its policy accepts, in a
//! private folder under the app data directory; the webview gets no shell or process permission.
//!
//! Windows (ADR-0019): besides the host's commands the shell has two of its own, `window_open` and `window_close`,
//! for Thoth's own windows on a Private Space (labels `space-…`, always the app's own page). Each host call is made
//! as the window that asked (`Host::call_as`), and a closed or reloaded window's vaults and agent runs end with it
//! (`Host::detach` on the event loop, `Detached::end` on a blocking thread). The close button (and Quit on macOS) asks
//! the page to write its edits first (`thoth:close-requested`), and closes a page that does not answer in a few seconds.
//!
//! Workspace servers: the host is the HTTP client. Refresh tokens and personal access tokens go to the OS
//! keychain (`KeychainStore`), sign-in opens the system browser from the host (`SystemBrowser`), and the
//! webview gets no http, opener or shell permission.
use serde_json::Value;
use std::path::PathBuf;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::{Invoke, InvokeBody, InvokeError, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use thoth_host::install::{Failure, Fetched, Installer, NoInstaller};
use thoth_host::updates::{UpdateOptions, Version};
use thoth_host::{Browser, FileManager, Host, HostConfig, HostError, HostResult, KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE, MovingSecretStore, Picker, SecretStore};

/// Where the update notice reads `latest.json` and where "Download" goes (ADR-0022). Fixed when the app is built:
/// `build.rs` reads `THOTH_UPDATE_URL` and `THOTH_DOWNLOADS_PAGE_URL` for a self-built copy; an empty address turns the
/// notice off. Nothing at run time, not the webview and not a flag, can change them.
const UPDATE_URL: &str = match option_env!("THOTH_UPDATE_URL") {
    Some(url) => url,
    None => thoth_host::updates::DEFAULT_URL,
};
const DOWNLOADS_PAGE_URL: &str = match option_env!("THOTH_DOWNLOADS_PAGE_URL") {
    Some(url) => url,
    None => thoth_host::updates::DEFAULT_DOWNLOADS_PAGE,
};

/// A local test of in-app updates (ADR-0034, docs/deploy/release.md): a debug build whose `THOTH_UPDATE_URL` is
/// `http://127.0.0.1:…` may read `latest.json` and the update from there. Never in a release build: build.rs refuses an
/// `http` address unless the profile is debug, and the updater refuses `http` in a release build too.
const LOCAL_UPDATE_TEST: bool = cfg!(debug_assertions) && starts_with(UPDATE_URL, "http://127.0.0.1:");

const fn starts_with(text: &str, prefix: &str) -> bool {
    let (text, prefix) = (text.as_bytes(), prefix.as_bytes());
    if text.len() < prefix.len() {
        return false;
    }
    let mut i = 0;
    while i < prefix.len() {
        if text[i] != prefix[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// Whether this copy of the app can replace itself (ADR-0034), from how it was bundled (Tauri marks the binary when it
/// bundles it), where it runs from and, on Linux, whether it runs as an AppImage. A .deb (or .rpm) install would need
/// root and a password prompt from the updater, so it keeps the notice; so does a build that is not bundled.
fn updates_in_app(bundle: Option<tauri::utils::config::BundleType>, exe: &std::path::Path, appimage: bool, os: &str) -> bool {
    use tauri::utils::config::BundleType;
    match (os, bundle) {
        // On macOS Tauri reports `App` for anything; the app must be in its bundle, and not run by macOS from a
        // read-only copy (App Translocation, a Thoth.app opened where it was downloaded).
        ("macos", Some(BundleType::App)) => {
            let path = exe.to_string_lossy();
            path.contains(".app/Contents/MacOS/") && !path.contains("/AppTranslocation/")
        }
        ("windows", Some(BundleType::Nsis | BundleType::Msi)) => true,
        ("linux", Some(BundleType::AppImage)) => appimage,
        _ => false,
    }
}

/// The update file must come from where `latest.json` is: the same scheme, host and port, no credentials.
fn same_origin(url: &tauri::Url, endpoint: &tauri::Url) -> bool {
    url.scheme() == endpoint.scheme() && url.host_str() == endpoint.host_str() && url.port_or_known_default() == endpoint.port_or_known_default() && url.username().is_empty() && url.password().is_none()
}

/// What the popup says about an updater error (the error itself is not shown: it could echo a server).
fn failure_of(error: &tauri_plugin_updater::Error) -> Failure {
    use tauri_plugin_updater::Error as E;
    match error {
        E::Reqwest(_) | E::Network(_) => Failure::Offline,
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => Failure::Verify,
        E::Io(e) if e.kind() == std::io::ErrorKind::StorageFull => Failure::Disk,
        _ => Failure::Failed,
    }
}

/// In-app updates through the Tauri updater plugin's Rust API (ADR-0034). The webview never reaches the plugin: the
/// host's `update.*` commands call this. It reads the same `latest.json` as the notice, with no proxy, no redirect and
/// https only; it takes the update file only from that address's origin; the plugin checks the signature against the
/// public key in tauri.conf.json before anything is installed.
struct PluginInstaller {
    app: AppHandle,
    endpoint: tauri::Url,
    /// Windows: the downloaded installer, run at restart (it closes the app to replace it).
    pending: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

impl PluginInstaller {
    fn updater(&self) -> Result<tauri_plugin_updater::Updater, Failure> {
        use tauri_plugin_updater::UpdaterExt;
        self.app
            .updater_builder()
            .endpoints(vec![self.endpoint.clone()])
            .map_err(|_| Failure::Failed)?
            .no_proxy()
            // The notice's rule (ADR-0022): newer, and never a pre-release to a stable build.
            .version_comparator(|current, release| {
                let (Some(current), Some(latest)) = (Version::parse(&current.to_string()), Version::parse(&release.version.to_string())) else { return false };
                thoth_host::updates::is_offered(&current, &latest)
            })
            .configure_client(|client| client.https_only(!LOCAL_UPDATE_TEST).redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(10)).read_timeout(Duration::from_secs(30)))
            .build()
            .map_err(|e| failure_of(&e))
    }

    /// After every window has written its edits and closed, as the app exits: Windows runs the downloaded installer
    /// (passive; it closes what is left and starts the new version), elsewhere the new version, already in place, starts.
    fn finish(&self, app: &AppHandle) {
        if let Some((update, bytes)) = locked(&self.pending).take() {
            // Exits the process once the installer has started.
            let _ = update.install(bytes);
        }
        tauri::process::restart(&app.env());
    }
}

impl Installer for PluginInstaller {
    fn supported(&self) -> bool {
        let exe = std::env::current_exe().unwrap_or_default();
        #[cfg(target_os = "linux")]
        let appimage = self.app.env().appimage.is_some();
        #[cfg(not(target_os = "linux"))]
        let appimage = false;
        updates_in_app(tauri::utils::platform::bundle_type(), &exe, appimage, std::env::consts::OS)
    }

    fn fetch(&self, progress: &mut dyn FnMut(u64, Option<u64>), cancel: &AtomicBool) -> Result<Fetched, Failure> {
        let updater = self.updater()?;
        let endpoint = self.endpoint.clone();
        let (tx, rx) = std::sync::mpsc::channel::<(usize, Option<u64>)>();
        let task = tauri::async_runtime::spawn(async move {
            let update = updater.check().await.map_err(|e| failure_of(&e))?.ok_or(Failure::Failed)?;
            if !same_origin(&update.download_url, &endpoint) {
                return Err(Failure::Verify);
            }
            // The plugin checks the signature once the whole file is in, before it returns it.
            let bytes = update.download(move |chunk, total| { let _ = tx.send((chunk, total)); }, || ()).await.map_err(|e| failure_of(&e))?;
            Ok((update, bytes))
        });
        let mut received = 0u64;
        loop {
            if cancel.load(Ordering::SeqCst) {
                task.abort();
                return Err(Failure::Cancelled);
            }
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok((chunk, total)) => {
                    received += chunk as u64;
                    progress(received, total);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let (update, bytes) = tauri::async_runtime::block_on(task).map_err(|_| Failure::Failed)??;
        let version = update.version.clone();
        if cfg!(windows) {
            *locked(&self.pending) = Some((update, bytes));
            return Ok(Fetched { version, installed: false });
        }
        update.install(&bytes).map_err(|e| failure_of(&e))?;
        Ok(Fetched { version, installed: true })
    }

    fn restart(&self) -> HostResult<()> {
        // As Quit: every window writes its edits and closes; the app then exits, and `finish` runs (RunEvent::Exit).
        RESTARTING.store(true, Ordering::SeqCst);
        let app = self.app.clone();
        self.app.run_on_main_thread(move || quit(&app)).map_err(|_| HostError::internal("The app could not restart"))
    }
}

pub const ARGS_HEADER: &str = "x-thoth-args";
pub const VAULT_CHANGED_EVENT: &str = "vault:changed";
/// Connected apps (ADR-0021): an app's request for the window that holds its Private Space, and the apps waiting for
/// Allow or Deny (the host's `mcp.request` and `mcp.pending`).
pub const MCP_REQUEST_EVENT: &str = "thoth:mcp-request";
pub const MCP_PENDING_EVENT: &str = "thoth:mcp-pending";
/// In-app updates (ADR-0034): the host's `update.progress`, to every window.
pub const UPDATE_PROGRESS_EVENT: &str = "thoth:update-progress";

/// Native dialogs, shown by the host so that only paths the user chose enter the allow-list.
struct DialogPicker {
    app: AppHandle,
}

impl Picker for DialogPicker {
    fn pick_vault(&self) -> Option<PathBuf> {
        self.app.dialog().file().set_title("Open a Thoth vault folder").blocking_pick_folder()?.into_path().ok()
    }

    fn pick_source(&self, directory: bool) -> Option<PathBuf> {
        let dialog = self.app.dialog().file().set_title("Choose an import source");
        let picked = if directory { dialog.blocking_pick_folder() } else { dialog.add_filter("Export archive", &["zip"]).blocking_pick_file() };
        picked?.into_path().ok()
    }

    fn pick_image(&self) -> Option<PathBuf> {
        self.app.dialog().file().set_title("Add an image").add_filter("Images", thoth_host::IMAGE_EXTENSIONS).blocking_pick_file()?.into_path().ok()
    }
}

/// Workspace-server secrets in the OS keychain (macOS Keychain, Windows Credential Manager, Linux keyutils),
/// service = the bundle identifier (`KEYCHAIN_SERVICE`), account = the server's handle. Errors never include the
/// secret. The app reads through `MovingSecretStore`, which moves a secret kept under the old identifier
/// (`LEGACY_KEYCHAIN_SERVICE`, ADR-0031) the first time it is read.
struct KeychainStore {
    service: &'static str,
}

impl KeychainStore {
    fn current() -> Self {
        Self { service: KEYCHAIN_SERVICE }
    }

    fn legacy() -> Self {
        Self { service: LEGACY_KEYCHAIN_SERVICE }
    }

    fn entry(&self, server: &str) -> HostResult<keyring::Entry> {
        keyring::Entry::new(self.service, server).map_err(|_| HostError::internal("The system keychain is not available"))
    }
}

impl SecretStore for KeychainStore {
    fn get(&self, server: &str) -> HostResult<Option<String>> {
        match self.entry(server)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(HostError::internal("Could not read from the system keychain")),
        }
    }

    fn set(&self, server: &str, secret: &str) -> HostResult<()> {
        self.entry(server)?.set_password(secret).map_err(|_| HostError::internal("Could not write to the system keychain"))
    }

    fn delete(&self, server: &str) -> HostResult<()> {
        match self.entry(server)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(HostError::internal("Could not delete from the system keychain")),
        }
    }
}

/// Opens sign-in pages in the system browser, from the host: the webview has no opener permission.
/// Only `http(s)` URLs, passed as one argument (no shell).
struct SystemBrowser;

impl Browser for SystemBrowser {
    fn open(&self, url: &str) -> HostResult<()> {
        if !(url.starts_with("https://") || url.starts_with("http://")) || url.chars().any(char::is_control) {
            return Err(HostError::bad_argument("Only web addresses can be opened"));
        }
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("/usr/bin/open");
        #[cfg(target_os = "windows")]
        let mut command = {
            // `rundll32 url.dll,FileProtocolHandler <url>` opens the default browser without `cmd /c start`,
            // whose parser would treat `&` in the query as a command separator. By absolute path, so no
            // `rundll32.exe` next to the app or on PATH is picked instead.
            let mut c = std::process::Command::new(windows_tool(r"System32\rundll32.exe"));
            c.arg("url.dll,FileProtocolHandler");
            c
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let mut child = command.spawn().map_err(|_| HostError::internal("Could not open the web browser"))?;
        // Reap the launcher in the background; the browser outlives it.
        std::thread::spawn(move || child.wait());
        Ok(())
    }
}

/// Shows a vault folder in Finder, File Explorer or the Linux file manager, or an entry in it selected. The host
/// passes only the canonical root of an open vault, and an entry it has checked under that root (`vault.reveal`); the
/// path goes to the launcher as one argument (no shell). An absolute path starts with `/` or a drive letter, so the
/// launcher cannot read it as an option.
///
/// An entry: macOS `open -R` (Finder, selected); Windows `explorer.exe /select,"<path>"`; Linux opens the folder that
/// holds it, as selecting is not portable.
struct SystemFileManager;

impl SystemFileManager {
    fn command(root: &std::path::Path, entry: Option<&std::path::Path>) -> HostResult<std::process::Command> {
        let shown = entry.unwrap_or(root);
        let plain = |p: &std::path::Path| p.is_absolute() && !p.as_os_str().to_string_lossy().chars().any(char::is_control);
        if !plain(root) || !plain(shown) || !shown.starts_with(root) {
            return Err(HostError::bad_argument("Only an open Private Space folder, or something in it, can be shown"));
        }
        #[cfg(target_os = "macos")]
        let command = {
            let mut command = std::process::Command::new("/usr/bin/open");
            if entry.is_some() {
                command.arg("-R");
            }
            command.arg(shown);
            command
        };
        #[cfg(target_os = "windows")]
        let command = {
            let mut command = std::process::Command::new(windows_tool("explorer.exe"));
            match entry {
                // As written, not re-quoted: Explorer reads `/select,"<path>"` and nothing else reliably. A Windows
                // path cannot hold `"`, and control characters were refused above.
                Some(path) => {
                    use std::os::windows::process::CommandExt;
                    let mut select = std::ffi::OsString::from("/select,\"");
                    select.push(path);
                    select.push("\"");
                    command.raw_arg(select);
                }
                None => {
                    command.arg(root);
                }
            }
            command
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let command = {
            let mut command = std::process::Command::new("xdg-open");
            // A folder opens as itself; a file, by the folder it is in (the file manager cannot be told to select it).
            let folder = if shown.is_dir() { shown } else { shown.parent().unwrap_or(root) };
            command.arg(folder);
            command
        };
        Ok(command)
    }
}

/// A program in the Windows folder (`%SystemRoot%`, normally `C:\Windows`), by absolute path.
#[cfg(target_os = "windows")]
fn windows_tool(relative: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join(relative)
}

impl FileManager for SystemFileManager {
    fn reveal(&self, root: &std::path::Path, entry: Option<&std::path::Path>) -> HostResult<()> {
        let mut command = Self::command(root, entry)?;
        command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let mut child = command.spawn().map_err(|_| HostError::internal("Could not open the file manager"))?;
        std::thread::spawn(move || child.wait());
        Ok(())
    }
}

/// Decodes `%XX` escapes (the header carries `encodeURIComponent(JSON.stringify(args))`).
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Splits an IPC request into (args, request bytes).
fn request_parts(body: &InvokeBody, header: Option<&str>) -> Result<(Value, Option<Vec<u8>>), HostError> {
    match body {
        InvokeBody::Json(value) => Ok((value.get("args").cloned().unwrap_or(Value::Null), None)),
        InvokeBody::Raw(bytes) => {
            let header = header.ok_or_else(|| HostError::bad_argument(format!("Raw requests need the {ARGS_HEADER} header")))?;
            let text = percent_decode(header).ok_or_else(|| HostError::bad_argument("Malformed arguments header"))?;
            let args = serde_json::from_str(&text).map_err(|_| HostError::bad_argument("Arguments header is not JSON"))?;
            Ok((args, Some(bytes.clone())))
        }
    }
}

fn contract_name(tauri_command: &str) -> Option<&'static str> {
    thoth_host::COMMANDS.iter().copied().find(|c| c.replace('.', "_") == tauri_command)
}

/// The shell's own commands (not the host's): Thoth's windows on a Private Space (ADR-0019).
pub const SHELL_COMMANDS: &[&str] = &["window_open", "window_close"];
/// Sent to the other windows when the user closes one (never while the app quits): they forget it, so it does not come back.
pub const WINDOW_CLOSED_EVENT: &str = "thoth:window-closed";
/// The longest tab list a new window starts with (30 tabs of long paths fit many times over).
const MAX_LAUNCH_TABS: usize = 64 * 1024;
/// The most windows the app has open at once (each has its own index connection and watcher in the host).
const MAX_WINDOWS: usize = 8;
/// Sent to a window whose close button (or Quit) was used: it writes its edits, then closes itself with
/// `window_close` and `evenIfLast` (ADR-0019).
pub const CLOSE_REQUESTED_EVENT: &str = "thoth:close-requested";
/// How long a window has to answer `CLOSE_REQUESTED_EVENT` before it is closed anyway (a hung page).
const CLOSE_ANSWER_TIMEOUT: Duration = Duration::from_secs(4);

/// Is `label` one of the windows the app opens (`space-` and 1 to 32 lowercase letters or digits)? The capability
/// grants Thoth's commands to `main` and `space-*`; nothing else can be made through `window_open`.
fn is_window_label(label: &str) -> bool {
    label.strip_prefix("space-").is_some_and(|id| (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

/// Percent-encodes everything but the unreserved characters, for a query value.
fn query_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A window `window_open` may make: its label, the app page it loads (with what it shows in the query) and where.
#[derive(Debug, PartialEq)]
struct NewWindow {
    label: String,
    page: String,
    at: Option<(f64, f64)>,
}

/// Checks a `window_open` request: a `space-` label, a Private Space the user opened (one of the host's recent
/// folders, which the host would open anyway), a bounded tab list and, if given, a finite screen point. The page is
/// always the app's own `index.html`; nothing in the request can name another address.
fn new_window(args: &Value, recent: &[String], open: usize) -> HostResult<NewWindow> {
    if open >= MAX_WINDOWS {
        return Err(HostError::not_allowed(format!("Thoth opens at most {MAX_WINDOWS} windows: close one first")));
    }
    let text = |key: &str| args.get(key).and_then(Value::as_str).ok_or_else(|| HostError::bad_argument(format!("{key} must be a string")));
    let label = text("id")?;
    if !is_window_label(label) {
        return Err(HostError::bad_argument("A window id is space- and lowercase letters or digits"));
    }
    let root = text("root")?;
    if !recent.iter().any(|r| r == root) {
        return Err(HostError::not_allowed("A new window opens only on a Private Space that was opened"));
    }
    let tabs = text("tabs")?;
    if tabs.len() > MAX_LAUNCH_TABS {
        return Err(HostError::bad_argument("Too many tabs for a new window"));
    }
    let at = match args.get("at") {
        None | Some(Value::Null) => None,
        Some(point) => {
            let (x, y) = (point.get("x").and_then(Value::as_f64), point.get("y").and_then(Value::as_f64));
            match (x, y) {
                (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Some((x, y)),
                _ => return Err(HostError::bad_argument("at must be a point")),
            }
        }
    };
    let page = format!("index.html?window={label}&root={}&tabs={}", query_escape(root), query_escape(tabs));
    Ok(NewWindow { label: label.to_owned(), page, at })
}

/// `window_open` and `window_close`, for the window that asked.
fn handle_shell(host: &'static OnceLock<Arc<Host>>, invoke: Invoke) -> bool {
    let webview = invoke.message.webview();
    let app = webview.app_handle().clone();
    let caller = webview.label().to_owned();
    let command = invoke.message.command().to_owned();
    let args = request_parts(invoke.message.payload(), None).map(|(args, _)| args);
    invoke.resolver.respond_async_serialized(async move {
        let args = args.map_err(InvokeError::from)?;
        match command.as_str() {
            "window_open" => {
                let host = host.get().cloned().ok_or_else(|| InvokeError::from(HostError::internal("Host is not ready")))?;
                let window = new_window(&args, &host.recent(), app.webview_windows().len()).map_err(InvokeError::from)?;
                if app.get_webview_window(&window.label).is_some() {
                    return Err(InvokeError::from(HostError::bad_argument("That window is open already")));
                }
                let mut builder = WebviewWindowBuilder::new(&app, &window.label, WebviewUrl::App(window.page.into()))
                    .title("Thoth")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(720.0, 480.0)
                    // Files dropped from the system arrive as the page's own drop events (images, ADR-0028), not as paths.
                    .disable_drag_drop_handler()
                    .focused(true);
                // The tab was let go here: the new window's tab bar starts under the pointer.
                if let Some((x, y)) = window.at {
                    builder = builder.position((x - 140.0).max(0.0), (y - 20.0).max(0.0));
                }
                builder.build().map_err(|e| InvokeError::from(HostError::internal(format!("The window could not be opened: {e}"))))?;
                Ok(InvokeResponseBody::Json("null".to_owned()))
            }
            "window_close" => {
                // Cmd/Ctrl+W: the last window stays (it gets an empty tab); closing it would quit the app. After its
                // close button or Quit (`evenIfLast`), the window goes whatever is left. Either way the page has written
                // its edits first, so the window is destroyed here without asking it again.
                let even_if_last = match args.get("evenIfLast") {
                    None | Some(Value::Null) => false,
                    Some(Value::Bool(b)) => *b,
                    Some(_) => return Err(InvokeError::from(HostError::bad_argument("evenIfLast must be a boolean"))),
                };
                let asked = locked(&CLOSING).contains(&caller);
                let closes = closes_window(even_if_last, asked, app.webview_windows().keys().any(|label| label != &caller));
                if closes && let Some(window) = app.get_webview_window(&caller) {
                    window.destroy().map_err(|e| InvokeError::from(HostError::internal(format!("The window could not be closed: {e}"))))?;
                }
                Ok(InvokeResponseBody::Json(closes.to_string()))
            }
            _ => Err(InvokeError::from(HostError::bad_argument("Unknown shell command"))),
        }
    });
    true
}

fn handle(host: &'static OnceLock<Arc<Host>>, invoke: Invoke) -> bool {
    if SHELL_COMMANDS.contains(&invoke.message.command()) {
        return handle_shell(host, invoke);
    }
    let Some(command) = contract_name(invoke.message.command()) else { return false };
    // Vaults a window opens and agent runs it starts are its own: they end when it closes.
    let owner = invoke.message.webview().label().to_owned();
    let Some(host) = host.get().cloned() else {
        invoke.resolver.reject(HostError::internal("Host is not ready"));
        return true;
    };
    let header = invoke.message.headers().get(ARGS_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let parts = request_parts(invoke.message.payload(), header.as_deref());
    invoke.resolver.respond_async_serialized(async move {
        let (args, bytes) = parts.map_err(InvokeError::from)?;
        // Host calls block (disk, SQLite, native dialogs); keep them off the async runtime and main thread.
        let reply = tauri::async_runtime::spawn_blocking(move || host.call_as(&owner, command, &args, bytes.as_deref()))
            .await
            .map_err(|_| InvokeError::from(HostError::internal("Host call panicked")))?;
        match reply {
            Ok((_, Some(bytes))) => Ok(InvokeResponseBody::Raw(bytes)),
            Ok((value, None)) => Ok(InvokeResponseBody::Json(value.to_string())),
            Err(error) => Err(InvokeError::from(error)),
        }
    });
    true
}

/// The id of the macOS menu's own Quit item.
#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "thoth-quit";

/// The macOS menu bar: Tauri's default menu without "Close Window", whose Cmd+W would close the app window before
/// the page sees the key. Cmd+W closes a tab (ADR-0016 rule 5); the window's red button still closes the window, once
/// its page has written its edits. Quit is the app's own item for the same reason (ADR-0019).
#[cfg(target_os = "macos")]
fn app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let name = app.package_info().name.clone();
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            // Not the predefined Quit, which ends the app at once: this one lets every window write its edits first.
            &MenuItem::with_id(app, QUIT_MENU_ID, format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    // Edit keeps the system clipboard and undo keys working in the webview, as in the default menu.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

static HOST: OnceLock<Arc<Host>> = OnceLock::new();
/// Set once the app is quitting: windows destroyed then are not "closed by the user" (they come back next time).
static EXITING: AtomicBool = AtomicBool::new(false);
/// Windows asked to close (their close button, or Quit) that have not closed yet.
static CLOSING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
/// Set by "Restart now" (ADR-0034): when the app exits, it starts the new version (`PluginInstaller::finish`).
static RESTARTING: AtomicBool = AtomicBool::new(false);
static INSTALLER: OnceLock<Arc<PluginInstaller>> = OnceLock::new();
/// Releases still ending in the background: the app waits for them before it exits, so no agent run outlives it.
static RELEASING: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(Vec::new());

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Ends what the window `label` held (ADR-0019): its handles stop working now, on the event loop; the watchers, index
/// connections, agent processes and run folders end on a blocking thread, then `then` runs.
fn release_in_background(label: &str, then: impl FnOnce() + Send + 'static) {
    let detached = HOST.get().map(|host| host.detach(label));
    let task = tauri::async_runtime::spawn_blocking(move || {
        if let Some(detached) = detached {
            detached.end();
        }
        then();
    });
    locked(&RELEASING).push(task);
}

/// Whether `window_close` closes its caller. Cmd/Ctrl+W (`even_if_last` false) closes it unless it is the last window.
/// `even_if_last` is the answer to a close request, and counts only from a window that was asked (`asked`, it is in
/// `CLOSING`): every window's page hears the close-request event, so another window answering it must not close too.
fn closes_window(even_if_last: bool, asked: bool, others_open: bool) -> bool {
    if even_if_last { asked } else { others_open }
}

/// Asks the window `label` to write its edits and close itself (`CLOSE_REQUESTED_EVENT`, answered by `window_close`
/// with `evenIfLast`). A page that does not answer within `CLOSE_ANSWER_TIMEOUT` (hung) is closed anyway. The event
/// names the window, because a page's listener hears events sent to every window.
fn ask_to_close<R: tauri::Runtime>(app: &AppHandle<R>, label: &str) {
    if !locked(&CLOSING).insert(label.to_owned()) {
        return; // asked already: its answer, or its timeout, is on the way
    }
    let _ = app.emit_to(label, CLOSE_REQUESTED_EVENT, label);
    let (app, label) = (app.clone(), label.to_owned());
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_ANSWER_TIMEOUT);
        // Not under the lock: destroying the window runs the Destroyed handler, which takes it.
        let unanswered = locked(&CLOSING).contains(&label);
        if unanswered && let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    });
}

/// Quit (Cmd+Q on macOS), and a restart into an update (ADR-0034): every window writes its edits and closes, as with its
/// close button; the app exits when the last one has gone. The windows open now are not forgotten: they come back with
/// the Private Space.
fn quit<R: tauri::Runtime>(app: &AppHandle<R>) {
    EXITING.store(true, Ordering::SeqCst);
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    if labels.is_empty() {
        return app.exit(0);
    }
    for label in labels {
        ask_to_close(app, &label);
    }
}

/// Moves the app data folder of the old identifier to this one's, once (ADR-0031). The same folder Tauri's
/// `app_data_dir` gives (`dirs::data_dir()` joined with the identifier; this app sets no directory override). A failed
/// move is not fatal: the app starts with a new folder and the old one stays on disk.
fn move_legacy_data_dir(identifier: &str) {
    if let Some(data) = dirs::data_dir() {
        let _ = thoth_host::data_dir::move_legacy(&data.join(thoth_host::data_dir::LEGACY_IDENTIFIER), &data.join(identifier));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Before the builder: the config's window (and on Linux its webview folder, the data folder) is made before `setup`.
    move_legacy_data_dir(&context.config().identifier);
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu).on_menu_event(|app, event| {
        if event.id() == QUIT_MENU_ID {
            quit(app);
        }
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        // System notifications (ADR-0018): the webview may only check and ask for the permission and show one.
        .plugin(tauri_plugin_notification::init())
        // In-app updates (ADR-0034): used from the host through its Rust API; the webview is granted none of it.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // In-app updates read the same address as the notice; a build without one has neither.
            let installer: Arc<dyn Installer> = match tauri::Url::parse(UPDATE_URL) {
                Ok(endpoint) => {
                    let plugin = Arc::new(PluginInstaller { app: app.handle().clone(), endpoint, pending: Mutex::new(None) });
                    let _ = INSTALLER.set(plugin.clone());
                    plugin
                }
                Err(_) => Arc::new(NoInstaller),
            };
            let handle = app.handle().clone();
            let emitter = handle.clone();
            let host = Host::new(HostConfig {
                data_dir: app.path().app_data_dir().ok(),
                allow_roots: Vec::new(),
                picker: Arc::new(DialogPicker { app: handle }),
                events: Arc::new(move |event, payload| {
                    let _ = match event {
                        // Each window also checks `owner` itself: a listener in any window hears every event.
                        thoth_host::mcp::REQUEST_EVENT => match payload.get("owner").and_then(Value::as_str).map(str::to_owned) {
                            Some(owner) => emitter.emit_to(owner.as_str(), MCP_REQUEST_EVENT, payload),
                            None => Ok(()),
                        },
                        thoth_host::mcp::PENDING_EVENT => emitter.emit(MCP_PENDING_EVENT, payload),
                        thoth_host::install::PROGRESS_EVENT => emitter.emit(UPDATE_PROGRESS_EVENT, payload),
                        _ => emitter.emit(VAULT_CHANGED_EVENT, payload),
                    };
                }),
                disable_hardlink: false,
                secrets: Arc::new(MovingSecretStore::new(Arc::new(KeychainStore::current()), Arc::new(KeychainStore::legacy()))),
                browser: Arc::new(SystemBrowser),
                file_manager: Arc::new(SystemFileManager),
                // Agent CLIs are found on PATH and in the usual install folders, never in a folder the webview names.
                agent_search_dirs: None,
                // Link previews connect to public addresses only (ADR-0020); the loopback switch is for tests.
                link_preview_loopback: false,
            })
            .with_updates(UpdateOptions { downloads_page: DOWNLOADS_PAGE_URL.to_owned(), allow_loopback: LOCAL_UPDATE_TEST, installer, ..UpdateOptions::new(app.package_info().version.to_string(), UPDATE_URL) });
            let _ = HOST.set(Arc::new(host));
            Ok(())
        })
        .invoke_handler(|invoke| handle(&HOST, invoke))
        // A page that loads anew (a reload) is a new session of the same window: what the old page held ends with it,
        // as when the window is destroyed (ADR-0019). Otherwise its agent runs would go on with nobody to review them,
        // and its handles would stay open until the window closes. On the first load the window holds nothing yet.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                release_in_background(webview.label(), || ());
            }
        })
        .on_window_event(|window, event| match event {
            // The close button: the page writes its edits first (ADR-0019), then closes itself.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                ask_to_close(window.app_handle(), window.label());
            }
            tauri::WindowEvent::Destroyed => {
                let label = window.label().to_owned();
                locked(&CLOSING).remove(&label);
                // Its vaults (watchers, index connections) close and its agent runs end, as all of them do at quit; then
                // the other windows hear of it (and may now be alone on their Private Space).
                let app = window.app_handle().clone();
                let by_user = !EXITING.load(Ordering::SeqCst);
                let closed = label.clone();
                release_in_background(&label, move || {
                    if by_user {
                        let _ = app.emit(WINDOW_CLOSED_EVENT, closed);
                    }
                });
            }
            _ => {}
        })
        .build(context)
        .expect("failed to build the Thoth app")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                EXITING.store(true, Ordering::SeqCst);
            }
            if let tauri::RunEvent::Exit = event {
                EXITING.store(true, Ordering::SeqCst);
                // Windows' releases still ending finish first, then every watcher, import temp file and agent run left.
                for task in std::mem::take(&mut *locked(&RELEASING)) {
                    let _ = tauri::async_runtime::block_on(task);
                }
                if let Some(host) = HOST.get() {
                    host.shutdown();
                }
                // "Restart now" (ADR-0034): the windows have written their edits and closed, the runs have ended.
                if RESTARTING.load(Ordering::SeqCst)
                    && let Some(installer) = INSTALLER.get()
                {
                    installer.finish(app);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_contract_command_has_a_tauri_command_and_permission() {
        let build = include_str!("../build.rs");
        let capability = include_str!("../capabilities/main.json");
        for command in thoth_host::COMMANDS {
            let tauri = command.replace('.', "_");
            assert_eq!(contract_name(&tauri), Some(*command));
            assert!(build.contains(&format!("\"{tauri}\"")), "{tauri} missing from build.rs");
            assert!(capability.contains(&format!("\"allow-{}\"", tauri.replace('_', "-"))), "{tauri} missing from capability");
        }
        assert_eq!(contract_name("plugin:fs|read"), None);
    }

    #[test]
    fn the_shell_commands_have_a_permission_and_are_not_host_commands() {
        let build = include_str!("../build.rs");
        let capability = include_str!("../capabilities/main.json");
        for command in SHELL_COMMANDS {
            assert!(build.contains(&format!("\"{command}\"")), "{command} missing from build.rs");
            assert!(capability.contains(&format!("\"allow-{}\"", command.replace('_', "-"))), "{command} missing from capability");
            assert_eq!(contract_name(command), None, "{command} must not reach the host");
        }
    }

    #[test]
    fn only_the_window_asked_to_close_closes_when_it_answers() {
        // The close button or Quit asked this window: it closes, even the last one.
        assert!(closes_window(true, true, false));
        assert!(closes_window(true, true, true));
        // Another window heard the same request and answered it: it stays, whatever else is open.
        assert!(!closes_window(true, false, true));
        assert!(!closes_window(true, false, false));
        // Cmd/Ctrl+W: closes unless it is the last window.
        assert!(closes_window(false, false, true));
        assert!(!closes_window(false, false, false));
        assert!(closes_window(false, true, true));
    }

    #[test]
    fn the_capability_covers_the_main_window_and_thoths_own_windows_only() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let windows: Vec<&str> = capability["windows"].as_array().unwrap().iter().map(|w| w.as_str().unwrap()).collect();
        assert_eq!(windows, ["main", "space-*"]);
        assert!(capability.get("webviews").is_none());
        // Every label `window_open` can make is one the capability names, and nothing else is.
        for label in ["space-a", "space-0123456789abcdef", &format!("space-{}", "z".repeat(32))] {
            assert!(is_window_label(label), "{label}");
        }
        for label in ["main", "space-", "space-A", "space-a.b", "space-../main", "spaces-a", "space-a b", &format!("space-{}", "z".repeat(33)), ""] {
            assert!(!is_window_label(label), "{label:?}");
        }
    }

    #[test]
    fn window_open_makes_only_thoths_own_windows_on_an_opened_private_space() {
        let recent = vec!["/Users/a/Notes & more".to_owned()];
        let ok = json!({ "id": "space-ab12", "root": "/Users/a/Notes & more", "tabs": "{\"v\":1,\"active\":0,\"tabs\":[{\"k\":\"page\",\"path\":\"A#b?c.md\"}]}", "at": { "x": 900.5, "y": 400.0 } });
        let window = new_window(&ok, &recent, 1).unwrap();
        assert_eq!(window.label, "space-ab12");
        assert_eq!(window.at, Some((900.5, 400.0)));
        // Always the app's own page; what it shows travels escaped, so nothing in it adds to or ends the query.
        assert!(window.page.starts_with("index.html?window=space-ab12&root=%2FUsers%2Fa%2FNotes%20%26%20more&tabs=%7B"));
        assert_eq!(window.page.matches('?').count(), 1);
        assert_eq!(window.page.matches('&').count(), 2);
        assert!(!window.page.contains('#'));
        assert_eq!(new_window(&json!({ "id": "space-ab12", "root": "/Users/a/Notes & more", "tabs": "x" }), &recent, 1).unwrap().at, None);

        let refused = |args: Value| new_window(&args, &recent, 1).unwrap_err().code;
        assert_eq!(refused(json!({ "id": "main", "root": "/Users/a/Notes & more", "tabs": "x" })), "BAD_ARGUMENT");
        assert_eq!(refused(json!({ "id": "space-x", "root": "/Users/a/Other", "tabs": "x" })), "NOT_ALLOWED");
        assert_eq!(refused(json!({ "id": "space-x", "root": "/Users/a/Notes & more", "tabs": "x".repeat(MAX_LAUNCH_TABS + 1) })), "BAD_ARGUMENT");
        assert_eq!(refused(json!({ "id": "space-x", "root": "/Users/a/Notes & more", "tabs": "x", "at": { "x": "1", "y": 2 } })), "BAD_ARGUMENT");
        assert_eq!(refused(json!({ "id": "space-x", "root": "/Users/a/Notes & more" })), "BAD_ARGUMENT");
        // An address in the request is not used: the page is the app's own whatever else is sent.
        let elsewhere = new_window(&json!({ "id": "space-x", "url": "https://example.org/", "root": "/Users/a/Notes & more", "tabs": "x" }), &recent, 1).unwrap();
        assert!(elsewhere.page.starts_with("index.html?window=space-x&") && !elsewhere.page.contains("example.org"));
    }

    #[test]
    fn window_open_stops_at_a_bounded_number_of_windows() {
        let recent = vec!["/Notes".to_owned()];
        let args = json!({ "id": "space-x", "root": "/Notes", "tabs": "x" });
        assert!(new_window(&args, &recent, MAX_WINDOWS - 1).is_ok());
        let refused = new_window(&args, &recent, MAX_WINDOWS).unwrap_err();
        assert_eq!(refused.code, "NOT_ALLOWED");
        assert!(refused.message.contains(&MAX_WINDOWS.to_string()), "{}", refused.message);
    }

    #[test]
    fn capability_grants_nothing_but_thoth_commands_and_events() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        // System notifications (ADR-0018): check and ask for the permission, and show one. Nothing else of the
        // plugin (no listeners, channels, pending or active lists, no `notification:default`).
        const NOTIFICATION: [&str; 3] = ["notification:allow-is-permission-granted", "notification:allow-request-permission", "notification:allow-notify"];
        let mut granted = Vec::new();
        for permission in capability["permissions"].as_array().unwrap() {
            let p = permission.as_str().unwrap();
            assert!(p.starts_with("allow-") || p == "core:event:allow-listen" || p == "core:event:allow-unlisten" || NOTIFICATION.contains(&p), "unexpected permission {p}");
            if p.starts_with("notification:") {
                granted.push(p);
            }
        }
        assert_eq!(granted, NOTIFICATION);
        assert!(capability.get("remote").is_none());
        let text = include_str!("../capabilities/main.json");
        for plugin in ["http:", "opener:", "shell:", "fs:", "core:window:", "notification:default"] {
            assert!(!text.contains(plugin), "capability must not grant {plugin}");
        }
    }

    #[test]
    fn capability_grants_exactly_the_host_and_shell_commands() {
        // Nothing beyond the contract: link previews (ADR-0020) add `link.preview`, `link.preview.clear` and `link.open`
        // and no plugin (no http, no opener).
        let capability: Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let granted: BTreeSet<String> = capability["permissions"].as_array().unwrap().iter().filter_map(Value::as_str).filter(|p| p.starts_with("allow-")).map(str::to_owned).collect();
        let expected: BTreeSet<String> = thoth_host::COMMANDS.iter().map(|c| c.replace('.', "_")).chain(SHELL_COMMANDS.iter().map(|c| (*c).to_owned())).map(|c| format!("allow-{}", c.replace('_', "-"))).collect();
        assert_eq!(granted, expected);
        for link in ["allow-link-preview", "allow-link-preview-clear", "allow-link-open"] {
            assert!(granted.contains(link), "{link}");
        }
        // The update notice (ADR-0022) adds `update.check` and `update.settings`; in-app updates (ADR-0034) add
        // `update.install`, `update.cancel`, `update.status` and `update.restart`, the host's own commands. The updater
        // plugin is the shell's, through its Rust API: none of its permissions is granted to the webview.
        let updates: BTreeSet<&str> = granted.iter().map(String::as_str).filter(|p| p.contains("update")).collect();
        assert_eq!(updates, BTreeSet::from(["allow-update-check", "allow-update-settings", "allow-update-install", "allow-update-cancel", "allow-update-status", "allow-update-restart"]));
        let text = include_str!("../capabilities/main.json");
        assert!(!text.contains("updater"), "no updater plugin permission");
        assert!(include_str!("../Cargo.toml").contains("tauri-plugin-updater"));
        // Connected apps (ADR-0021) add exactly their six commands and no plugin: the socket is the host's.
        let mcp: BTreeSet<&str> = granted.iter().map(String::as_str).filter(|p| p.starts_with("allow-mcp-")).collect();
        assert_eq!(mcp, BTreeSet::from(["allow-mcp-settings", "allow-mcp-configure", "allow-mcp-decide", "allow-mcp-forget", "allow-mcp-answer", "allow-mcp-log"]));
    }

    #[test]
    fn the_update_notice_looks_where_the_build_says_and_only_over_https() {
        // Compiled in (build.rs reads THOTH_UPDATE_URL for a self-built copy); empty turns the notice off.
        for address in [UPDATE_URL, DOWNLOADS_PAGE_URL] {
            assert!(address.is_empty() || address.starts_with("https://") || LOCAL_UPDATE_TEST, "{address}");
        }
        if option_env!("THOTH_UPDATE_URL").is_none() {
            assert_eq!(UPDATE_URL, "https://download.thothnotes.com/latest.json");
        }
        // Nothing at run time changes it: no flag, no environment variable, no argument from the webview.
        let source = include_str!("lib.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        assert!(!code.contains("var(\"THOTH") && !code.contains("var_os(\"THOTH") && !code.contains("env::args"));
        assert!(include_str!("../build.rs").contains("\"update_check\", \"update_settings\""));
    }

    #[test]
    fn in_app_updates_only_where_the_bundle_can_replace_itself() {
        use tauri::utils::config::BundleType;
        let app = std::path::Path::new("/Applications/Thoth.app/Contents/MacOS/thoth-desktop");
        let elsewhere = std::path::Path::new("/Users/a/thoth/target/release/thoth-desktop");
        // macOS: the app in its bundle; not a build from the source tree, not a copy macOS runs from a read-only place.
        assert!(updates_in_app(Some(BundleType::App), app, false, "macos"));
        assert!(!updates_in_app(Some(BundleType::App), elsewhere, false, "macos"));
        assert!(!updates_in_app(Some(BundleType::App), std::path::Path::new("/private/var/folders/x/AppTranslocation/1/d/Thoth.app/Contents/MacOS/thoth-desktop"), false, "macos"));
        // Windows: whichever installer put it there updates it (NSIS by NSIS, MSI by the MSI).
        assert!(updates_in_app(Some(BundleType::Nsis), elsewhere, false, "windows"));
        assert!(updates_in_app(Some(BundleType::Msi), elsewhere, false, "windows"));
        // Linux: the AppImage replaces itself; a .deb would need root and a password prompt, so it keeps the notice.
        assert!(updates_in_app(Some(BundleType::AppImage), elsewhere, true, "linux"));
        assert!(!updates_in_app(Some(BundleType::AppImage), elsewhere, false, "linux"));
        assert!(!updates_in_app(Some(BundleType::Deb), elsewhere, false, "linux"));
        assert!(!updates_in_app(Some(BundleType::Rpm), elsewhere, false, "linux"));
        // Not bundled (cargo run, tauri dev): never.
        assert!(!updates_in_app(None, app, false, "macos"));
        assert!(!updates_in_app(None, elsewhere, false, "windows"));
    }

    #[test]
    fn the_update_file_comes_from_where_latest_json_is_over_https() {
        let endpoint = tauri::Url::parse("https://download.thothnotes.com/latest.json").unwrap();
        let ok = |u: &str| same_origin(&tauri::Url::parse(u).unwrap(), &endpoint);
        assert!(ok("https://download.thothnotes.com/v0.2.3/Thoth_0.2.3_universal.app.tar.gz"));
        for bad in ["http://download.thothnotes.com/v0.2.3/x", "https://download.thothnotes.com.evil.example/x", "https://evil.example/x", "https://download.thothnotes.com:8443/x", "https://user@download.thothnotes.com/x"] {
            assert!(!ok(bad), "{bad}");
        }
    }

    #[test]
    fn updater_errors_are_told_apart_for_the_popup() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(failure_of(&E::Network("down".into())), Failure::Offline);
        assert_eq!(failure_of(&E::SignatureUtf8("x".into())), Failure::Verify);
        assert_eq!(failure_of(&E::SignedVersionMismatch { signed: "0.2.2".into(), announced: "0.2.3".into() }), Failure::Verify);
        assert_eq!(failure_of(&E::MissingSignedVersion), Failure::Verify);
        assert_eq!(failure_of(&E::Io(std::io::Error::from(std::io::ErrorKind::StorageFull))), Failure::Disk);
        assert_eq!(failure_of(&E::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied))), Failure::Failed);
        assert_eq!(failure_of(&E::TargetsNotFound(vec!["linux-x86_64-deb".into()])), Failure::Failed);
        assert_eq!(failure_of(&E::InvalidUpdaterFormat), Failure::Failed);
    }

    #[test]
    fn the_updater_is_configured_safely() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        // Updater files are built (and signed: the build fails without the private key) with every release.
        assert_eq!(conf["bundle"]["createUpdaterArtifacts"], true);
        let updater = &conf["plugins"]["updater"];
        // The public key the app checks every update with. The placeholder is replaced with the real key before the
        // first release that has it; the release workflow refuses to build a tag with the placeholder.
        let pubkey = updater["pubkey"].as_str().unwrap();
        assert!(pubkey == "THOTH_UPDATER_PUBKEY_PLACEHOLDER" || pubkey.len() > 40, "{pubkey}");
        assert_eq!(updater["endpoints"], json!(["https://download.thothnotes.com/latest.json"]));
        assert_eq!(updater["windows"]["installMode"], "passive");
        let text = include_str!("../tauri.conf.json");
        for dangerous in ["dangerousInsecureTransportProtocol", "dangerousAcceptInvalidCerts", "dangerousAcceptInvalidHostnames", "allowDowngrades"] {
            assert!(!text.contains(dangerous), "{dangerous}");
        }
        // The shell's updater uses the address compiled in, which is https in a release build (build.rs refuses http
        // unless the profile is debug, and the updater itself refuses http in a release build).
        assert!(include_str!("../build.rs").contains("PROFILE"));
        if !cfg!(debug_assertions) {
            assert!(UPDATE_URL.is_empty() || UPDATE_URL.starts_with("https://"));
            assert!(!LOCAL_UPDATE_TEST);
        }
        assert_eq!(LOCAL_UPDATE_TEST, cfg!(debug_assertions) && UPDATE_URL.starts_with("http://127.0.0.1:"));
    }

    #[test]
    fn system_browser_opens_only_web_addresses() {
        // Refusals only: nothing here may launch a browser.
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "-a Calculator", "x-apple.systempreferences:", "https://x.example.org/\nrm", ""] {
            assert_eq!(SystemBrowser.open(bad).unwrap_err().code, "BAD_ARGUMENT", "{bad:?}");
        }
    }

    #[test]
    fn file_manager_gets_the_folder_as_one_argument() {
        // Builds the command only: nothing here may launch a file manager.
        for bad in ["relative/folder", "/tmp/a\nb"] {
            assert_eq!(SystemFileManager::command(std::path::Path::new(bad), None).unwrap_err().code, "BAD_ARGUMENT", "{bad:?}");
        }
        #[cfg(not(windows))]
        let root = std::path::Path::new("/tmp/-a Calculator; rm -rf ~");
        #[cfg(windows)]
        let root = std::path::Path::new(r"C:\tmp\-a Calculator & del x");
        let command = SystemFileManager::command(root, None).unwrap();
        assert_eq!(command.get_args().collect::<Vec<_>>(), vec![root.as_os_str()]);
        #[cfg(target_os = "macos")]
        assert_eq!(command.get_program(), "/usr/bin/open");
        #[cfg(target_os = "windows")]
        assert!(std::path::Path::new(command.get_program()).is_absolute());

        // An entry must be inside the root, absolute and plain; nothing else is built.
        let outside = std::path::Path::new(if cfg!(windows) { r"C:\elsewhere\x.md" } else { "/elsewhere/x.md" });
        assert_eq!(SystemFileManager::command(root, Some(outside)).unwrap_err().code, "BAD_ARGUMENT");
        assert_eq!(SystemFileManager::command(root, Some(&root.join("a\nb.md"))).unwrap_err().code, "BAD_ARGUMENT");
        // macOS selects it in Finder; Linux opens the folder that holds a file (nothing on disk here, so: its parent).
        let entry = root.join("Notes").join("Plan.md");
        let command = SystemFileManager::command(root, Some(&entry)).unwrap();
        #[cfg(target_os = "macos")]
        assert_eq!(command.get_args().collect::<Vec<_>>(), vec![std::ffi::OsStr::new("-R"), entry.as_os_str()]);
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(command.get_args().collect::<Vec<_>>(), vec![root.join("Notes").as_os_str()]);
        #[cfg(target_os = "windows")]
        let _ = command;
    }

    #[test]
    fn csp_is_strict() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.starts_with("default-src 'self'"));
        assert!(!csp.contains("http://") || csp.contains("http://ipc.localhost"));
        assert!(!csp.contains("https:") && !csp.contains("*") && !csp.contains("unsafe-eval"));
        let script = csp.split(';').find(|d| d.trim().starts_with("script-src")).unwrap();
        assert_eq!(script.trim(), "script-src 'self'");
    }

    #[test]
    fn the_identifier_names_the_keychain_service_and_the_old_one_is_still_read() {
        // ADR-0031: the keychain service is the bundle identifier; secrets under the old one are moved on first read.
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], "com.thothnotes.desktop");
        assert_eq!(conf["identifier"], KEYCHAIN_SERVICE);
        assert_eq!(thoth_host::LEGACY_KEYCHAIN_SERVICE, thoth_host::data_dir::LEGACY_IDENTIFIER);
        assert_eq!(KeychainStore::current().service, KEYCHAIN_SERVICE);
        assert_eq!(KeychainStore::legacy().service, "io.github.creaml4tt3.thoth");
    }

    #[test]
    fn windows_installers_keep_the_values_0_2_0_was_built_with() {
        // ADR-0031: the MSI upgrade code was derived from the product name (`Thoth.exe.app.x64`, UUID v5 in the DNS
        // namespace), and the publisher from the identifier's second part (`github`), which names the registry key
        // where both installers remember the install folder. Pinned, so 0.2.1 upgrades 0.2.0 in place.
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["productName"], "Thoth");
        assert_eq!(conf["bundle"]["windows"]["wix"]["upgradeCode"], "86c59b04-326e-5a3d-a791-dc519a7a35af");
        assert_eq!(conf["bundle"]["publisher"], "github");
    }

    #[test]
    fn the_old_data_folder_is_moved_before_the_app_opens_anything() {
        // The move runs in `run` before the builder: Tauri makes the config's windows (and on Linux the webview's
        // folder, which is the data folder) before `setup`, and the host opens the folder in `setup`.
        let source = include_str!("lib.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        let run = &code[code.find("pub fn run()").unwrap()..];
        let moved = run.find("move_legacy_data_dir(").unwrap();
        assert!(moved < run.find("tauri::Builder::default()").unwrap());
        assert!(run.contains(".build(context)"));
    }

    #[test]
    fn decodes_args_header() {
        let (args, bytes) = request_parts(&InvokeBody::Raw(vec![1, 2]), Some("%7B%22path%22%3A%22%E0%B8%81.md%22%7D")).unwrap();
        assert_eq!(args["path"], "ก.md");
        assert_eq!(bytes, Some(vec![1, 2]));
        assert!(request_parts(&InvokeBody::Raw(vec![]), None).is_err());
    }
}
