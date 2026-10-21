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
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::ipc::{Invoke, InvokeBody, InvokeError, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use thoth_host::{Host, HostConfig, HostError, Picker};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    static HOST: OnceLock<Arc<Host>> = OnceLock::new();
    tauri::Builder::default()
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
