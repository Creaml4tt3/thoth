//! `thoth-mcp` over stdio (ADR-0021), as an MCP client starts it: the 2025-11-25 handshake (`initialize`), the
//! 2026-07-28 per-request metadata (`server/discover`, `_meta`), the four tools, and every way a call can fail. The
//! running app is played by a socket that records what it is sent. `tests/mcp/schema.test.ts` checks the same answers
//! against the official MCP JSON schemas.
#![cfg(unix)]
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MODERN: &str = "2026-07-28";

struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl Server {
    fn start(socket: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_thoth-mcp"))
            .arg("--socket")
            .arg(socket)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self { child, stdin: Some(stdin), stdout }
    }

    fn send(&mut self, message: &Value) {
        self.send_line(&message.to_string());
    }

    fn send_line(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(line.as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        assert!(line.ends_with('\n') && !line[..line.len() - 1].contains('\n'), "one message per line: {line:?}");
        serde_json::from_str(&line).unwrap()
    }

    fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let answer = self.read();
        assert_eq!(answer["jsonrpc"], "2.0");
        assert_eq!(answer["id"], id);
        answer
    }

    /// The 2025-11-25 handshake as `clientInfo.name`.
    fn initialize(&mut self, app: &str) -> Value {
        let answer =
            self.call(0, "initialize", json!({ "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": app, "version": "1.0.0" } }));
        self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        answer
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The running app's socket: records each request line and answers with `reply(request)`.
struct App {
    socket: PathBuf,
    _dir: tempfile::TempDir,
    seen: Arc<Mutex<Vec<Value>>>,
}

fn app(reply: impl Fn(&Value) -> Value + Send + 'static) -> App {
    let dir = tempfile::Builder::new().prefix("mcp").tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("thoth.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let mut line = String::new();
            BufReader::new(&stream).read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            recorded.lock().unwrap().push(request.clone());
            let answer = reply(&request);
            if !answer.is_null() {
                let _ = (&stream).write_all(format!("{answer}\n").as_bytes());
            }
        }
    });
    App { socket, _dir: dir, seen }
}

fn page_answer(_: &Value) -> Value {
    json!({ "ok": true, "result": { "text": "# Plan\n\nแผนงาน\n", "structured": { "space": "Notes", "path": "Plan.md", "id": "p1", "title": "Plan", "attachments": [] } } })
}

fn meta(app: &str) -> Value {
    json!({ "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { "name": app, "version": "2.0" }, "io.modelcontextprotocol/clientCapabilities": {} })
}

#[test]
fn the_2025_11_25_handshake_then_the_four_read_only_tools() {
    let app = app(page_answer);
    let mut server = Server::start(&app.socket);
    let init = server.initialize("claude-ai");
    assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(init["result"]["capabilities"], json!({ "tools": {} }));
    assert_eq!(init["result"]["serverInfo"]["name"], "thoth");
    assert!(init["result"]["instructions"].as_str().unwrap().contains("read"));
    assert_eq!(server.call(1, "ping", json!({}))["result"], json!({}));

    let tools = server.call(2, "tools/list", json!({}))["result"]["tools"].clone();
    let names: Vec<&str> = tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["search", "list_pages", "read_page", "backlinks"]);
    for tool in tools.as_array().unwrap() {
        assert_eq!(tool["inputSchema"]["type"], "object");
        assert_eq!(tool["annotations"]["readOnlyHint"], true, "{tool}");
        assert_eq!(tool["annotations"]["openWorldHint"], false);
    }
    assert_eq!(tools[0]["inputSchema"]["required"], json!(["query"]));

    let read = server.call(3, "tools/call", json!({ "name": "read_page", "arguments": { "path": "Plan.md" } }));
    assert_eq!(read["result"]["content"], json!([{ "type": "text", "text": "# Plan\n\nแผนงาน\n" }]));
    assert_eq!(read["result"]["structuredContent"]["path"], "Plan.md");
    assert!(read["result"].get("isError").is_none_or(|e| e == false));
    assert!(read["result"].get("resultType").is_none(), "no 2026-07-28 fields in a 2025-11-25 session");
    // The app hears the name the client gave and the arguments as they were.
    assert_eq!(app.seen.lock().unwrap()[0], json!({ "v": 1, "app": "claude-ai", "tool": "read_page", "arguments": { "path": "Plan.md" } }));
}

#[test]
fn older_handshake_versions_are_kept_and_unknown_ones_get_the_latest() {
    let app = app(page_answer);
    let mut server = Server::start(&app.socket);
    let old = server.call(0, "initialize", json!({ "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "old", "version": "0" } }));
    assert_eq!(old["result"]["protocolVersion"], "2024-11-05");
    let mut server = Server::start(&app.socket);
    let future = server.call(0, "initialize", json!({ "protocolVersion": "2099-01-01", "capabilities": {}, "clientInfo": { "name": "new", "version": "0" } }));
    assert_eq!(future["result"]["protocolVersion"], "2025-11-25");
}

#[test]
fn the_2026_07_28_requests_carry_their_version_and_client_in_meta() {
    let app = app(page_answer);
    let mut server = Server::start(&app.socket);
    let discover = server.call(1, "server/discover", json!({ "_meta": meta("Cursor") }));
    let result = &discover["result"];
    assert_eq!(result["supportedVersions"], json!([MODERN]));
    assert_eq!(result["resultType"], "complete");
    assert_eq!(result["capabilities"], json!({ "tools": {} }));
    assert_eq!(result["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "thoth");
    assert!(result["ttlMs"].is_u64() && result["cacheScope"] == "public");

    let list = server.call(2, "tools/list", json!({ "_meta": meta("Cursor") }));
    assert_eq!(list["result"]["resultType"], "complete");
    assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 4);
    assert!(list["result"]["ttlMs"].is_u64());

    let call = server.call(3, "tools/call", json!({ "_meta": meta("Cursor"), "name": "search", "arguments": { "query": "แผน" } }));
    assert_eq!(call["result"]["resultType"], "complete");
    assert_eq!(app.seen.lock().unwrap()[0]["app"], "Cursor");

    let wrong = server.call(
        4,
        "tools/list",
        json!({ "_meta": { "io.modelcontextprotocol/protocolVersion": "1900-01-01", "io.modelcontextprotocol/clientCapabilities": {} } }),
    );
    assert_eq!(wrong["error"]["code"], -32022);
    assert_eq!(wrong["error"]["data"], json!({ "supported": [MODERN], "requested": "1900-01-01" }));
}

#[test]
fn a_call_that_fails_is_a_tool_error_the_model_can_read() {
    let app = app(|request: &Value| match request["tool"].as_str() {
        Some("read_page") => json!({ "ok": false, "error": { "code": "NOT_FOUND", "message": "No page Nope.md in Notes" } }),
        _ => {
            json!({ "ok": false, "error": { "code": "DENIED", "message": "claude-ai may not read your notes: allow it in Thoth, under Settings → Connected apps" } })
        }
    });
    let mut server = Server::start(&app.socket);
    server.initialize("claude-ai");
    let missing = server.call(1, "tools/call", json!({ "name": "read_page", "arguments": { "path": "Nope.md" } }));
    assert_eq!(missing["result"]["isError"], true);
    assert_eq!(missing["result"]["content"][0]["text"], "No page Nope.md in Notes");
    let denied = server.call(2, "tools/call", json!({ "name": "search", "arguments": { "query": "x" } }));
    assert_eq!(denied["result"]["isError"], true);
    assert!(denied["result"]["content"][0]["text"].as_str().unwrap().contains("Settings → Connected apps"));
}

#[test]
fn thoth_not_running_or_switched_off_says_what_to_do() {
    let dir = tempfile::Builder::new().prefix("mcp").tempdir_in("/tmp").unwrap();
    let mut server = Server::start(&dir.path().join("thoth.sock"));
    server.initialize("claude-ai");
    let answer = server.call(1, "tools/call", json!({ "name": "search", "arguments": { "query": "x" } }));
    assert_eq!(answer["result"]["isError"], true);
    assert!(answer["result"]["content"][0]["text"].as_str().unwrap().contains("Open Thoth and switch on Connected apps"), "{answer}");

    // A socket that is a link to somewhere else is not used.
    let real = app(page_answer);
    let link = dir.path().join("link.sock");
    std::os::unix::fs::symlink(&real.socket, &link).unwrap();
    let mut server = Server::start(&link);
    server.initialize("claude-ai");
    let answer = server.call(1, "tools/call", json!({ "name": "search", "arguments": { "query": "x" } }));
    assert_eq!(answer["result"]["isError"], true);
    assert!(real.seen.lock().unwrap().is_empty());
}

#[test]
fn protocol_errors() {
    let app = app(page_answer);
    let mut server = Server::start(&app.socket);
    // Before the handshake and without per-request metadata, a call has no protocol version.
    assert_eq!(server.call(1, "tools/list", json!({}))["error"]["code"], -32602);
    server.initialize("claude-ai");
    assert_eq!(server.call(2, "tools/call", json!({ "name": "write_page", "arguments": {} }))["error"]["code"], -32602);
    assert_eq!(server.call(3, "tools/call", json!({ "arguments": {} }))["error"]["code"], -32602);
    assert_eq!(server.call(4, "tools/call", json!({ "name": "search", "arguments": [1] }))["error"]["code"], -32602);
    assert_eq!(server.call(5, "resources/list", json!({}))["error"]["code"], -32601);
    server.send_line("{not json");
    let parse = server.read();
    assert_eq!(parse["error"]["code"], -32700);
    assert_eq!(parse["id"], Value::Null);
    server.send(&json!({ "jsonrpc": "1.0", "id": 6, "method": "ping" }));
    assert_eq!(server.read()["error"]["code"], -32600);
    // Notifications get no answer; the next request is answered.
    server.send(&json!({ "jsonrpc": "2.0", "method": "notifications/whatever" }));
    assert_eq!(server.call(7, "ping", json!({}))["result"], json!({}));
    assert!(app.seen.lock().unwrap().is_empty(), "nothing reached the app");
}

#[test]
fn a_cancelled_call_gets_no_answer_and_other_requests_go_on_meanwhile() {
    let app = app(|_: &Value| {
        std::thread::sleep(Duration::from_millis(500));
        page_answer(&Value::Null)
    });
    let mut server = Server::start(&app.socket);
    server.initialize("claude-ai");
    server.send(&json!({ "jsonrpc": "2.0", "id": "slow", "method": "tools/call", "params": { "name": "search", "arguments": { "query": "x" } } }));
    // While the app is slow (asking the user, for example), a ping is answered at once.
    assert_eq!(server.call(1, "ping", json!({}))["id"], 1);
    server.send(&json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": "slow", "reason": "user" } }));
    std::thread::sleep(Duration::from_millis(800));
    // The next message on stdout is the answer to this ping, not the cancelled call.
    assert_eq!(server.call(2, "ping", json!({}))["id"], 2);
}

#[test]
fn it_exits_when_its_input_closes() {
    let app = app(page_answer);
    let mut server = Server::start(&app.socket);
    server.initialize("claude-ai");
    server.stdin.take();
    let started = Instant::now();
    loop {
        if server.child.try_wait().unwrap().is_some() {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(5), "still running after its input closed");
        std::thread::sleep(Duration::from_millis(20));
    }
}
