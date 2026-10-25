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
//! as the window that asked (`Host::call_as`), and a closed window's vaults and agent runs end with it (`Host::release`).
//!
//! Workspace servers: the host is the HTTP client. Refresh tokens and personal access tokens go to the OS
//! keychain (`KeychainStore`), sign-in opens the system browser from the host (`SystemBrowser`), and the
//! webview gets no http, opener or shell permission.
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::ipc::{Invoke, InvokeBody, InvokeError, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use thoth_host::{Browser, FileManager, Host, HostConfig, HostError, HostResult, KEYCHAIN_SERVICE, Picker, SecretStore};

pub const ARGS_HEADER: &str = "x-thoth-args";
pub const VAULT_CHANGED_EVENT: &str = "vault:changed";

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
}

/// Workspace-server secrets in the OS keychain (macOS Keychain, Windows Credential Manager, Linux keyutils),
/// service `io.github.creaml4tt3.thoth`, account = the server's handle. Errors never include the secret.
struct KeychainStore;

impl KeychainStore {
    fn entry(server: &str) -> HostResult<keyring::Entry> {
        keyring::Entry::new(KEYCHAIN_SERVICE, server).map_err(|_| HostError::internal("The system keychain is not available"))
    }
}

impl SecretStore for KeychainStore {
    fn get(&self, server: &str) -> HostResult<Option<String>> {
        match Self::entry(server)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(HostError::internal("Could not read from the system keychain")),
        }
    }

    fn set(&self, server: &str, secret: &str) -> HostResult<()> {
        Self::entry(server)?.set_password(secret).map_err(|_| HostError::internal("Could not write to the system keychain"))
    }

    fn delete(&self, server: &str) -> HostResult<()> {
        match Self::entry(server)?.delete_credential() {
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

/// Shows a vault folder in Finder, File Explorer or the Linux file manager. The host passes only the canonical root
/// of an open vault; it goes to the launcher as one argument (no shell). An absolute path starts with `/` or a
/// drive letter, so the launcher cannot read it as an option.
struct SystemFileManager;

impl SystemFileManager {
    fn command(root: &std::path::Path) -> HostResult<std::process::Command> {
        if !root.is_absolute() || root.as_os_str().to_string_lossy().chars().any(char::is_control) {
            return Err(HostError::bad_argument("Only an open Private Space folder can be shown"));
        }
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("/usr/bin/open");
        #[cfg(target_os = "windows")]
        let mut command = std::process::Command::new(windows_tool("explorer.exe"));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut command = std::process::Command::new("xdg-open");
        command.arg(root);
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
    fn reveal(&self, root: &std::path::Path) -> HostResult<()> {
        let mut command = Self::command(root)?;
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
fn new_window(args: &Value, recent: &[String]) -> HostResult<NewWindow> {
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
                let window = new_window(&args, &host.recent()).map_err(InvokeError::from)?;
                if app.get_webview_window(&window.label).is_some() {
                    return Err(InvokeError::from(HostError::bad_argument("That window is open already")));
                }
                let mut builder = WebviewWindowBuilder::new(&app, &window.label, WebviewUrl::App(window.page.into()))
                    .title("Thoth")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(720.0, 480.0)
                    .focused(true);
                // The tab was let go here: the new window's tab bar starts under the pointer.
                if let Some((x, y)) = window.at {
                    builder = builder.position((x - 140.0).max(0.0), (y - 20.0).max(0.0));
                }
                builder.build().map_err(|e| InvokeError::from(HostError::internal(format!("The window could not be opened: {e}"))))?;
                Ok(InvokeResponseBody::Json("null".to_owned()))
            }
            "window_close" => {
                // The last window stays (Cmd/Ctrl+W leaves it an empty tab); closing it would quit the app.
                let others = app.webview_windows().keys().any(|label| label != &caller);
                if others {
                    if let Some(window) = app.get_webview_window(&caller) {
                        window.close().map_err(|e| InvokeError::from(HostError::internal(format!("The window could not be closed: {e}"))))?;
                    }
                }
                Ok(InvokeResponseBody::Json(others.to_string()))
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

/// The macOS menu bar: Tauri's default menu without "Close Window", whose Cmd+W would close the app window before
/// the page sees the key. Cmd+W closes a tab (ADR-0016 rule 5); the window's red button still closes the window.
#[cfg(target_os = "macos")]
fn app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
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
            &PredefinedMenuItem::quit(app, None)?,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    static HOST: OnceLock<Arc<Host>> = OnceLock::new();
    /// Set once the app is quitting: windows destroyed then are not "closed by the user" (they come back next time).
    static EXITING: AtomicBool = AtomicBool::new(false);
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
        .plugin(tauri_plugin_dialog::init())
        // System notifications (ADR-0018): the webview may only check and ask for the permission and show one.
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let emitter = handle.clone();
            let host = Host::new(HostConfig {
                data_dir: app.path().app_data_dir().ok(),
                allow_roots: Vec::new(),
                picker: Arc::new(DialogPicker { app: handle }),
                events: Arc::new(move |_event, payload| {
                    let _ = emitter.emit(VAULT_CHANGED_EVENT, payload);
                }),
                disable_hardlink: false,
                secrets: Arc::new(KeychainStore),
                browser: Arc::new(SystemBrowser),
                file_manager: Arc::new(SystemFileManager),
                // Agent CLIs are found on PATH and in the usual install folders, never in a folder the webview names.
                agent_search_dirs: None,
            });
            let _ = HOST.set(Arc::new(host));
            Ok(())
        })
        .invoke_handler(|invoke| handle(&HOST, invoke))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label().to_owned();
                // Its vaults (watchers, index connections) close and its agent runs end, as all of them do at quit.
                if let Some(host) = HOST.get() {
                    host.release(&label);
                }
                if !EXITING.load(Ordering::SeqCst) {
                    let _ = window.app_handle().emit(WINDOW_CLOSED_EVENT, label);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Thoth app")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                EXITING.store(true, Ordering::SeqCst);
            }
            if let tauri::RunEvent::Exit = event {
                EXITING.store(true, Ordering::SeqCst);
                // Stop watchers and delete import temp files before the process exits.
                if let Some(host) = HOST.get() {
                    host.shutdown();
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
        let window = new_window(&ok, &recent).unwrap();
        assert_eq!(window.label, "space-ab12");
        assert_eq!(window.at, Some((900.5, 400.0)));
        // Always the app's own page; what it shows travels escaped, so nothing in it adds to or ends the query.
        assert!(window.page.starts_with("index.html?window=space-ab12&root=%2FUsers%2Fa%2FNotes%20%26%20more&tabs=%7B"));
        assert_eq!(window.page.matches('?').count(), 1);
        assert_eq!(window.page.matches('&').count(), 2);
        assert!(!window.page.contains('#'));
        assert_eq!(new_window(&json!({ "id": "space-ab12", "root": "/Users/a/Notes & more", "tabs": "x" }), &recent).unwrap().at, None);

        let refused = |args: Value| new_window(&args, &recent).unwrap_err().code;
        assert_eq!(refused(json!({ "id": "main", "root": "/Users/a/Notes & more", "tabs": "x" })), "BAD_ARGUMENT");
        assert_eq!(refused(json!({ "id": "space-x", "root": "/Users/a/Other", "tabs": "x" })), "NOT_ALLOWED");
        assert_eq!(refused(json!({ "id": "space-x", "root": "/Users/a/Notes & more", "tabs": "x".repeat(MAX_LAUNCH_TABS + 1) })), "BAD_ARGUMENT");
        assert_eq!(refused(json!({ "id": "space-x", "root": "/Users/a/Notes & more", "tabs": "x", "at": { "x": "1", "y": 2 } })), "BAD_ARGUMENT");
        assert_eq!(refused(json!({ "id": "space-x", "root": "/Users/a/Notes & more" })), "BAD_ARGUMENT");
        // An address in the request is not used: the page is the app's own whatever else is sent.
        let elsewhere = new_window(&json!({ "id": "space-x", "url": "https://example.org/", "root": "/Users/a/Notes & more", "tabs": "x" }), &recent).unwrap();
        assert!(elsewhere.page.starts_with("index.html?window=space-x&") && !elsewhere.page.contains("example.org"));
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
            assert_eq!(SystemFileManager::command(std::path::Path::new(bad)).unwrap_err().code, "BAD_ARGUMENT", "{bad:?}");
        }
        #[cfg(not(windows))]
        let root = std::path::Path::new("/tmp/-a Calculator; rm -rf ~");
        #[cfg(windows)]
        let root = std::path::Path::new(r"C:\tmp\-a Calculator & del x");
        let command = SystemFileManager::command(root).unwrap();
        assert_eq!(command.get_args().collect::<Vec<_>>(), vec![root.as_os_str()]);
        #[cfg(target_os = "macos")]
        assert_eq!(command.get_program(), "/usr/bin/open");
        #[cfg(target_os = "windows")]
        assert!(std::path::Path::new(command.get_program()).is_absolute());
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
    fn decodes_args_header() {
        let (args, bytes) = request_parts(&InvokeBody::Raw(vec![1, 2]), Some("%7B%22path%22%3A%22%E0%B8%81.md%22%7D")).unwrap();
        assert_eq!(args["path"], "ก.md");
        assert_eq!(bytes, Some(vec![1, 2]));
        assert!(request_parts(&InvokeBody::Raw(vec![]), None).is_err());
    }
}
