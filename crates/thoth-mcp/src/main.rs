//! `thoth-mcp`: Thoth's MCP server for other apps (ADR-0021). An MCP client (Claude Desktop, Cursor, …) starts it
//! from its settings and speaks MCP on its stdin and stdout. It opens no vault and keeps nothing: each tool call is
//! relayed over a local socket to the running Thoth app, which checks it, asks the user about an app it has not
//! seen, and answers from the Private Spaces the user shares (read only).
//!
//! The MCP side is hand-written newline-delimited JSON-RPC 2.0 (the stdio transport). It is "dual-era":
//! - 2026-07-28 (current): every request carries its protocol version and client in `_meta`; `server/discover`.
//! - 2025-11-25 and earlier: the `initialize` handshake, then requests without that metadata.
//!
//! Usage: `thoth-mcp [--socket PATH]`. Without `--socket` the app's usual socket is used (`<app data>/mcp/thoth.sock`).
mod relay;
mod tools;

use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// The protocol version that carries its metadata in each request.
const MODERN: &str = "2026-07-28";
/// Handshake versions answered as asked; any other gets the first.
const LEGACY: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const CLIENT_KEY: &str = "io.modelcontextprotocol/clientInfo";
const SERVER_KEY: &str = "io.modelcontextprotocol/serverInfo";
/// Longest message read from stdin; a longer line is answered with a parse error and skipped.
const MAX_MESSAGE: usize = 4 * 1024 * 1024;
/// Tool calls in flight at once.
const MAX_CALLS: usize = 8;

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const UNSUPPORTED_PROTOCOL_VERSION: i64 = -32022;

const INSTRUCTIONS: &str = "Thoth is a notes app. These tools read, and never change, the Private Spaces (folders of \
Markdown pages) that Thoth's user shares with this app. Page paths are relative to their Private Space, like \
Projects/Plan.md. When more than one Private Space is shared, results name theirs in `space`; give `space` to read \
a page. Each app is allowed or denied by the user in Thoth the first time it connects.";

struct Rpc {
    code: i64,
    message: String,
    data: Option<Value>,
}

impl Rpc {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }
}

/// How a request is answered: in the per-request era (with the 2026-07-28 result fields) or in a handshake session.
#[derive(Clone)]
enum Era {
    Modern { app: Option<String> },
    Legacy { app: Option<String> },
}

impl Era {
    fn app(&self) -> Option<String> {
        match self {
            Era::Modern { app } | Era::Legacy { app } => app.clone(),
        }
    }

    /// `result` with what a 2026-07-28 result must have (`resultType`) and should have (who answered).
    fn finish(&self, mut result: Value) -> Value {
        if let Era::Modern { .. } = self {
            result["resultType"] = json!("complete");
            result["_meta"] = json!({ SERVER_KEY: server_info() });
        }
        result
    }
}

struct Server {
    socket: Option<PathBuf>,
    /// The client of a handshake session (`initialize`), once there is one.
    session: Mutex<Option<Option<String>>>,
    out: Mutex<std::io::Stdout>,
    /// Tool calls in flight, by id (JSON text); `true` once cancelled.
    calls: Mutex<HashMap<String, bool>>,
}

fn main() {
    let mut socket = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--socket") => socket = Some(PathBuf::from(args.next().unwrap_or_else(|| usage("--socket needs a path")))),
            Some("--version") => {
                eprintln!("thoth-mcp {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            Some("--help") => usage(""),
            _ => usage(&format!("unknown argument {arg:?}")),
        }
    }
    let server = Arc::new(Server { socket: socket.or_else(relay::default_socket), session: Mutex::new(None), out: Mutex::new(std::io::stdout()), calls: Mutex::new(HashMap::new()) });
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    loop {
        match read_message(&mut input) {
            Message::End => break,
            Message::TooLong => server.write(&error_response(Value::Null, Rpc::new(PARSE_ERROR, "Message too long"))),
            Message::Line(line) => {
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                server.receive(&line);
            }
        }
    }
    // The client closed our input: that is the end (in-flight calls are not answered).
}

fn usage(message: &str) -> ! {
    if !message.is_empty() {
        eprintln!("thoth-mcp: {message}");
    }
    eprintln!("usage: thoth-mcp [--socket PATH]\nThoth's MCP server: add it to an MCP client's settings (Thoth → Settings → Connected apps → Copy the setup).");
    std::process::exit(2);
}

enum Message {
    Line(Vec<u8>),
    TooLong,
    End,
}

/// One newline-delimited message, at most `MAX_MESSAGE` bytes; a longer one is read to its end and dropped.
fn read_message(input: &mut impl BufRead) -> Message {
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let buffer = match input.fill_buf() {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Message::End,
        };
        if buffer.is_empty() {
            return if line.is_empty() || too_long { Message::End } else { Message::Line(line) };
        }
        let (chunk, done) = match buffer.iter().position(|b| *b == b'\n') {
            Some(i) => (&buffer[..i], Some(i + 1)),
            None => (buffer, None),
        };
        if !too_long && line.len() + chunk.len() <= MAX_MESSAGE {
            line.extend_from_slice(chunk);
        } else {
            too_long = true;
            line.clear();
        }
        let used = done.unwrap_or(buffer.len());
        input.consume(used);
        if done.is_some() {
            return if too_long { Message::TooLong } else { Message::Line(line) };
        }
    }
}

impl Server {
    fn write(&self, message: &Value) {
        let mut out = self.out.lock().unwrap_or_else(|p| p.into_inner());
        // serde_json escapes newlines inside strings, so a message is always one line.
        let _ = writeln!(out, "{message}");
        let _ = out.flush();
    }

    fn receive(self: &Arc<Self>, line: &[u8]) {
        let Ok(message) = serde_json::from_slice::<Value>(line) else {
            return self.write(&error_response(Value::Null, Rpc::new(PARSE_ERROR, "Parse error")));
        };
        let Some(object) = message.as_object() else {
            return self.write(&error_response(Value::Null, Rpc::new(INVALID_REQUEST, "A message is one JSON-RPC object (batches are not supported)")));
        };
        let id = object.get("id").cloned();
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return self.write(&error_response(id.unwrap_or(Value::Null), Rpc::new(INVALID_REQUEST, "jsonrpc must be \"2.0\"")));
        }
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            // A response from the client: this server sends no requests, so there is nothing to match it with.
            return;
        };
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
        match id {
            None => self.notification(method, &params),
            Some(id) if id.is_string() || id.is_i64() || id.is_u64() => self.request(id, method, &params),
            Some(_) => self.write(&error_response(Value::Null, Rpc::new(INVALID_REQUEST, "id must be a string or an integer"))),
        }
    }

    fn notification(&self, method: &str, params: &Value) {
        if method == "notifications/cancelled"
            && let Some(id) = params.get("requestId")
            && let Some(cancelled) = self.calls.lock().unwrap_or_else(|p| p.into_inner()).get_mut(&id.to_string())
        {
            *cancelled = true;
        }
        // notifications/initialized and anything else: nothing to do.
    }

    fn request(self: &Arc<Self>, id: Value, method: &str, params: &Value) {
        if !params.is_object() {
            return self.write(&error_response(id, Rpc::new(INVALID_PARAMS, "params must be an object")));
        }
        let answer = match method {
            "initialize" => Ok(self.initialize(params)),
            "ping" => self.era(params).or_else(|_| Ok(Era::Legacy { app: None })).map(|era| era.finish(json!({}))),
            "server/discover" => self.discover(params),
            "tools/list" => self.era(params).map(|era| {
                let mut result = json!({ "tools": tools::definitions() });
                if let Era::Modern { .. } = era {
                    // CacheableResult: the list changes only with a new Thoth (and this program with it).
                    result["ttlMs"] = json!(3_600_000);
                    result["cacheScope"] = json!("public");
                }
                era.finish(result)
            }),
            "tools/call" => match self.era(params).and_then(|era| tools::check(params).map(|call| (era, call))) {
                Ok((era, (name, arguments))) => return self.call(id, era, name, arguments),
                Err(error) => Err(error),
            },
            _ => Err(Rpc::new(METHOD_NOT_FOUND, format!("Method not found: {method}"))),
        };
        self.write(&match answer {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => error_response(id, error),
        });
    }

    /// The 2025-11-25 (and earlier) handshake: the version asked for if this server knows it, else its latest.
    fn initialize(&self, params: &Value) -> Value {
        let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
        let version = LEGACY.iter().find(|v| **v == asked).copied().unwrap_or(LEGACY[0]);
        let app = params.get("clientInfo").and_then(|c| c.get("name")).and_then(Value::as_str).map(str::to_owned);
        *self.session.lock().unwrap_or_else(|p| p.into_inner()) = Some(app);
        json!({ "protocolVersion": version, "capabilities": { "tools": {} }, "serverInfo": server_info(), "instructions": INSTRUCTIONS })
    }

    fn discover(&self, params: &Value) -> Result<Value, Rpc> {
        let era = match requested_version(params) {
            Some(_) => self.era(params)?,
            None => Era::Modern { app: None },
        };
        Ok(Era::Modern { app: era.app() }.finish(json!({ "supportedVersions": [MODERN], "capabilities": { "tools": {} }, "instructions": INSTRUCTIONS, "ttlMs": 3_600_000, "cacheScope": "public" })))
    }

    /// Which era a request is in: its own `_meta` version (2026-07-28), else the handshake session.
    fn era(&self, params: &Value) -> Result<Era, Rpc> {
        if let Some(version) = requested_version(params) {
            if version != MODERN {
                return Err(Rpc { code: UNSUPPORTED_PROTOCOL_VERSION, message: "Unsupported protocol version".into(), data: Some(json!({ "supported": [MODERN], "requested": version })) });
            }
            let app = params["_meta"].get(CLIENT_KEY).and_then(|c| c.get("name")).and_then(Value::as_str).map(str::to_owned);
            return Ok(Era::Modern { app });
        }
        match &*self.session.lock().unwrap_or_else(|p| p.into_inner()) {
            Some(app) => Ok(Era::Legacy { app: app.clone() }),
            None => Err(Rpc::new(INVALID_PARAMS, format!("No protocol version: put {VERSION_KEY} ({MODERN}) in _meta, or send initialize first"))),
        }
    }

    /// Runs a tool call on its own thread (the app may be waiting for the user's Allow), answering unless cancelled.
    fn call(self: &Arc<Self>, id: Value, era: Era, name: String, arguments: Map<String, Value>) {
        let key = id.to_string();
        {
            let mut calls = self.calls.lock().unwrap_or_else(|p| p.into_inner());
            if calls.len() >= MAX_CALLS || calls.contains_key(&key) {
                drop(calls);
                let busy = tools::result(Err(relay::Failure::busy()));
                return self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": era.finish(busy) }));
            }
            calls.insert(key.clone(), false);
        }
        let server = self.clone();
        let started = key.clone();
        let spawned = std::thread::Builder::new().name("thoth-mcp-call".into()).spawn(move || {
            let outcome = relay::call(server.socket.as_deref(), era.app().as_deref(), &name, &Value::Object(arguments));
            let result = era.finish(tools::result(outcome));
            let cancelled = server.calls.lock().unwrap_or_else(|p| p.into_inner()).remove(&key).unwrap_or(false);
            if !cancelled {
                server.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
            }
        });
        if spawned.is_err() {
            self.calls.lock().unwrap_or_else(|p| p.into_inner()).remove(&started);
        }
    }
}

fn requested_version(params: &Value) -> Option<&str> {
    params.get("_meta").and_then(|m| m.get(VERSION_KEY)).and_then(Value::as_str)
}

fn server_info() -> Value {
    json!({ "name": "thoth", "title": "Thoth", "version": env!("CARGO_PKG_VERSION") })
}

/// An error response; `id` is left out when the request's could not be read (a parse error).
fn error_response(id: Value, error: Rpc) -> Value {
    let mut body = json!({ "code": error.code, "message": error.message });
    if let Some(data) = error.data {
        body["data"] = data;
    }
    let mut response = json!({ "jsonrpc": "2.0", "error": body });
    if !id.is_null() {
        response["id"] = id;
    }
    response
}
