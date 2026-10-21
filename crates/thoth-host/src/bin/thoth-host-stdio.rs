//! JSON-lines harness over `thoth_host::Host`, for the port contract tests and
//! the e2e dev bridge. TEST INFRASTRUCTURE ONLY: never bundled into the app
//! (the desktop crate links the library, not this binary).
//!
//! Request:  {"id", "command", "args", "bytes"?: base64}
//! Response: {"id", "ok", "result"?, "bytes"?: base64, "error"?: {code, message}}
//! Event:    {"event": "vault.changed", "payload"}
//!
//! Flags: --allow-root <dir> (repeatable), --pick-vault <dir>,
//! --pick-source <path>, --data-dir <dir>. Env: THOTH_TEST_DISABLE_HARDLINK=1
//! makes no-replace rename take the exclusive-copy fallback.
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use thoth_host::{Host, HostConfig, HostError, Picker};

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

fn usage(message: &str) -> ! {
    eprintln!("thoth-host-stdio: {message}\nusage: thoth-host-stdio [--allow-root DIR]... [--pick-vault DIR] [--pick-source PATH] [--data-dir DIR]");
    std::process::exit(2);
}

fn main() {
    let mut allow_roots = Vec::new();
    let mut vault = None;
    let mut source = None;
    let mut data_dir = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(flag) = args.next() {
        let mut value = || args.next().map(PathBuf::from).unwrap_or_else(|| usage("missing flag value"));
        match flag.to_str() {
            Some("--allow-root") => allow_roots.push(value()),
            Some("--pick-vault") => vault = Some(value()),
            Some("--pick-source") => source = Some(value()),
            Some("--data-dir") => data_dir = Some(value()),
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
    let host = Host::new(HostConfig {
        data_dir,
        allow_roots,
        picker: Arc::new(FixedPicker { vault, source }),
        events: Arc::new(move |event, payload| event_emit(json!({ "event": event, "payload": payload }))),
        disable_hardlink: std::env::var_os("THOTH_TEST_DISABLE_HARDLINK").is_some_and(|v| v == "1"),
    });

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
        emit(handle(&host, &line));
    }
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
