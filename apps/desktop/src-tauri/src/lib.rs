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
//! Workspace servers: the host is the HTTP client. Refresh tokens and personal access tokens go to the OS
//! keychain (`KeychainStore`), sign-in opens the system browser from the host (`SystemBrowser`), and the
//! webview gets no http, opener or shell permission.
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::ipc::{Invoke, InvokeBody, InvokeError, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};
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
            // whose parser would treat `&` in the query as a command separator.
            let mut c = std::process::Command::new("rundll32");
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
        let mut command = std::process::Command::new("explorer");
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut command = std::process::Command::new("xdg-open");
        command.arg(root);
        Ok(command)
    }
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

fn handle(host: &'static OnceLock<Arc<Host>>, invoke: Invoke) -> bool {
    let Some(command) = contract_name(invoke.message.command()) else { return false };
    let Some(host) = host.get().cloned() else {
        invoke.resolver.reject(HostError::internal("Host is not ready"));
        return true;
    };
    let header = invoke.message.headers().get(ARGS_HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let parts = request_parts(invoke.message.payload(), header.as_deref());
    invoke.resolver.respond_async_serialized(async move {
        let (args, bytes) = parts.map_err(InvokeError::from)?;
        // Host calls block (disk, SQLite, native dialogs); keep them off the async runtime and main thread.
        let reply = tauri::async_runtime::spawn_blocking(move || host.call(command, &args, bytes.as_deref()))
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
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
        .plugin(tauri_plugin_dialog::init())
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
            });
            let _ = HOST.set(Arc::new(host));
            Ok(())
        })
        .invoke_handler(|invoke| handle(&HOST, invoke))
        .build(tauri::generate_context!())
        .expect("failed to build the Thoth app")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
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
    fn capability_grants_nothing_but_thoth_commands_and_events() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        for permission in capability["permissions"].as_array().unwrap() {
            let p = permission.as_str().unwrap();
            assert!(p.starts_with("allow-") || p == "core:event:allow-listen" || p == "core:event:allow-unlisten", "unexpected permission {p}");
        }
        assert!(capability.get("remote").is_none());
        let text = include_str!("../capabilities/main.json");
        for plugin in ["http:", "opener:", "shell:", "fs:"] {
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
        let root = std::path::Path::new("/tmp/-a Calculator; rm -rf ~");
        let command = SystemFileManager::command(root).unwrap();
        assert_eq!(command.get_args().collect::<Vec<_>>(), vec![root.as_os_str()]);
        #[cfg(target_os = "macos")]
        assert_eq!(command.get_program(), "/usr/bin/open");
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
