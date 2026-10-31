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

/// What a window answers for each tool, from a two-page Private Space.
fn window_answer(tool: &str, args: &Value) -> Value {
    match tool {
        "search" => json!({ "result": { "hits": [{ "id": "p1", "path": "Plan.md", "title": "Plan", "snippet": "the [แผน] for 2027" }] } }),
        "list_pages" => {
            json!({ "result": { "pages": [{ "id": "p1", "path": "Plan.md", "title": "Plan" }, { "id": "p2", "path": "Log.md", "title": "Log" }], "total": 2 } })
        }
        "read_page" if args["path"] == "Plan.md" || args["id"] == "p1" => {
            json!({ "result": { "page": { "id": "p1", "path": "Plan.md", "title": "Plan", "markdown": "# Plan\n\nSecret words here.\n", "attachments": ["chart.png"] } } })
        }
        "read_page" | "backlinks" if args["path"] != "Plan.md" => json!({ "error": { "code": "NOT_FOUND", "message": "No page Nope.md" } }),
        "backlinks" => {
            json!({ "result": { "page": { "id": "p1", "path": "Plan.md", "title": "Plan" }, "links": [{ "id": "p2", "path": "Log.md", "title": "Log", "line": 3 }], "total": 1 } })
        }
        _ => json!({ "error": { "code": "INTERNAL", "message": "?" } }),
    }
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
    {
        let (relay, requests, answering, answer_with) = (Arc::downgrade(&relay), requests.clone(), answering.clone(), answer_with.clone());
        std::thread::spawn(move || {
            for (event, payload) in events_rx {
                match event.as_str() {
                    "mcp.pending" => {
                        let _ = pending_tx.send(payload);
                    }
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
    Fixture { relay, dir, _data: data, open, requests, pending, answering, answer_with }
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

/// Waits for the windows to hear that the apps waiting for an answer are `expected`.
fn pending_is(f: &Fixture, expected: Value) {
    loop {
        let heard = f.pending.recv_timeout(Duration::from_secs(5)).expect("the windows hear who is waiting");
        if heard == expected {
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
    assert_eq!(read["result"]["text"], "# Plan\n\nSecret words here.\n");
    assert_eq!(read["result"]["structured"], json!({ "space": "Notes", "path": "Plan.md", "id": "p1", "title": "Plan", "attachments": ["chart.png"] }));
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

    // A request line over 64 KiB is refused before it is read further.
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
