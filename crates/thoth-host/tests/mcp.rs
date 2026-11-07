//! Connected apps (ADR-0021): the relay between `thoth-mcp` (played here by a socket client) and the app's windows
//! (played by a thread that answers `mcp.request` events as a window's open Vault would).
#![cfg(unix)]
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thoth_host::mcp::{McpOptions, OpenSpace, Relay};

const NOTES: &str = "/Users/someone/Notes";
const WORK: &str = "/Users/someone/Work";
const PLAN: &str = "# Plan\n\nSecret words here.\n\n## Next\n\n- one\n- one more\n";
const PLAN_HASH: &str = "5f1d0c";

/// What a window answers for each tool, from a two-page Private Space.
fn window_answer(tool: &str, args: &Value) -> Value {
    match tool {
        "search" => json!({ "result": { "hits": [{ "id": "p1", "path": "Plan.md", "title": "Plan", "snippet": "the [แผน] for 2027" }] } }),
        "list_pages" => {
            json!({ "result": { "pages": [{ "id": "p1", "path": "Plan.md", "title": "Plan" }, { "id": "p2", "path": "Log.md", "title": "Log" }], "total": 2 } })
        }
        "read_page" if args["path"] == "Plan.md" || args["id"] == "p1" => {
            json!({ "result": { "page": { "id": "p1", "path": "Plan.md", "title": "Plan", "markdown": PLAN, "attachments": ["chart.png"], "hash": PLAN_HASH } } })
        }
        // Today's note (ADR-0051) is not there yet: the window says where it goes and how it would start.
        "read_page" if args["today"] == true => json!({ "result": { "page": null, "today": { "path": "Daily/2026-11-07.md", "markdown": "# 2026-11-07\n" } } }),
        "read_page" | "backlinks" if args["path"] != "Plan.md" => json!({ "error": { "code": "NOT_FOUND", "message": "No page Nope.md" } }),
        "backlinks" => {
            json!({ "result": { "page": { "id": "p1", "path": "Plan.md", "title": "Plan" }, "links": [{ "id": "p2", "path": "Log.md", "title": "Log", "line": 3 }], "total": 1 } })
        }
        "memory_change" => memory_change(args),
        // An empty memory folder: the host records it without asking.
        "memory_folder" => json!({ "result": { "pages": 0, "thoth": false } }),
        "memory_commit" => json!({ "result": if args["op"] == "write" { json!({ "hash": "h2" }) } else { json!({}) } }),
        "recall" => json!({ "result": {
            "about": { "path": "Memory/About me.md", "id": "a1", "updated": "2026-11-01T09:00:00+07:00", "text": "Ploy, a designer in Chiang Mai." },
            "memories": [memory(false), memory(true)], "total": 2
        } }),
        "list_memories" => json!({ "result": { "memories": [memory(false), memory(true), memory(false)], "total": 3 } }),
        "list_skills" => json!({ "result": { "skills": [
            { "name": "weekly-update", "description": "Writes the weekly update. Use it on Fridays.", "path": "Skills/weekly-update/SKILL.md", "secret": "never shown" }
        ] } }),
        "get_skill" if args["name"] == "weekly-update" && args.get("file").is_none() => json!({ "result": { "skill": {
            "name": "weekly-update", "path": "Skills/weekly-update/SKILL.md", "text": "---\nname: weekly-update\n---\nBlockers first.\n", "files": ["references/style.md"]
        } } }),
        "get_skill" => json!({ "result": { "skill": null } }),
        _ => json!({ "error": { "code": "INTERNAL", "message": "?" } }),
    }
}

/// A memory as a window gives it (ADR-0052): a preference, or old work that is past its "Check after" age.
fn memory(stale: bool) -> Value {
    let (path, kind, age) = if stale { ("Memory/launch.md", "work", 40) } else { ("Memory/blockers-first.md", "preference", 2) };
    json!({
        "path": path, "id": format!("id-{kind}"), "kind": kind, "title": "Blockers first", "source": "Claude Code",
        "created": "2026-10-01T09:00:00+07:00", "updated": "2026-10-01T09:00:00+07:00", "updatedBy": "Codex", "topic": null,
        "tags": ["writing"], "certainty": "stated", "ageDays": age, "stale": stale, "text": "Put blockers first.", "secret": "never shown"
    })
}

/// What a window works out for a memory change: a new memory, an update or a forget, from `args` as the host sent them.
fn memory_change(args: &Value) -> Value {
    let text = args["text"].as_str().unwrap_or_default();
    if text.contains("forgotten") {
        return json!({ "error": { "code": "FORGOTTEN", "message": "The user asked to forget this memory." } });
    }
    let path = if text == "outside" { "Notes/Plan.md".to_owned() } else { format!("{}/blockers-first.md", args["folder"].as_str().unwrap()) };
    let change = match args["op"].as_str().unwrap() {
        "remember" => {
            json!({ "op": "create", "before": null, "after": format!("---\nkind: {}\n---\n{text}\n", args["kind"].as_str().unwrap()), "baseHash": null })
        }
        "update" => json!({ "op": "update", "before": "old", "after": if text == "same" { "old".to_owned() } else { format!("{text}\n") }, "baseHash": "h1" }),
        _ => json!({ "op": "forget", "before": "old", "after": null, "baseHash": "h1" }),
    };
    let mut change = change;
    change["path"] = json!(path);
    change["id"] = json!("m1");
    change["kind"] = json!("preference");
    change["title"] = json!("Blockers first");
    json!({ "result": change })
}

struct Fixture {
    relay: Arc<Relay>,
    dir: PathBuf,
    _data: tempfile::TempDir,
    open: Arc<Mutex<Vec<OpenSpace>>>,
    /// Every `mcp.request` the windows were sent.
    requests: Arc<Mutex<Vec<Value>>>,
    pending: Receiver<Value>,
    /// The windows answer (true) or stay silent (false).
    answering: Arc<Mutex<bool>>,
    /// Replaces the windows' answer when set.
    answer_with: Arc<Mutex<Option<Value>>>,
    /// Every `mcp.proposals` event.
    proposals: Arc<Mutex<Vec<Value>>>,
    /// Every `mcp.memories` event.
    memories: Arc<Mutex<Vec<Value>>>,
}

fn fixture(options: McpOptions) -> Fixture {
    let data = tempfile::Builder::new().prefix("mcp").tempdir_in("/tmp").unwrap();
    let dir = data.path().join("mcp");
    let open = Arc::new(Mutex::new(vec![OpenSpace { root: NOTES.into(), owner: "main".into() }]));
    let (events_tx, events_rx) = channel::<(String, Value)>();
    let events_tx = Mutex::new(events_tx);
    let spaces = {
        let open = open.clone();
        Arc::new(move || open.lock().unwrap().iter().map(|s| OpenSpace { root: s.root.clone(), owner: s.owner.clone() }).collect())
    };
    let relay = Arc::new(Relay::new(
        Some(dir.clone()),
        Arc::new(move |event: &str, payload: Value| events_tx.lock().unwrap().send((event.to_owned(), payload)).unwrap()),
        spaces,
        options,
    ));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let answering = Arc::new(Mutex::new(true));
    let answer_with = Arc::new(Mutex::new(None));
    let (pending_tx, pending) = channel();
    let proposals = Arc::new(Mutex::new(Vec::new()));
    let memories = Arc::new(Mutex::new(Vec::new()));
    {
        let memories_heard = memories.clone();
        let (relay, requests, answering, answer_with) = (Arc::downgrade(&relay), requests.clone(), answering.clone(), answer_with.clone());
        let proposals_heard = proposals.clone();
        std::thread::spawn(move || {
            for (event, payload) in events_rx {
                match event.as_str() {
                    "mcp.pending" => {
                        let _ = pending_tx.send(payload);
                    }
                    "mcp.proposals" => proposals_heard.lock().unwrap().push(payload),
                    "mcp.memories" => memories_heard.lock().unwrap().push(payload),
                    "mcp.request" => {
                        requests.lock().unwrap().push(payload.clone());
                        let Some(relay) = relay.upgrade() else { return };
                        if *answering.lock().unwrap() {
                            let answer =
                                answer_with.lock().unwrap().clone().unwrap_or_else(|| window_answer(payload["tool"].as_str().unwrap(), &payload["args"]));
                            relay.answer(payload["owner"].as_str().unwrap(), payload["id"].as_str().unwrap(), &answer).unwrap();
                        }
                    }
                    other => panic!("unexpected event {other}"),
                }
            }
        });
    }
    Fixture { relay, dir, _data: data, open, requests, pending, answering, answer_with, proposals, memories }
}

fn fast() -> McpOptions {
    McpOptions { prompt_timeout: Duration::from_secs(5), answer_timeout: Duration::from_secs(5), read_timeout: Duration::from_secs(5) }
}

/// Switches on, shares `NOTES` and allows `app`.
fn ready(f: &Fixture, app: &str) {
    f.relay.configure(&json!({ "enabled": true, "spaces": [NOTES] }), &[NOTES.to_owned(), WORK.to_owned()]).unwrap();
    let asking = {
        let socket = socket(f);
        let app = app.to_owned();
        std::thread::spawn(move || ask(&socket, &app, "list_pages", json!({})))
    };
    pending_is(f, json!({ "apps": [app] }));
    f.relay.decide(app, true).unwrap();
    assert_eq!(asking.join().unwrap()["ok"], true);
}

/// Waits for the windows to hear that the apps waiting for an answer are `expected` (`{ apps }`, and `proposers`
/// when given).
fn pending_is(f: &Fixture, expected: Value) {
    loop {
        let heard = f.pending.recv_timeout(Duration::from_secs(5)).expect("the windows hear who is waiting");
        if heard["apps"] == expected["apps"] && (expected.get("proposers").is_none() || heard["proposers"] == expected["proposers"]) {
            return;
        }
    }
}

fn socket(f: &Fixture) -> PathBuf {
    f.dir.join("thoth.sock")
}

/// One request as `thoth-mcp` sends it.
fn ask(socket: &Path, app: &str, tool: &str, arguments: Value) -> Value {
    send(socket, &json!({ "v": 1, "app": app, "tool": tool, "arguments": arguments }).to_string())
}

fn send(socket: &Path, line: &str) -> Value {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream.write_all(line.as_bytes()).unwrap();
    stream.write_all(b"\n").unwrap();
    let mut answer = String::new();
    BufReader::new(stream).read_line(&mut answer).unwrap();
    serde_json::from_str(&answer).unwrap()
}

fn error_code(answer: &Value) -> &str {
    assert_eq!(answer["ok"], false, "{answer}");
    answer["error"]["code"].as_str().unwrap()
}

#[test]
fn it_is_off_until_switched_on_and_then_listens_on_an_owner_only_socket() {
    let f = fixture(fast());
    let settings = f.relay.settings();
    assert_eq!(settings["enabled"], false);
    assert_eq!(settings["listening"], false);
    assert_eq!(settings["spaces"], json!([]));
    assert!(!socket(&f).exists(), "no socket while off");

    let settings = f.relay.configure(&json!({ "enabled": true }), &[]).unwrap();
    assert_eq!((settings["enabled"].clone(), settings["listening"].clone()), (json!(true), json!(true)));
    let dir = std::fs::symlink_metadata(&f.dir).unwrap();
    let sock = std::fs::symlink_metadata(socket(&f)).unwrap();
    assert_eq!(dir.permissions().mode() & 0o777, 0o700);
    assert_eq!(sock.permissions().mode() & 0o777, 0o600);
    assert_eq!(sock.uid(), dir.uid());
    assert_eq!(sock.uid(), euid());
    // The setup to paste into an app names the sidecar next to this program and this socket.
    assert_eq!(settings["setup"]["args"], json!(["--socket", socket(&f)]));
    assert!(settings["setup"]["command"].as_str().unwrap().ends_with("/thoth-mcp"));

    // Switched off: the socket goes, and the setting is remembered by the next start.
    f.relay.configure(&json!({ "enabled": false }), &[]).unwrap();
    assert!(!socket(&f).exists());
    let again = Relay::new(Some(f.dir.clone()), Arc::new(|_: &str, _: Value| {}), Arc::new(Vec::new), fast());
    assert_eq!(again.settings()["enabled"], false);
    let settings: Value = serde_json::from_slice(&std::fs::read(f.dir.join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["enabled"], false);
    assert_eq!(std::fs::metadata(f.dir.join("settings.json")).unwrap().permissions().mode() & 0o777, 0o600);
}

/// The effective user id: the owner of a file this test makes.
fn euid() -> u32 {
    let probe = tempfile::NamedTempFile::new().unwrap();
    std::fs::metadata(probe.path()).unwrap().uid()
}

#[test]
fn a_folder_that_is_not_the_users_own_is_refused() {
    let f = fixture(fast());
    let elsewhere = tempfile::tempdir_in("/tmp").unwrap();
    std::fs::create_dir_all(f.dir.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), &f.dir).unwrap();
    let error = f.relay.configure(&json!({ "enabled": true }), &[]).unwrap_err();
    assert_eq!(error.code, "UNAVAILABLE");
    assert_eq!(f.relay.settings()["enabled"], false);
    assert!(!elsewhere.path().join("thoth.sock").exists());
}

#[test]
fn only_private_spaces_the_user_opened_can_be_shared() {
    let f = fixture(fast());
    assert_eq!(f.relay.configure(&json!({ "spaces": ["/etc"] }), &[NOTES.to_owned()]).unwrap_err().code, "NOT_ALLOWED");
    assert_eq!(f.relay.configure(&json!({ "spaces": "x" }), &[NOTES.to_owned()]).unwrap_err().code, "BAD_ARGUMENT");
    assert_eq!(f.relay.configure(&json!({ "spaces": [NOTES, NOTES] }), &[NOTES.to_owned()]).unwrap()["spaces"], json!([NOTES]));
}

#[test]
fn a_new_app_is_asked_about_once_then_remembered() {
    let f = fixture(fast());
    f.relay.configure(&json!({ "enabled": true, "spaces": [NOTES] }), &[NOTES.to_owned()]).unwrap();
    let socket = socket(&f);
    let asking = {
        let socket = socket.clone();
        std::thread::spawn(move || ask(&socket, "Claude\u{202E}\u{0007} Desktop", "search", json!({ "query": "แผน" })))
    };
    // The windows hear who asks (control and direction characters taken out, so the name shows as it is).
    pending_is(&f, json!({ "apps": ["Claude Desktop"] }));
    assert_eq!(f.relay.settings()["pending"], json!(["Claude Desktop"]));
    assert!(f.requests.lock().unwrap().is_empty(), "nothing is read before the user answers");
    f.relay.decide("Claude Desktop", true).unwrap();
    let answer = asking.join().unwrap();
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(
        answer["result"]["structured"],
        json!({ "results": [{ "space": "Notes", "path": "Plan.md", "title": "Plan", "id": "p1", "snippet": "the [แผน] for 2027" }] })
    );
    pending_is(&f, json!({ "apps": [] }));

    // Remembered: asked again, no question.
    assert_eq!(ask(&socket, "Claude Desktop", "list_pages", json!({}))["ok"], true);
    assert!(f.pending.try_recv().is_err());
    let apps = f.relay.settings()["apps"].clone();
    assert_eq!(apps[0]["name"], "Claude Desktop");
    assert_eq!(apps[0]["allowed"], true);
    // The window was asked with the checked arguments, for the shared Private Space only.
    let request = f.requests.lock().unwrap()[0].clone();
    assert_eq!(
        (request["owner"].clone(), request["root"].clone(), request["tool"].clone(), request["args"].clone()),
        (json!("main"), json!(NOTES), json!("search"), json!({ "query": "แผน", "limit": 10 }))
    );
}

#[test]
fn a_denied_or_revoked_app_gets_nothing_and_a_forgotten_one_is_asked_again() {
    let f = fixture(fast());
    ready(&f, "Cursor");
    let socket = socket(&f);
    f.relay.decide("Cursor", false).unwrap();
    assert_eq!(error_code(&ask(&socket, "Cursor", "search", json!({ "query": "x" }))), "DENIED");
    let asked = f.requests.lock().unwrap().len();

    f.relay.forget("Cursor").unwrap();
    let asking = {
        let socket = socket.clone();
        std::thread::spawn(move || ask(&socket, "Cursor", "search", json!({ "query": "x" })))
    };
    pending_is(&f, json!({ "apps": ["Cursor"] }));
    f.relay.decide("Cursor", false).unwrap();
    assert_eq!(error_code(&asking.join().unwrap()), "DENIED");
    assert_eq!(f.requests.lock().unwrap().len(), asked, "a denied app reaches no window");
    // Only an app that asked can be decided on.
    assert_eq!(f.relay.decide("Never Asked", true).unwrap_err().code, "BAD_ARGUMENT");
}

#[test]
fn an_unanswered_question_times_out_and_switching_off_ends_it() {
    let f = fixture(McpOptions { prompt_timeout: Duration::from_millis(300), ..fast() });
    f.relay.configure(&json!({ "enabled": true, "spaces": [NOTES] }), &[NOTES.to_owned()]).unwrap();
    let answer = ask(&socket(&f), "Zed", "search", json!({ "query": "x" }));
    assert_eq!(error_code(&answer), "NOT_ALLOWED");
    assert!(answer["error"]["message"].as_str().unwrap().contains("Zed"));
    // Still waiting for an answer in Thoth, which is remembered when given.
    assert_eq!(f.relay.settings()["pending"], json!(["Zed"]));
    f.relay.configure(&json!({ "enabled": false }), &[]).unwrap();
    assert_eq!(f.relay.settings()["pending"], json!([]));
}

#[test]
fn private_spaces_not_shared_are_invisible() {
    let f = fixture(fast());
    f.open.lock().unwrap().push(OpenSpace { root: WORK.into(), owner: "space-abc".into() });
    ready(&f, "Claude");
    let socket = socket(&f);
    f.requests.lock().unwrap().clear();
    assert_eq!(ask(&socket, "Claude", "search", json!({ "query": "x" }))["ok"], true);
    assert_eq!(ask(&socket, "Claude", "read_page", json!({ "path": "Plan.md" }))["ok"], true);
    for request in f.requests.lock().unwrap().iter() {
        assert_eq!(request["root"], NOTES, "only the shared Private Space is asked");
    }
    // Named, the unshared one is not there; the message names only what is shared.
    let answer = ask(&socket, "Claude", "read_page", json!({ "path": "Plan.md", "space": "Work" }));
    assert_eq!(error_code(&answer), "NO_SPACE");
    assert!(!answer["error"]["message"].as_str().unwrap().contains(WORK));

    // Shared but not open in any window: nothing to answer from.
    f.open.lock().unwrap().retain(|s| s.root != Path::new(NOTES));
    assert_eq!(error_code(&ask(&socket, "Claude", "search", json!({ "query": "x" }))), "NO_SPACE");

    // Two shared and open: the page list covers both; one page needs its Private Space named.
    f.open.lock().unwrap().push(OpenSpace { root: NOTES.into(), owner: "main".into() });
    f.relay.configure(&json!({ "spaces": [NOTES, WORK] }), &[NOTES.to_owned(), WORK.to_owned()]).unwrap();
    let list = ask(&socket, "Claude", "list_pages", json!({}));
    assert_eq!(list["result"]["structured"]["total"], 4);
    assert_eq!(error_code(&ask(&socket, "Claude", "read_page", json!({ "path": "Plan.md" }))), "BAD_ARGUMENT");
    let read = ask(&socket, "Claude", "read_page", json!({ "path": "Plan.md", "space": "Work" }));
    assert_eq!(read["result"]["structured"]["space"], "Work");
}

#[test]
fn tool_answers_and_their_errors() {
    let f = fixture(fast());
    ready(&f, "Claude");
    let socket = socket(&f);
    let read = ask(&socket, "Claude", "read_page", json!({ "id": "p1" }));
    assert_eq!(read["result"]["text"], PLAN);
    assert_eq!(
        read["result"]["structured"],
        json!({ "space": "Notes", "path": "Plan.md", "id": "p1", "title": "Plan", "attachments": ["chart.png"], "version": PLAN_HASH })
    );
    let back = ask(&socket, "Claude", "backlinks", json!({ "path": "Plan.md" }));
    assert_eq!(back["result"]["structured"]["backlinks"], json!([{ "path": "Log.md", "title": "Log", "id": "p2", "line": 3 }]));
    assert_eq!(error_code(&ask(&socket, "Claude", "read_page", json!({ "path": "Nope.md" }))), "NOT_FOUND");
    assert_eq!(error_code(&ask(&socket, "Claude", "read_page", json!({ "path": "../../etc/passwd" }))), "BAD_ARGUMENT");
    assert_eq!(error_code(&ask(&socket, "Claude", "write_page", json!({}))), "BAD_ARGUMENT");
    assert_eq!(error_code(&send(&socket, "not json")), "BAD_ARGUMENT");
    assert_eq!(error_code(&send(&socket, &json!({ "v": 2, "app": "Claude", "tool": "search" }).to_string())), "BAD_ARGUMENT");
}

#[test]
fn limits_sizes_and_timeouts() {
    let f = fixture(McpOptions { answer_timeout: Duration::from_millis(300), ..fast() });
    ready(&f, "Claude");
    let socket = socket(&f);
    f.requests.lock().unwrap().clear();
    ask(&socket, "Claude", "search", json!({ "query": "x", "limit": 100_000 }));
    assert_eq!(f.requests.lock().unwrap()[0]["args"]["limit"], 50);

    // A long search is refused by its own limit (the line may be longer now, for a proposed page of 1 MB, ADR-0048).
    let long = json!({ "v": 1, "app": "Claude", "tool": "search", "arguments": { "query": "x".repeat(70 * 1024) } }).to_string();
    assert_eq!(error_code(&send(&socket, &long)), "BAD_ARGUMENT");

    // An answer over 1 MB is not sent.
    *f.answer_with.lock().unwrap() =
        Some(json!({ "result": { "page": { "id": "p1", "path": "Plan.md", "title": "Plan", "markdown": "x".repeat(1024 * 1024 + 1), "attachments": [] } } }));
    assert_eq!(error_code(&ask(&socket, "Claude", "read_page", json!({ "path": "Plan.md" }))), "TOO_LARGE");
    *f.answer_with.lock().unwrap() = None;

    // A window that does not answer in time.
    *f.answering.lock().unwrap() = false;
    assert_eq!(error_code(&ask(&socket, "Claude", "search", json!({ "query": "x" }))), "TIMEOUT");
    // Its late answer goes nowhere.
    let late = f.requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!(f.relay.answer("main", late["id"].as_str().unwrap(), &json!({ "result": { "hits": [] } })).unwrap_err().code, "BAD_ARGUMENT");
}

#[test]
fn a_request_line_must_come_whole_in_time_and_within_its_limit() {
    let f = fixture(McpOptions { read_timeout: Duration::from_millis(300), ..fast() });
    ready(&f, "Claude");
    let socket = socket(&f);

    // A byte every 100 ms never waits 300 ms for one, but the whole line must come within 300 ms.
    let mut slow = UnixStream::connect(&socket).unwrap();
    let start = std::time::Instant::now();
    let mut cut = false;
    for _ in 0..30 {
        if slow.write_all(b"{").is_err() {
            cut = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(cut, "the host closes a line that does not come whole in time");
    assert!(start.elapsed() < Duration::from_secs(2), "{:?}", start.elapsed());

    // Over the limit (2 MiB + 64 KiB): refused without being read to its end.
    let long = format!("{{\"v\":1,\"app\":\"Claude\",\"tool\":\"search\",\"arguments\":{{\"query\":\"{}\"}}}}", "x".repeat(thoth_host::mcp::MAX_REQUEST));
    let mut stream = UnixStream::connect(&socket).unwrap();
    let _ = stream.write_all(long.as_bytes());
    let mut answer = String::new();
    BufReader::new(&stream).read_line(&mut answer).unwrap();
    assert!(answer.contains("too long"), "{answer}");

    // The host still answers.
    assert_eq!(ask(&socket, "Claude", "list_pages", json!({}))["ok"], true);
}

#[test]
fn only_the_window_asked_can_answer() {
    let f = fixture(fast());
    ready(&f, "Claude");
    *f.answering.lock().unwrap() = false;
    let asking = {
        let socket = socket(&f);
        std::thread::spawn(move || ask(&socket, "Claude", "search", json!({ "query": "x" })))
    };
    let request = loop {
        if let Some(r) = f.requests.lock().unwrap().iter().find(|r| r["tool"] == "search").cloned() {
            break r;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let id = request["id"].as_str().unwrap();
    assert_eq!(f.relay.answer("space-other", id, &json!({ "result": { "hits": [] } })).unwrap_err().code, "NOT_ALLOWED");
    f.relay.answer("main", id, &json!({ "result": { "hits": [] } })).unwrap();
    assert_eq!(asking.join().unwrap()["result"]["structured"], json!({ "results": [] }));
}

#[test]
fn every_request_is_logged_without_page_text_and_old_days_go() {
    let f = fixture(fast());
    std::fs::create_dir_all(f.dir.join("log")).unwrap();
    std::fs::write(f.dir.join("log").join("2000-01-01.jsonl"), "{\"time\":\"2000-01-01T00:00:00Z\",\"app\":\"Old\"}\n").unwrap();
    ready(&f, "Claude");
    let socket = socket(&f);
    ask(&socket, "Claude", "search", json!({ "query": "Secret" }));
    ask(&socket, "Claude", "read_page", json!({ "path": "Plan.md" }));
    f.relay.decide("Claude", false).unwrap();
    ask(&socket, "Claude", "read_page", json!({ "path": "Plan.md" }));

    let log = f.relay.log();
    let entries = log.as_array().unwrap();
    // Newest first: the denied read, the read, the search, then the first page list (the one that was asked about).
    assert_eq!(entries.iter().map(|e| e["tool"].as_str().unwrap()).collect::<Vec<_>>(), ["read_page", "read_page", "search", "list_pages"]);
    assert_eq!(entries[0]["app"], "Claude");
    assert_eq!(entries[0]["ok"], false);
    assert_eq!(entries[0]["error"], "DENIED");
    assert_eq!(entries[1]["paths"], json!(["Plan.md"]));
    assert_eq!(entries[1]["spaces"], json!(["Notes"]));
    assert_eq!(entries[2]["paths"], json!(["Plan.md"]));
    assert!(entries[1]["time"].as_str().unwrap().ends_with('Z'));
    let files: Vec<String> = std::fs::read_dir(f.dir.join("log")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(files.len(), 1, "the day from 2000 is gone: {files:?}");
    let text = std::fs::read_to_string(f.dir.join("log").join(&files[0])).unwrap();
    assert!(!text.contains("Secret"), "no page text and no search words in the log");
    assert_eq!(std::fs::metadata(f.dir.join("log").join(&files[0])).unwrap().permissions().mode() & 0o777, 0o600);
}

/// `ready`, then lets `app` propose changes too: its first proposal asks, and the user says yes.
fn may_propose(f: &Fixture, app: &str) -> Value {
    ready(f, app);
    let asking = {
        let socket = socket(f);
        let app = app.to_owned();
        std::thread::spawn(move || ask(&socket, &app, "propose_append", json!({ "path": "Plan.md", "markdown": "- two" })))
    };
    pending_is(f, json!({ "apps": [], "proposers": [app] }));
    assert!(f.relay.proposals()["proposals"].as_array().unwrap().is_empty(), "nothing is kept before the user answers");
    f.relay.may_propose(app, true).unwrap();
    let answer = asking.join().unwrap();
    assert_eq!(answer["ok"], true, "{answer}");
    answer
}

#[test]
fn an_app_proposes_only_once_the_user_lets_it_and_the_call_writes_nothing() {
    let f = fixture(fast());
    let answer = may_propose(&f, "Claude");
    let made = &answer["result"]["structured"];
    assert_eq!((made["status"].clone(), made["space"].clone(), made["path"].clone()), (json!("pending"), json!("Notes"), json!("Plan.md")));
    let id = made["id"].as_str().unwrap();
    assert!(answer["result"]["text"].as_str().unwrap().contains("nothing is written"));
    assert_eq!(f.relay.settings()["apps"][0]["propose"], true);

    // The window was only asked to read the page, never sent the proposed text.
    let asked = f.requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!((asked["tool"].clone(), asked["args"].clone()), (json!("read_page"), json!({ "path": "Plan.md" })));
    // The host keeps it, outside the notes, for the windows to review.
    let list = f.relay.proposals();
    assert_eq!(list["open"], 1);
    assert_eq!(list["proposals"][0]["app"], "Claude");
    assert_eq!(list["proposals"][0]["root"], NOTES);
    assert_eq!(list["proposals"][0]["baseHash"], PLAN_HASH);
    let one = f.relay.proposal(id).unwrap();
    assert_eq!(one["before"], PLAN);
    assert_eq!(one["after"], format!("{PLAN}\n- two\n"));
    assert!(f.dir.join("proposals").join(format!("{id}.json")).exists());
    // The windows are told, to show it under the bell.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while f.proposals.lock().unwrap().last() != Some(&json!({ "open": 1 })) {
        assert!(std::time::Instant::now() < deadline, "the windows hear of the proposal");
        std::thread::sleep(Duration::from_millis(10));
    }

    // Turned off: refused, and nothing more is kept.
    f.relay.may_propose("Claude", false).unwrap();
    let refused = ask(&socket(&f), "Claude", "propose_create_page", json!({ "path": "New.md", "markdown": "# New" }));
    assert_eq!(error_code(&refused), "DENIED");
    assert_eq!(f.relay.proposals()["open"], 1);
    // An app that may not read may not propose either, whatever its switch says.
    f.relay.may_propose("Claude", true).unwrap();
    f.relay.decide("Claude", false).unwrap();
    assert_eq!(error_code(&ask(&socket(&f), "Claude", "propose_create_page", json!({ "path": "New.md", "markdown": "# New" }))), "DENIED");
    // Only an app that connected has the switch.
    assert_eq!(f.relay.may_propose("Never Asked", true).unwrap_err().code, "BAD_ARGUMENT");
}

#[test]
fn proposals_are_checked_confined_and_kept_to_their_limits() {
    let f = fixture(fast());
    may_propose(&f, "Claude");
    let socket = socket(&f);
    let propose = |tool: &str, args: Value| ask(&socket, "Claude", tool, args);

    // A new page by title, in a folder.
    let made = propose("propose_create_page", json!({ "folder": "Meetings/", "title": " Plan: 2026/11? ", "markdown": "# Plan" }));
    assert_eq!(made["result"]["structured"]["path"], "Meetings/Plan 2026 11.md", "{made}");
    // Never over a page that is there.
    assert_eq!(error_code(&propose("propose_create_page", json!({ "path": "Plan.md", "markdown": "x" }))), "EXISTS");
    // Only Markdown pages in the Private Space, never in `.thoth/` or a hidden folder.
    for path in [".thoth/index.md", "a/.hidden/b.md", "../Out.md", "/etc/x.md", "Plan.txt", "a\\b.md"] {
        assert_eq!(error_code(&propose("propose_create_page", json!({ "path": path, "markdown": "x" }))), "BAD_ARGUMENT", "{path}");
        assert_eq!(error_code(&propose("propose_edit_page", json!({ "path": path, "markdown": "x" }))), "BAD_ARGUMENT", "{path}");
    }
    assert_eq!(error_code(&propose("propose_create_page", json!({ "title": "..", "markdown": "x" }))), "BAD_ARGUMENT");
    // A page that is not there cannot be edited.
    assert_eq!(error_code(&propose("propose_edit_page", json!({ "path": "Nope.md", "markdown": "x" }))), "NOT_FOUND");

    // Exact-text replacements must each match once.
    let replace = |find: &str| propose("propose_edit_page", json!({ "id": "p1", "replacements": [{ "find": find, "replace": "two" }] }));
    assert!(error(&replace("not in the page")).contains("not in the page"));
    assert!(error(&replace("- one")).contains("more than once"));
    let ok = replace("- one more");
    let id = ok["result"]["structured"]["id"].as_str().unwrap().to_owned();
    assert!(f.relay.proposal(&id).unwrap()["after"].as_str().unwrap().ends_with("- one\ntwo\n"));
    assert_eq!(error_code(&propose("propose_edit_page", json!({ "path": "Plan.md", "markdown": "x", "replacements": [] }))), "BAD_ARGUMENT");
    assert_eq!(error_code(&propose("propose_edit_page", json!({ "path": "Plan.md", "markdown": PLAN }))), "BAD_ARGUMENT", "no change");

    // `expected` is the version the app read: another one is refused.
    assert_eq!(error_code(&propose("propose_edit_page", json!({ "path": "Plan.md", "markdown": "x", "expected": "older" }))), "CONFLICT");
    assert_eq!(propose("propose_edit_page", json!({ "path": "Plan.md", "markdown": "x", "expected": PLAN_HASH }))["ok"], true);

    // Under a heading: at the end of its section.
    let under = propose("propose_append", json!({ "path": "Plan.md", "heading": "## Next", "markdown": "- three" }));
    let id = under["result"]["structured"]["id"].as_str().unwrap().to_owned();
    assert_eq!(f.relay.proposal(&id).unwrap()["after"], format!("{PLAN}\n- three\n"));
    assert!(error(&propose("propose_append", json!({ "path": "Plan.md", "heading": "Later", "markdown": "x" }))).contains("No heading"));

    // At most 1 MB.
    assert_eq!(error_code(&propose("propose_create_page", json!({ "path": "Big.md", "markdown": "x".repeat(1024 * 1024 + 1) }))), "TOO_LARGE");
    // Only the shared Private Spaces.
    assert_eq!(error_code(&propose("propose_create_page", json!({ "path": "N.md", "markdown": "x", "space": "Work" }))), "NO_SPACE");
}

#[test]
fn the_app_sees_what_became_of_its_own_proposals_and_only_a_window_on_the_space_settles_them() {
    let f = fixture(fast());
    let made = may_propose(&f, "Claude");
    let id = made["result"]["structured"]["id"].as_str().unwrap().to_owned();
    let socket = socket(&f);

    assert_eq!(f.relay.settle("space-other", &id, "applied").unwrap_err().code, "NOT_ALLOWED");
    assert_eq!(f.relay.settle("main", &id, "pending").unwrap_err().code, "BAD_ARGUMENT");
    assert_eq!(f.relay.settle("main", &id, "conflicted").unwrap()["status"], "conflicted");
    assert_eq!(f.relay.proposal(&id).unwrap()["after"], format!("{PLAN}\n- two\n"), "a conflicted one keeps its text for the review");
    assert_eq!(f.relay.settle("main", &id, "applied").unwrap()["status"], "applied");
    assert_eq!(f.relay.proposal(&id).unwrap()["after"], Value::Null, "an applied one keeps no text");
    assert_eq!(f.relay.settle("main", &id, "declined").unwrap_err().code, "CONFLICT");
    assert_eq!(f.relay.proposals()["open"], 0);

    let got = ask(&socket, "Claude", "get_proposal", json!({ "id": id }));
    assert_eq!(got["result"]["structured"]["status"], "applied", "{got}");
    assert!(got["result"]["structured"].get("root").is_none(), "the folder on this computer is not told");
    let list = ask(&socket, "Claude", "list_proposals", json!({ "status": "applied" }));
    assert_eq!(list["result"]["structured"]["total"], 1);
    assert_eq!(list["result"]["structured"]["proposals"][0]["path"], "Plan.md");
    assert_eq!(ask(&socket, "Claude", "list_proposals", json!({ "status": "pending" }))["result"]["structured"]["total"], 0);
    assert_eq!(error_code(&ask(&socket, "Claude", "list_proposals", json!({ "status": "lost" }))), "BAD_ARGUMENT");

    // Another app sees none of them.
    ready_too(&f, "Cursor");
    assert_eq!(error_code(&ask(&socket, "Cursor", "get_proposal", json!({ "id": id }))), "NOT_FOUND");
    assert_eq!(ask(&socket, "Cursor", "list_proposals", json!({}))["result"]["structured"]["total"], 0);
}

/// Allows a second app (the first already switched Connected apps on).
fn ready_too(f: &Fixture, app: &str) {
    let asking = {
        let socket = socket(f);
        let app = app.to_owned();
        std::thread::spawn(move || ask(&socket, &app, "list_pages", json!({})))
    };
    pending_is(f, json!({ "apps": [app] }));
    f.relay.decide(app, true).unwrap();
    assert_eq!(asking.join().unwrap()["ok"], true);
}

#[test]
fn proposals_are_logged_by_tool_app_path_and_outcome_never_their_text() {
    let f = fixture(fast());
    may_propose(&f, "Claude");
    let socket = socket(&f);
    ask(&socket, "Claude", "propose_create_page", json!({ "path": "Diary.md", "markdown": "Secret proposal text" }));
    ask(&socket, "Claude", "propose_edit_page", json!({ "path": "Plan.md", "replacements": [{ "find": "Secret words", "replace": "Hidden replacement" }] }));
    ask(&socket, "Claude", "propose_edit_page", json!({ "path": "Plan.md", "replacements": [{ "find": "Absent finding", "replace": "x" }] }));
    let entries = f.relay.log();
    let entries = entries.as_array().unwrap();
    assert_eq!(entries[0]["tool"], "propose_edit_page");
    assert_eq!((entries[0]["ok"].clone(), entries[0]["error"].clone(), entries[0]["paths"].clone()), (json!(false), json!("BAD_ARGUMENT"), json!(["Plan.md"])));
    assert_eq!((entries[1]["ok"].clone(), entries[1]["paths"].clone()), (json!(true), json!(["Plan.md"])));
    assert_eq!(
        (entries[2]["tool"].clone(), entries[2]["paths"].clone(), entries[2]["spaces"].clone()),
        (json!("propose_create_page"), json!(["Diary.md"]), json!(["Notes"]))
    );
    let dir = f.dir.join("log");
    for file in std::fs::read_dir(&dir).unwrap() {
        let text = std::fs::read_to_string(file.unwrap().path()).unwrap();
        for words in ["Secret proposal text", "Hidden replacement", "Absent finding", "Secret words", "- two"] {
            assert!(!text.contains(words), "{words:?} in the log");
        }
    }
}

fn error(answer: &Value) -> String {
    assert_eq!(answer["ok"], false, "{answer}");
    answer["error"]["message"].as_str().unwrap().to_owned()
}

mod through_the_host {
    //! The same relay behind the host's `mcp.*` commands, as the desktop windows (and the e2e bridge) use it.
    use super::*;
    use thoth_host::{Browser, FileManager, Host, HostConfig, HostResult, MemorySecretStore, Picker};

    struct NoPicker;
    impl Picker for NoPicker {
        fn pick_vault(&self) -> Option<PathBuf> {
            None
        }
        fn pick_source(&self, _: bool) -> Option<PathBuf> {
            None
        }
    }

    struct Nothing;
    impl Browser for Nothing {
        fn open(&self, _: &str) -> HostResult<()> {
            Ok(())
        }
    }
    impl FileManager for Nothing {
        fn reveal(&self, _: &Path, _: Option<&Path>) -> HostResult<()> {
            Ok(())
        }
    }

    #[test]
    fn the_host_shares_only_folders_opened_in_it_and_only_their_window_answers() {
        let allow = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(allow.path()).unwrap().join("Notes");
        std::fs::create_dir(&root).unwrap();
        let data = tempfile::Builder::new().prefix("mcp").tempdir_in("/tmp").unwrap();
        let (tx, events) = channel::<(String, Value)>();
        let tx = Mutex::new(tx);
        let host = Host::new(HostConfig {
            data_dir: Some(data.path().to_owned()),
            allow_roots: vec![allow.path().to_owned()],
            picker: Arc::new(NoPicker),
            events: Arc::new(move |event, payload| {
                let _ = tx.lock().unwrap().send((event.to_owned(), payload));
            }),
            disable_hardlink: false,
            secrets: Arc::new(MemorySecretStore::default()),
            browser: Arc::new(Nothing),
            file_manager: Arc::new(Nothing),
            agent_search_dirs: Some(Vec::new()),
            link_preview_loopback: false,
        });
        let shown = root.to_string_lossy().into_owned();
        let vault = host.call_as("main", "vault.open", &json!({ "root": shown }), None).unwrap().0["vault"].as_str().unwrap().to_owned();
        assert_eq!(host.call("mcp.configure", &json!({ "spaces": ["/etc"] }), None).unwrap_err().code, "NOT_ALLOWED");
        let settings = host.call("mcp.configure", &json!({ "enabled": true, "spaces": [shown] }), None).unwrap().0;
        assert_eq!(settings["listening"], true);

        let socket = data.path().join("mcp").join("thoth.sock");
        let asking = {
            let socket = socket.clone();
            std::thread::spawn(move || ask(&socket, "Claude", "search", json!({ "query": "x" })))
        };
        let mut answered = false;
        while !answered {
            let (event, payload) = events.recv_timeout(Duration::from_secs(5)).unwrap();
            match event.as_str() {
                "mcp.pending" if payload["apps"] == json!(["Claude"]) => {
                    host.call("mcp.decide", &json!({ "app": "Claude", "allow": true }), None).unwrap();
                }
                "mcp.request" => {
                    let id = payload["id"].as_str().unwrap();
                    let reply = json!({ "id": id, "result": { "hits": [] } });
                    assert_eq!(host.call_as("space-other", "mcp.answer", &reply, None).unwrap_err().code, "NOT_ALLOWED");
                    host.call_as("main", "mcp.answer", &reply, None).unwrap();
                    answered = true;
                }
                _ => {}
            }
        }
        assert_eq!(asking.join().unwrap()["ok"], true);
        assert_eq!(host.call("mcp.log", &json!({}), None).unwrap().0[0]["tool"], "search");

        // The window closed its Private Space: nothing is open to answer from.
        host.call("vault.close", &json!({ "vault": vault }), None).unwrap();
        assert_eq!(error_code(&ask(&socket, "Claude", "search", json!({ "query": "x" }))), "NO_SPACE");
        // Quitting stops listening and keeps the settings.
        host.shutdown();
        assert!(!socket.exists());
        assert_eq!(host.call("mcp.settings", &json!({}), None).unwrap().0["enabled"], true);
    }
}

/// Waits until the windows heard `n` memory events.
fn memories_heard(f: &Fixture, n: usize) -> Vec<Value> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let heard = f.memories.lock().unwrap().clone();
        if heard.len() >= n {
            return heard;
        }
        assert!(std::time::Instant::now() < deadline, "the windows hear of the memory");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn tools_asked(f: &Fixture) -> Vec<String> {
    f.requests.lock().unwrap().iter().map(|r| r["tool"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn an_allowed_app_saves_a_memory_without_review_and_the_host_keeps_its_history() {
    let f = fixture(fast());
    ready(&f, "Claude");
    assert_eq!(f.relay.settings()["memories"], true, "on by default (ADR-0052 rule 5)");
    assert_eq!(f.relay.settings()["apps"][0]["remember"], true);
    f.requests.lock().unwrap().clear();

    let saved =
        ask(&socket(&f), "Claude", "remember", json!({ "text": "Put blockers first.", "kind": "preference", "topic": "updates/format", "tags": ["writing"] }));
    assert_eq!(saved["ok"], true, "{saved}");
    let made = &saved["result"]["structured"];
    assert_eq!((made["status"].clone(), made["path"].clone(), made["version"].clone()), (json!("saved"), json!("Memory/blockers-first.md"), json!("h2")));

    // The first time, the host looks at the Memory folder (empty here) and records it.
    let requests = f.requests.lock().unwrap().clone();
    assert_eq!(tools_asked(&f), ["memory_folder", "memory_change", "memory_commit"]);
    assert_eq!(requests[0]["args"], json!({ "folder": "Memory" }));
    assert_eq!(f.relay.settings()["memoryFolders"], json!({ NOTES: "Memory" }));
    // Worked out, then written over the version it was worked out from, with the app as its source.
    assert_eq!(
        requests[1]["args"],
        json!({ "op": "remember", "text": "Put blockers first.", "kind": "preference", "topic": "updates/format", "tags": ["writing"], "certainty": "inferred", "app": "Claude", "folder": "Memory" })
    );
    assert_eq!(requests[2]["args"]["op"], "write");
    assert_eq!(requests[2]["args"]["expected"], Value::Null);
    assert_eq!(requests[2]["args"]["path"], "Memory/blockers-first.md");
    assert_eq!(requests[2]["args"]["folder"], "Memory");

    // Kept for Undo, outside the notes, owner-only; the windows hear of it for the bell.
    let history = f.relay.memory_history("main", None).unwrap();
    let change = &history["changes"][0];
    assert_eq!((change["app"].clone(), change["action"].clone(), change["afterHash"].clone()), (json!("Claude"), json!("created"), json!("h2")));
    let one = f.relay.memory_history("main", change["id"].as_str()).unwrap();
    assert_eq!(one["before"], Value::Null);
    assert!(one["after"].as_str().unwrap().contains("Put blockers first."));
    // Only for a window with that Private Space open.
    assert!(f.relay.memory_history("space-other", None).unwrap()["changes"].as_array().unwrap().is_empty());
    assert_eq!(f.relay.memory_history("space-other", change["id"].as_str()).unwrap_err().code, "NOT_ALLOWED");
    let file = f.dir.join("memory").join(format!("{}.json", change["id"].as_str().unwrap()));
    assert_eq!(std::fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(
        memories_heard(&f, 1)[0],
        json!({ "app": "Claude", "action": "created", "root": NOTES, "space": "Notes", "path": "Memory/blockers-first.md", "title": "Blockers first" })
    );
    assert_eq!(f.relay.proposals()["open"], 0, "no proposal, and no “May propose changes” question");

    // An update and a forget say what they did; forget moves the file to the Trash.
    let updated =
        ask(&socket(&f), "Claude", "update_memory", json!({ "path": "Memory/blockers-first.md", "text": "Blockers, then risks.", "certainty": "stated" }));
    assert_eq!(updated["result"]["structured"]["status"], "saved", "{updated}");
    let forgot = ask(&socket(&f), "Claude", "forget", json!({ "id": "m1", "reason": "the user asked" }));
    assert_eq!(forgot["result"]["structured"]["status"], "forgotten", "{forgot}");
    let commits: Vec<Value> = f.requests.lock().unwrap().iter().filter(|r| r["tool"] == "memory_commit").map(|r| r["args"].clone()).collect();
    assert_eq!(commits[2], json!({ "op": "trash", "path": "Memory/blockers-first.md", "expected": "h1", "folder": "Memory" }));
    assert_eq!(f.relay.memory_history("main", None).unwrap()["changes"][0]["action"], "forgot", "newest first");

    // Nothing to change: nothing written.
    f.requests.lock().unwrap().clear();
    let same = ask(&socket(&f), "Claude", "update_memory", json!({ "path": "Memory/blockers-first.md", "text": "same" }));
    assert_eq!(same["result"]["structured"]["status"], "unchanged", "{same}");
    assert_eq!(tools_asked(&f), ["memory_change"]);
}

#[test]
fn with_saving_without_asking_off_a_memory_waits_for_review() {
    let f = fixture(fast());
    ready(&f, "Claude");
    f.relay.may_remember("Claude", false).unwrap();
    assert_eq!(f.relay.settings()["apps"][0]["remember"], false);
    let pending = ask(&socket(&f), "Claude", "remember", json!({ "text": "Put blockers first.", "kind": "preference" }));
    assert_eq!(pending["result"]["structured"]["status"], "pending", "{pending}");
    let list = f.relay.proposals();
    assert_eq!(
        (list["open"].clone(), list["proposals"][0]["kind"].clone(), list["proposals"][0]["path"].clone()),
        (json!(1), json!("create"), json!("Memory/blockers-first.md"))
    );
    assert!(!tools_asked(&f).contains(&"memory_commit".to_owned()), "nothing written");
    // A forget cannot be a proposal: the user deletes it in Thoth.
    assert_eq!(error_code(&ask(&socket(&f), "Claude", "forget", json!({ "path": "Memory/blockers-first.md" }))), "DENIED");

    // The global switch, kept across a restart.
    f.relay.may_remember("Claude", true).unwrap();
    f.relay.configure(&json!({ "memories": false }), &[]).unwrap();
    let again = Relay::new(Some(f.dir.clone()), Arc::new(|_: &str, _: Value| {}), Arc::new(Vec::new), fast());
    assert_eq!(again.settings()["memories"], false);
    drop(again);
    let edit = ask(&socket(&f), "Claude", "update_memory", json!({ "id": "m1", "text": "Blockers, then risks." }));
    assert_eq!(edit["result"]["structured"]["status"], "pending", "{edit}");
    assert_eq!(f.relay.proposals()["proposals"][1]["baseHash"], "h1");
    assert!(f.relay.memory_history("main", None).unwrap()["changes"].as_array().unwrap().is_empty());
}

#[test]
fn memory_writes_are_checked_before_anything_is_written() {
    let f = fixture(fast());
    ready(&f, "Claude");
    f.requests.lock().unwrap().clear();
    let call = |tool: &str, args: Value| ask(&socket(&f), "Claude", tool, args);

    // Likely secrets never reach the window.
    // Fake tokens, joined at run time so secret scanners do not take this file for a leak.
    let fake = |parts: &[&str]| parts.concat();
    for text in [fake(&["key sk-", "proj-AbC123dEf456GhI789jKl012"]), "-----BEGIN OPENSSH PRIVATE KEY-----".to_owned()] {
        assert_eq!(error_code(&call("remember", json!({ "text": text, "kind": "reference" }))), "LOOKS_LIKE_SECRET");
    }
    assert_eq!(
        error_code(&call("remember", json!({ "text": "x", "kind": "reference", "tags": [fake(&["gh", "p_1234567890abcdefghijABCDEFGHIJ123456"])] }))),
        "LOOKS_LIKE_SECRET"
    );
    assert_eq!(
        error_code(&call(
            "update_memory",
            json!({ "path": "Memory/a.md", "replacements": [{ "find": "x", "replace": fake(&["AKIA", "IOSFODNN7EXAMPLE1"]) }] })
        )),
        "LOOKS_LIKE_SECRET"
    );
    // Kinds, sizes and arguments.
    assert_eq!(error_code(&call("remember", json!({ "text": "x", "kind": "feedback" }))), "BAD_ARGUMENT");
    assert_eq!(error_code(&call("remember", json!({ "text": "x" }))), "BAD_ARGUMENT");
    assert_eq!(error_code(&call("remember", json!({ "text": "x".repeat(4097), "kind": "note" }))), "TOO_LARGE");
    assert_eq!(error_code(&call("remember", json!({ "text": "x", "kind": "note", "certainty": "sure" }))), "BAD_ARGUMENT");
    assert_eq!(error_code(&call("update_memory", json!({ "path": "Memory/a.md" }))), "BAD_ARGUMENT");
    // Only memories in the memory folder, never its README or a page elsewhere.
    for path in ["Plan.md", "Notes/Memory/a.md", "Memory/README.md", "Memory/.hidden/a.md", "Memory/a.txt", "Memory/../Plan.md", "Memory", "Memoryx/a.md"] {
        assert_eq!(error_code(&call("update_memory", json!({ "path": path, "text": "x" }))), "BAD_ARGUMENT", "{path}");
        assert_eq!(error_code(&call("forget", json!({ "path": path }))), "BAD_ARGUMENT", "{path}");
    }
    assert_eq!(tools_asked(&f), ["memory_folder"], "only the folder was looked at, once");
    f.requests.lock().unwrap().clear();

    // A window's change outside the folder is never written; its refusals reach the app.
    assert_eq!(error_code(&call("remember", json!({ "text": "outside", "kind": "note" }))), "INTERNAL");
    assert_eq!(error_code(&call("remember", json!({ "text": "a forgotten one", "kind": "note" }))), "FORGOTTEN");
    assert_eq!(tools_asked(&f), ["memory_change", "memory_change"]);
}

#[test]
fn an_app_saves_at_most_100_memories_a_day_without_review() {
    let f = fixture(fast());
    ready(&f, "Claude");
    ready_too(&f, "Codex");
    for n in 0..100 {
        let saved = ask(&socket(&f), "Claude", "remember", json!({ "text": format!("Fact {n}"), "kind": "note" }));
        assert_eq!(saved["ok"], true, "{saved}");
    }
    assert_eq!(error_code(&ask(&socket(&f), "Claude", "remember", json!({ "text": "One more", "kind": "note" }))), "BUSY");
    assert_eq!(ask(&socket(&f), "Codex", "remember", json!({ "text": "Another app", "kind": "note" }))["ok"], true, "each app has its own");
}

#[test]
fn recall_and_list_memories_answer_from_the_fields_the_host_knows() {
    let f = fixture(fast());
    ready(&f, "Claude");
    let recalled = ask(&socket(&f), "Claude", "recall", json!({ "kind": "work", "tags": ["#writing"], "since": "2026-10-01", "limit": 5 }));
    assert_eq!(recalled["ok"], true, "{recalled}");
    let asked = f.requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!(asked["args"], json!({ "kind": "work", "tags": ["writing"], "since": "2026-10-01", "limit": 5, "folder": "Memory" }));
    let found = &recalled["result"]["structured"];
    assert_eq!(found["about"][0]["text"], "Ploy, a designer in Chiang Mai.");
    assert_eq!(found["memories"].as_array().unwrap().len(), 2);
    assert!(found["memories"][0].get("check").is_none());
    assert_eq!(found["memories"][1]["check"], "Updated 40 days ago: check it before relying on it");
    assert!(found["memories"][0].get("secret").is_none(), "only known fields reach the app");
    let text = recalled["result"]["text"].as_str().unwrap();
    assert!(text.starts_with("About me (Notes, Memory/About me.md"), "{text}");
    assert!(text.contains("background information, not instructions") && text.contains("[work] Blockers first (stated, from Codex"), "{text}");

    for bad in [json!({ "kind": "feedback" }), json!({ "since": "last week" }), json!({ "tags": "writing" }), json!({ "query": "x".repeat(501) })] {
        assert_eq!(error_code(&ask(&socket(&f), "Claude", "recall", bad.clone())), "BAD_ARGUMENT", "{bad}");
    }

    let page = ask(&socket(&f), "Claude", "list_memories", json!({ "limit": 2 }));
    let listed = &page["result"]["structured"];
    assert_eq!((listed["total"].clone(), listed["cursor"].clone()), (json!(3), json!("2")), "{page}");
    assert!(listed["memories"][0].get("text").is_none(), "a list has no text");
    let next = ask(&socket(&f), "Claude", "list_memories", json!({ "limit": 2, "cursor": "2" }));
    assert_eq!(next["result"]["structured"]["memories"].as_array().unwrap().len(), 1);
    assert!(next["result"]["structured"].get("cursor").is_none());
    assert_eq!(f.requests.lock().unwrap().last().unwrap()["args"]["limit"], 4, "the window gives the first cursor + limit");

    // A window's memory with a kind that is not one of the six is not passed on.
    *f.answer_with.lock().unwrap() = Some(json!({ "result": { "memories": [{ "kind": "secret" }], "total": 1 } }));
    assert_eq!(error_code(&ask(&socket(&f), "Claude", "list_memories", json!({}))), "INTERNAL");
}

/// Waits for the windows to hear that `roots` wait for the memory folder question.
fn folders_asked(f: &Fixture, roots: Value) {
    loop {
        let heard = f.pending.recv_timeout(Duration::from_secs(5)).expect("the windows hear the question");
        if heard["folders"] == roots {
            return;
        }
    }
}

#[test]
fn a_memory_folder_of_the_users_own_is_used_only_once_they_say_which_folder_agents_may_use() {
    let f = fixture(fast());
    ready(&f, "Claude");
    // Memory/ holds pages Thoth did not set up.
    *f.answer_with.lock().unwrap() = Some(json!({ "result": { "pages": 3, "thoth": false } }));
    let asking = {
        let socket = socket(&f);
        std::thread::spawn(move || ask(&socket, "Claude", "remember", json!({ "text": "Put blockers first.", "kind": "preference" })))
    };
    folders_asked(&f, json!([NOTES]));
    *f.answer_with.lock().unwrap() = None;
    assert_eq!(f.relay.settings()["folders"], json!([NOTES]));
    assert_eq!(f.relay.settings()["memoryFolders"], json!({}), "nothing recorded before the answer");

    // Only a window with that Private Space open answers, with a folder agents may use.
    assert_eq!(f.relay.memory_folder("space-other", NOTES, "Agents/Memory").unwrap_err().code, "NOT_ALLOWED");
    for bad in ["", "/", ".thoth", "Agents/.x", "../Out", "a//b"] {
        assert_eq!(f.relay.memory_folder("main", NOTES, bad).unwrap_err().code, "BAD_ARGUMENT", "{bad}");
    }
    f.relay.memory_folder("main", NOTES, "/Agents/Memory/").unwrap();
    folders_asked(&f, json!([]));
    let saved = asking.join().unwrap();
    assert_eq!(saved["result"]["structured"]["path"], "Agents/Memory/blockers-first.md", "{saved}");
    let commit = f.requests.lock().unwrap().iter().rev().find(|r| r["tool"] == "memory_commit").cloned().unwrap();
    assert_eq!(commit["args"]["folder"], "Agents/Memory");

    // Recorded, also after a restart: not asked again, and Memory/ is not a memory folder.
    let again = Relay::new(Some(f.dir.clone()), Arc::new(|_: &str, _: Value| {}), Arc::new(Vec::new), fast());
    assert_eq!(again.settings()["memoryFolders"], json!({ NOTES: "Agents/Memory" }));
    drop(again);
    f.requests.lock().unwrap().clear();
    assert_eq!(error_code(&ask(&socket(&f), "Claude", "forget", json!({ "path": "Memory/Grandma.md" }))), "BAD_ARGUMENT");
    assert!(f.requests.lock().unwrap().is_empty());
    let recalled = ask(&socket(&f), "Claude", "recall", json!({}));
    assert_eq!(f.requests.lock().unwrap().last().unwrap()["args"]["folder"], "Agents/Memory", "{recalled}");
}

#[test]
fn an_unanswered_memory_folder_question_times_out_and_a_folder_thoth_set_up_is_not_asked_about() {
    let f = fixture(McpOptions { prompt_timeout: Duration::from_millis(300), ..fast() });
    ready(&f, "Claude");
    *f.answer_with.lock().unwrap() = Some(json!({ "result": { "pages": 3, "thoth": false } }));
    let waited = ask(&socket(&f), "Claude", "recall", json!({}));
    assert_eq!(error_code(&waited), "NOT_ALLOWED");
    assert!(waited["error"]["message"].as_str().unwrap().contains("answer in Thoth"), "{waited}");
    assert_eq!(f.relay.settings()["memoryFolders"], json!({}));

    // Thoth's own README is there: the folder is Thoth's, recorded without a question.
    *f.answer_with.lock().unwrap() = Some(json!({ "result": { "pages": 3, "thoth": true } }));
    f.relay.configure(&json!({ "enabled": false }), &[]).unwrap();
    f.relay.configure(&json!({ "enabled": true }), &[]).unwrap();
    let _ = ask(&socket(&f), "Claude", "recall", json!({}));
    assert_eq!(f.relay.settings()["memoryFolders"], json!({ NOTES: "Memory" }));
    assert_eq!(f.relay.settings()["folders"], json!([]));
}

#[test]
fn skills_are_listed_and_read_and_never_a_memory_folder() {
    let f = fixture(fast());
    ready(&f, "Claude");
    let socket = socket(&f);
    let listed = ask(&socket, "Claude", "list_skills", json!({}));
    assert_eq!(listed["ok"], true, "{listed}");
    assert_eq!(
        listed["result"]["structured"]["skills"],
        json!([{ "space": "Notes", "name": "weekly-update", "description": "Writes the weekly update. Use it on Fridays.", "path": "Skills/weekly-update/SKILL.md" }])
    );
    assert!(listed["result"]["text"].as_str().unwrap().contains("- weekly-update: Writes the weekly update."));

    let read = ask(&socket, "Claude", "get_skill", json!({ "name": "weekly-update" }));
    assert_eq!(read["result"]["text"], "---\nname: weekly-update\n---\nBlockers first.\n", "{read}");
    assert_eq!(read["result"]["structured"]["files"], json!(["references/style.md"]));
    let asked = f.requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!((asked["tool"].clone(), asked["args"].clone()), (json!("get_skill"), json!({ "name": "weekly-update" })));
    assert_eq!(error_code(&ask(&socket, "Claude", "get_skill", json!({ "name": "nope" }))), "NOT_FOUND");
    for (name, file) in [("../x", None), (".hidden", None), ("a/b", None), ("", None), ("ok", Some("../SKILL.md")), ("ok", Some(".env"))] {
        let mut args = json!({ "name": name });
        if let Some(file) = file {
            args["file"] = json!(file);
        }
        assert_eq!(error_code(&ask(&socket, "Claude", "get_skill", args)), "BAD_ARGUMENT", "{name} {file:?}");
    }

    // Skills are always reviewed: the memory folder can never be in Skills/.
    for folder in ["Skills", "skills/Memory"] {
        assert_eq!(f.relay.memory_folder("main", NOTES, folder).unwrap_err().code, "BAD_ARGUMENT", "{folder}");
    }
}

#[test]
fn an_addition_to_todays_note_is_a_proposal_and_starts_the_note_when_there_is_none() {
    let f = fixture(fast());
    may_propose(&f, "Claude");
    let socket = socket(&f);
    // None yet: a new page, as the window would start it, with the addition.
    let made = ask(&socket, "Claude", "propose_append", json!({ "today": true, "markdown": "- Shipped the memory view" }));
    assert_eq!(made["result"]["structured"]["path"], "Daily/2026-11-07.md", "{made}");
    let asked = f.requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!((asked["tool"].clone(), asked["args"].clone()), (json!("read_page"), json!({ "today": true })));
    let id = made["result"]["structured"]["id"].as_str().unwrap();
    let kept = f.relay.proposal(id).unwrap();
    assert_eq!((kept["kind"].clone(), kept["before"].clone(), kept["baseHash"].clone()), (json!("create"), Value::Null, Value::Null));
    assert_eq!(kept["after"], "# 2026-11-07\n\n- Shipped the memory view\n");

    // There: an addition to it, like any page.
    *f.answer_with.lock().unwrap() = Some(
        json!({ "result": { "page": { "id": "d1", "path": "Daily/2026-11-07.md", "title": "2026-11-07", "markdown": "# 2026-11-07\n", "attachments": [], "hash": "d0" } } }),
    );
    let again = ask(&socket, "Claude", "propose_append", json!({ "today": true, "markdown": "- More" }));
    let kept = f.relay.proposal(again["result"]["structured"]["id"].as_str().unwrap()).unwrap();
    assert_eq!((kept["kind"].clone(), kept["baseHash"].clone()), (json!("append"), json!("d0")));
    *f.answer_with.lock().unwrap() = None;

    // A path the window gave that is not a page is refused; today with a path is a mistake.
    *f.answer_with.lock().unwrap() = Some(json!({ "result": { "page": null, "today": { "path": "../x.md", "markdown": "" } } }));
    assert_eq!(error_code(&ask(&socket, "Claude", "propose_append", json!({ "today": true, "markdown": "x" }))), "INTERNAL");
    *f.answer_with.lock().unwrap() = None;
    assert_eq!(error_code(&ask(&socket, "Claude", "propose_append", json!({ "today": true, "path": "Plan.md", "markdown": "x" }))), "BAD_ARGUMENT");
}

#[test]
fn skills_are_linked_into_the_home_folder_and_nothing_there_is_ever_replaced() {
    let f = fixture(fast());
    let made = tempfile::Builder::new().prefix("skills").tempdir_in("/tmp").unwrap();
    let base = std::fs::canonicalize(made.path()).unwrap();
    let (root, home) = (base.join("Notes"), base.join("home"));
    let skill = |name: &str| {
        std::fs::create_dir_all(root.join("Skills").join(name)).unwrap();
        std::fs::write(root.join("Skills").join(name).join("SKILL.md"), format!("---\nname: {name}\n---\n")).unwrap();
    };
    skill("weekly-update");
    skill("taken");
    skill(".hidden");
    std::fs::create_dir_all(root.join("Skills/no-skill-file")).unwrap();
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    // The user's own folder with a skill's name: never replaced.
    std::fs::create_dir_all(home.join(".agents/skills/taken")).unwrap();
    f.open.lock().unwrap().push(OpenSpace { root: root.clone(), owner: "space-a".into() });
    let at = root.to_string_lossy().into_owned();

    let report = f.relay.skill_links("space-a", &at, Some(true), Some(&home)).unwrap();
    assert_eq!((report["on"].clone(), report["linked"].clone(), report["skipped"].clone()), (json!(true), json!(["taken", "weekly-update"]), json!(["taken"])));
    for dir in [".agents/skills", ".claude/skills"] {
        assert_eq!(std::fs::read_link(home.join(dir).join("weekly-update")).unwrap(), root.join("Skills/weekly-update"), "{dir}");
        assert!(!home.join(dir).join("no-skill-file").exists() && !home.join(dir).join(".hidden").exists());
    }
    assert!(std::fs::symlink_metadata(home.join(".agents/skills/taken")).unwrap().is_dir(), "the user's folder stays");
    assert_eq!(std::fs::read_link(home.join(".claude/skills/taken")).unwrap(), root.join("Skills/taken"));
    assert_eq!(f.relay.settings()["skillLinks"], json!([at]));

    // Brought up to date: a new skill is linked, a skill that went is unlinked.
    skill("review");
    std::fs::remove_dir_all(root.join("Skills/weekly-update")).unwrap();
    let report = f.relay.skill_links("space-a", &at, None, Some(&home)).unwrap();
    assert_eq!(report["linked"], json!(["review", "taken"]));
    assert!(std::fs::symlink_metadata(home.join(".claude/skills/weekly-update")).is_err());

    // Off: Thoth's links go, nothing else does. Only a window with the Private Space open may ask.
    f.relay.skill_links("space-a", &at, Some(false), Some(&home)).unwrap();
    for dir in [".agents/skills", ".claude/skills"] {
        let left: Vec<String> = std::fs::read_dir(home.join(dir)).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, if dir == ".agents/skills" { vec!["taken".to_owned()] } else { Vec::new() }, "{dir}");
    }
    assert_eq!(f.relay.skill_links("main", &at, Some(true), Some(&home)).unwrap_err().code, "NOT_ALLOWED");
}
