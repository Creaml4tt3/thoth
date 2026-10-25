//! The way to the running app: one connection per tool call to its local socket, one JSON line each way
//! (`crates/thoth-host/src/mcp`):
//!
//! Request:  `{"v": 1, "app": <clientInfo.name or null>, "tool", "arguments"}`
//! Answer:   `{"ok": true, "result": {"text", "structured"}}` or `{"ok": false, "error": {"code", "message"}}`
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// What the user is told when the app is not there to answer.
pub const NOT_RUNNING: &str = "Thoth is not running, or Connected apps is off. Open Thoth and switch on Connected apps (Settings → Connected apps), then try again.";
/// Longest answer read (the app sends at most 1 MB, plus the JSON around it).
#[cfg(unix)]
const MAX_ANSWER: u64 = 2 * 1024 * 1024;

/// A call that did not give an answer, in words for the user (and the model).
#[derive(Debug)]
pub struct Failure {
    pub message: String,
}

impl Failure {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }

    pub fn busy() -> Self {
        Self::new("Too many requests at once: try again")
    }
}

/// The app's usual socket, in its app data folder (the same folder Tauri's `app_data_dir` gives the app).
pub fn default_socket() -> Option<PathBuf> {
    const APP: &str = "io.github.creaml4tt3.thoth";
    let home = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_absolute());
    let data = if cfg!(target_os = "macos") {
        home.map(|h| h.join("Library").join("Application Support"))
    } else if cfg!(unix) {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|d| d.is_absolute()).or_else(|| home.map(|h| h.join(".local").join("share")))
    } else {
        None
    };
    data.map(|d| d.join(APP).join("mcp").join("thoth.sock"))
}

/// One tool call, relayed.
pub fn call(socket: Option<&Path>, app: Option<&str>, tool: &str, arguments: &Value) -> Result<Value, Failure> {
    let socket = socket.ok_or_else(|| Failure::new(NOT_RUNNING))?;
    let request = json!({ "v": 1, "app": app, "tool": tool, "arguments": arguments });
    let answer = exchange(socket, &request.to_string())?;
    let answer: Value = serde_json::from_str(&answer).map_err(|_| Failure::new("Thoth sent an answer this thoth-mcp does not understand: install the same version of both"))?;
    match answer.get("ok").and_then(Value::as_bool) {
        Some(true) => answer.get("result").cloned().ok_or_else(|| Failure::new("Thoth sent an empty answer")),
        _ => Err(Failure::new(answer.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("Thoth could not answer"))),
    }
}

#[cfg(unix)]
fn exchange(socket: &Path, line: &str) -> Result<String, Failure> {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    // Only a socket of this user, at this very path (not a link to one somewhere else).
    let meta = std::fs::symlink_metadata(socket).map_err(|_| Failure::new(NOT_RUNNING))?;
    if !meta.file_type().is_socket() || meta.uid() != rustix::process::geteuid().as_raw() {
        return Err(Failure::new(format!("{} is not Thoth's socket for this user", socket.display())));
    }
    let mut stream = UnixStream::connect(socket).map_err(|_| Failure::new(NOT_RUNNING))?;
    // The app may wait up to a minute for the user's Allow, then up to 15 s for its windows.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(90)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    stream.write_all(line.as_bytes()).and_then(|()| stream.write_all(b"\n")).map_err(|_| Failure::new(NOT_RUNNING))?;
    let mut answer = String::new();
    match BufReader::new(&stream).take(MAX_ANSWER).read_line(&mut answer) {
        Ok(0) => Err(Failure::new("Thoth closed the connection without answering")),
        Ok(_) => Ok(answer),
        Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => Err(Failure::new("Thoth did not answer in time: try again")),
        Err(_) => Err(Failure::new("Thoth's answer could not be read")),
    }
}

#[cfg(not(unix))]
fn exchange(_socket: &Path, _line: &str) -> Result<String, Failure> {
    Err(Failure::new("Connected apps are not available on Windows yet"))
}
