//! `server.*` and `api.call` through `Host::call`, against the fake server in `support`. Every result and
//! error is collected and checked for leaked secrets at the end of each test.
mod support;

use serde_json::{Value, json};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::{Callback, Config, Fake, follow};
use thoth_host::{Browser, Host, HostConfig, HostError, HostResult, MemorySecretStore, Picker, SecretStore};

struct NoPicker;
impl Picker for NoPicker {
    fn pick_vault(&self) -> Option<std::path::PathBuf> {
        None
    }
    fn pick_source(&self, _: bool) -> Option<std::path::PathBuf> {
        None
    }
}

/// Follows the sign-in URL like a browser would (or only records it), and keeps what it saw.
type Page = std::thread::JoinHandle<Option<(u16, String)>>;

#[derive(Default)]
struct TestBrowser {
    record_only: bool,
    opened: Mutex<Vec<String>>,
    pages: Mutex<Vec<Page>>,
}

impl Browser for TestBrowser {
    fn open(&self, url: &str) -> HostResult<()> {
        self.opened.lock().unwrap().push(url.to_owned());
        if !self.record_only {
            self.pages.lock().unwrap().push(follow(url));
        }
        Ok(())
    }
}

impl TestBrowser {
    fn last_page(&self) -> (u16, String) {
        self.pages.lock().unwrap().pop().unwrap().join().unwrap().unwrap()
    }
}

struct Harness {
    host: Arc<Host>,
    secrets: Arc<MemorySecretStore>,
    browser: Arc<TestBrowser>,
    dir: tempfile::TempDir,
    /// Every result and error message, for the leak check.
    seen: Mutex<Vec<String>>,
}

impl Harness {
    fn new() -> Self {
        Self::with(TestBrowser::default(), tempfile::tempdir().unwrap(), Arc::new(MemorySecretStore::default()))
    }

    fn with(browser: TestBrowser, dir: tempfile::TempDir, secrets: Arc<MemorySecretStore>) -> Self {
        let browser = Arc::new(browser);
        let host = Arc::new(Host::new(HostConfig {
            data_dir: Some(dir.path().to_owned()),
            allow_roots: Vec::new(),
            picker: Arc::new(NoPicker),
            events: Arc::new(|_, _| {}),
            disable_hardlink: false,
            secrets: secrets.clone(),
            browser: browser.clone(),
        }));
        Self { host, secrets, browser, dir, seen: Mutex::default() }
    }

    fn call(&self, command: &str, args: Value) -> Result<Value, HostError> {
        self.call_bytes(command, args, None)
    }

    fn call_bytes(&self, command: &str, args: Value, bytes: Option<&[u8]>) -> Result<Value, HostError> {
        let reply = self.host.call(command, &args, bytes);
        self.seen.lock().unwrap().push(match &reply {
            Ok((v, _)) => v.to_string(),
            Err(e) => format!("{}: {}", e.code, e.message),
        });
        reply.map(|(v, _)| v)
    }

    fn ok(&self, command: &str, args: Value) -> Value {
        self.call(command, args).unwrap_or_else(|e| panic!("{command}: {e}"))
    }

    fn api(&self, server: &str, method: &str, path: &str) -> Value {
        self.ok("api.call", json!({ "server": server, "method": method, "path": path }))
    }

    fn add(&self, fake: &Fake) -> String {
        self.ok("server.add", json!({ "url": format!("{}/some/path", fake.origin) }))["id"].as_str().unwrap().to_owned()
    }

    fn signed_in(&self, fake: &Fake) -> String {
        let id = self.add(fake);
        let info = self.ok("server.signIn", json!({ "server": id }));
        assert_eq!(info["auth"], "browser");
        id
    }

    /// No secret the fake issued or accepted appears in any result, error or the persisted list.
    fn assert_no_leaks(&self, fakes: &[&Fake]) {
        let list = std::fs::read_to_string(self.dir.path().join("servers.json")).unwrap_or_default();
        let seen = self.seen.lock().unwrap();
        for fake in fakes {
            for secret in &fake.lock().issued {
                assert!(!list.contains(secret.as_str()), "servers.json leaks a secret");
                for line in seen.iter() {
                    assert!(!line.contains(secret.as_str()), "a host reply leaks a secret: {line}");
                }
            }
        }
    }
}

#[test]
fn add_sign_in_call_refresh_and_sign_out() {
    let fake = Fake::start(Config::default());
    let h = Harness::new();

    let info = h.ok("server.add", json!({ "url": format!("{}/api/v1/?x=1", fake.origin) }));
    assert_eq!(info["url"], fake.origin.as_str());
    assert_eq!(info["label"], "Fake Thoth");
    assert_eq!(info["auth"], "signed-out");
    assert_eq!(info["providers"], json!([{ "id": "google", "name": "Google" }]));
    assert_eq!(info["limits"], json!({ "maxPageSize": 200 }));
    let id = info["id"].as_str().unwrap().to_owned();
    // Adding the same origin again returns the same entry.
    assert_eq!(h.ok("server.add", json!({ "url": fake.origin }))["id"], id.as_str());
    assert_eq!(h.ok("server.list", json!({})).as_array().unwrap().len(), 1);

    // Signed out: requests go without a credential.
    assert_eq!(h.api(&id, "GET", "/api/v1/me")["status"], 401);

    let info = h.ok("server.signIn", json!({ "server": id, "provider": "google" }));
    assert_eq!(info["auth"], "browser");
    assert_eq!(info["account"], json!({ "id": "usr_1", "displayName": "Ada", "email": "ada@example.org" }));
    let (status, page) = h.browser.last_page();
    assert_eq!(status, 200);
    assert!(page.contains("You can close this window"));
    let opened = h.browser.opened.lock().unwrap()[0].clone();
    let url = url::Url::parse(&opened).unwrap();
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(q["client_id"], "thoth-desktop");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["provider"], "google");
    assert_eq!(q["state"].len(), 43);
    assert_eq!(h.secrets.len(), 1);

    let me = h.api(&id, "GET", "/api/v1/me");
    assert_eq!(me["status"], 200);
    assert_eq!(serde_json::from_str::<Value>(me["body"].as_str().unwrap()).unwrap()["displayName"], "Ada");
    assert_eq!(me["headers"], json!({ "content-type": "application/json" }), "set-cookie and other headers stay in the host");

    // Body, allow-listed headers and an encoded query reach the server; only allow-listed headers come back.
    let echo = h
        .call_bytes(
            "api.call",
            json!({ "server": id, "method": "PUT", "path": "/api/v1/echo", "query": { "q": "a b&c" }, "headers": { "If-Match": "\"r1\"", "content-type": "text/markdown" } }),
            Some("# Hi\n".as_bytes()),
        )
        .unwrap();
    assert_eq!(echo["status"], 201);
    assert_eq!(echo["headers"], json!({ "content-type": "application/json", "etag": "\"r2\"", "location": "/api/v1/echo" }));
    let body: Value = serde_json::from_str(echo["body"].as_str().unwrap()).unwrap();
    assert_eq!(body, json!({ "method": "PUT", "query": { "q": "a b&c" }, "ifMatch": "\"r1\"", "contentType": "text/markdown", "body": "# Hi\n" }));

    // A server error is a result, not a host error.
    assert_eq!(h.api(&id, "GET", "/api/v1/missing")["status"], 404);

    // The server expires the access token: one 401, one refresh, a retry, and the caller sees 200.
    fake.expire_access_tokens();
    let before = h.secrets.get(&id).unwrap();
    assert_eq!(h.api(&id, "GET", "/api/v1/me")["status"], 200);
    assert_eq!(fake.lock().refreshes, 1);
    assert_ne!(h.secrets.get(&id).unwrap(), before, "the rotated refresh token replaced the old one");

    // Sign out revokes the session on the server and deletes the secret; the server stays listed.
    let info = h.ok("server.signOut", json!({ "server": id }));
    assert_eq!(info["auth"], "signed-out");
    assert!(info.get("account").is_none());
    assert!(h.secrets.is_empty());
    assert!(fake.lock().session_revoked);
    assert_eq!(h.api(&id, "GET", "/api/v1/me")["status"], 401);
    assert_eq!(h.ok("server.list", json!({})).as_array().unwrap().len(), 1);

    h.ok("server.remove", json!({ "server": id }));
    assert_eq!(h.ok("server.list", json!({})), json!([]));
    assert_eq!(h.call("server.signIn", json!({ "server": id })).unwrap_err().code, "BAD_HANDLE");
    h.assert_no_leaks(&[&fake]);
}

#[test]
fn the_label_is_the_servers_name_cleaned_or_else_its_host_name() {
    let label = |server: Value| {
        let fake = Fake::start(Config { server, ..Config::default() });
        Harness::new().ok("server.add", json!({ "url": fake.origin }))["label"].as_str().unwrap().to_owned()
    };
    // No name, an empty or blank name, or a name of the wrong type: the host name (without the port).
    for server in [Value::Null, json!({}), json!({ "name": "" }), json!({ "name": " \u{7} \n " }), json!({ "name": 42 })] {
        assert_eq!(label(server.clone()), "127.0.0.1", "{server}");
    }
    // Control characters are dropped, the name is trimmed and kept to 64 characters (the server's own limit).
    assert_eq!(label(json!({ "name": "  Team\u{7} notes\n " })), "Team notes");
    assert_eq!(label(json!({ "name": "บันทึกของทีม" })), "บันทึกของทีม");
    assert_eq!(label(json!({ "name": "ก".repeat(80) })), "ก".repeat(64));
}

#[test]
fn concurrent_requests_share_one_refresh() {
    let fake = Fake::start(Config::default());
    let h = Arc::new(Harness::new());
    let id = h.signed_in(&fake);
    fake.expire_access_tokens();
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let (h, id) = (h.clone(), id.clone());
            std::thread::spawn(move || h.api(&id, "GET", "/api/v1/me")["status"].as_u64().unwrap())
        })
        .collect();
    let statuses: Vec<u64> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(statuses, vec![200; 8]);
    let s = fake.lock();
    assert_eq!((s.refreshes, s.reuse_detected, s.session_revoked), (1, 0, false));
    drop(s);
    h.assert_no_leaks(&[&fake]);
}

#[test]
fn access_tokens_near_expiry_are_refreshed_before_use() {
    let fake = Fake::start(Config { expires_in: 1, refresh_delay: Duration::ZERO, ..Config::default() });
    let h = Arc::new(Harness::new());
    let id = h.signed_in(&fake);
    std::thread::sleep(Duration::from_millis(700));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let (h, id) = (h.clone(), id.clone());
            std::thread::spawn(move || h.api(&id, "GET", "/api/v1/me")["status"].as_u64().unwrap())
        })
        .collect();
    assert!(workers.into_iter().all(|w| w.join().unwrap() == 200));
    let s = fake.lock();
    assert_eq!((s.refreshes, s.reuse_detected), (1, 0));
    // Proactive: no request was sent with the old token after it was due.
    assert_eq!(s.authorization.iter().filter(|(p, _)| p == "/api/v1/me").count(), 5, "one /me at sign-in, four calls, no 401 retries");
}

#[test]
fn a_refused_refresh_signs_out_and_deletes_the_secret() {
    let fake = Fake::start(Config::default());
    let h = Harness::new();
    let id = h.signed_in(&fake);
    fake.lock().session_revoked = true;
    fake.expire_access_tokens();
    let reply = h.api(&id, "GET", "/api/v1/me");
    assert_eq!(reply["status"], 401, "the 401 is returned");
    assert_eq!(h.ok("server.list", json!({}))[0]["auth"], "signed-out");
    assert!(h.secrets.is_empty());
    h.assert_no_leaks(&[&fake]);
}

#[test]
fn personal_access_tokens_work_without_a_provider() {
    let fake = Fake::start(Config { sign_in: false, ..Config::default() });
    let h = Harness::new();
    let id = h.add(&fake);
    assert_eq!(h.ok("server.list", json!({}))[0]["providers"], json!([]));
    let e = h.call("server.signIn", json!({ "server": id })).unwrap_err();
    assert_eq!(e.code, "SIGN_IN_FAILED");

    assert_eq!(h.call("server.useToken", json!({ "server": id, "token": "thoth_pat_not_a_real_token_000" })).unwrap_err().code, "SIGN_IN_FAILED");
    assert_eq!(h.call("server.useToken", json!({ "server": id, "token": "has space in it, not a token" })).unwrap_err().code, "BAD_ARGUMENT");
    let pat = fake.add_pat();
    let info = h.ok("server.useToken", json!({ "server": id, "token": pat }));
    assert_eq!(info["auth"], "token");
    assert_eq!(info["account"]["displayName"], "Ada");
    assert_eq!(h.api(&id, "GET", "/api/v1/me")["status"], 200);

    // A new host on the same data dir and keychain picks the token up again.
    let again = Harness::with(TestBrowser::default(), tempfile::tempdir().unwrap(), h.secrets.clone());
    std::fs::copy(h.dir.path().join("servers.json"), again.dir.path().join("servers.json")).unwrap();
    let again = Harness::with(TestBrowser::default(), again.dir, h.secrets.clone());
    assert_eq!(again.ok("server.list", json!({}))[0]["auth"], "token");
    assert_eq!(again.api(&id, "GET", "/api/v1/me")["status"], 200);

    // The server revokes the token: the next 401 signs the server out.
    fake.lock().pats.clear();
    assert_eq!(h.api(&id, "GET", "/api/v1/me")["status"], 401);
    assert_eq!(h.ok("server.list", json!({}))[0]["auth"], "signed-out");
    assert!(h.secrets.is_empty());
    h.assert_no_leaks(&[&fake]);
    again.assert_no_leaks(&[&fake]);
}

#[test]
fn a_callback_with_the_wrong_state_or_issuer_is_refused() {
    for (callback, message) in [(Callback::WrongState, "does not belong to this sign-in"), (Callback::WrongIss, "came from a different server")] {
        let fake = Fake::start(Config { callback, ..Config::default() });
        let h = Harness::new();
        let id = h.add(&fake);
        let e = h.call("server.signIn", json!({ "server": id })).unwrap_err();
        assert_eq!(e.code, "SIGN_IN_FAILED");
        assert!(e.message.contains(message), "{}", e.message);
        let (status, page) = h.browser.last_page();
        assert_eq!(status, 400);
        assert!(page.contains("Sign-in failed"));
        // The code was never exchanged.
        assert!(!fake.lock().requests.iter().any(|r| r == "POST /auth/token"));
        assert_eq!(h.ok("server.list", json!({}))[0]["auth"], "signed-out");
        assert!(h.secrets.is_empty());
        h.assert_no_leaks(&[&fake]);
    }
}

#[test]
fn sign_in_endpoints_on_another_origin_are_refused() {
    let elsewhere = Fake::start(Config::default());
    let fake = Fake::start(Config { endpoint_origin: Some(elsewhere.origin.clone()), ..Config::default() });
    let h = Harness::new();
    let id = h.add(&fake);
    let e = h.call("server.signIn", json!({ "server": id })).unwrap_err();
    assert_eq!(e.code, "SIGN_IN_FAILED");
    assert!(e.message.contains("are not on"), "{}", e.message);
    assert!(h.browser.opened.lock().unwrap().is_empty(), "no browser was opened");
    assert!(elsewhere.lock().requests.is_empty());
}

#[test]
fn one_sign_in_per_server_and_cancel() {
    let fake = Fake::start(Config::default());
    let h = Arc::new(Harness::with(TestBrowser { record_only: true, ..TestBrowser::default() }, tempfile::tempdir().unwrap(), Arc::new(MemorySecretStore::default())));
    let id = h.add(&fake);
    let first = {
        let (h, id) = (h.clone(), id.clone());
        std::thread::spawn(move || h.call("server.signIn", json!({ "server": id })))
    };
    while h.browser.opened.lock().unwrap().is_empty() {
        std::thread::sleep(Duration::from_millis(10));
    }
    let second = h.call("server.signIn", json!({ "server": id })).unwrap_err();
    assert_eq!((second.code, second.message.as_str()), ("SIGN_IN_FAILED", "A sign-in to this server is already in progress"));
    h.ok("server.signInCancel", json!({ "server": id }));
    let e = first.join().unwrap().unwrap_err();
    assert_eq!((e.code, e.message.as_str()), ("SIGN_IN_FAILED", "Sign-in was cancelled"));
    // Cancelled sign-ins release the server: a new one can start (and is cancelled again).
    h.ok("server.signInCancel", json!({ "server": id }));
}

#[test]
fn servers_must_be_https_or_loopback_and_speak_protocol_1() {
    let h = Harness::new();
    for url in ["http://example.org", "http://10.0.0.1:8080", "ftp://127.0.0.1", "https://u:p@example.org"] {
        assert_eq!(h.call("server.add", json!({ "url": url })).unwrap_err().code, "BAD_ARGUMENT", "{url}");
    }
    let v2 = Fake::start(Config { protocol_version: "2.0".into(), ..Config::default() });
    assert_eq!(h.call("server.add", json!({ "url": v2.origin })).unwrap_err().code, "SERVER_UNREACHABLE");
    // Not a Thoth server: capabilities is a 404.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let e = h.call("server.add", json!({ "url": format!("http://127.0.0.1:{port}") })).unwrap_err();
    assert_eq!(e.code, "SERVER_UNREACHABLE");
    assert!(e.message.starts_with("Could not reach http://127.0.0.1:"), "{}", e.message);
    assert_eq!(h.ok("server.list", json!({})), json!([]));
}

#[test]
fn api_call_stays_inside_api_v1_and_never_follows_redirects() {
    let target = Fake::start(Config::default());
    let fake = Fake::start(Config::default());
    let h = Harness::new();
    let id = h.signed_in(&fake);
    for path in ["/auth/token", "/api/v1/../auth/token", "/api/v1/%2e%2e/auth/token", "/api/v1//x", "/api/v1/me?x=1", "/api/v1/me#x", "/api/v1/a%2fb"] {
        let e = h.call("api.call", json!({ "server": id, "method": "GET", "path": path })).unwrap_err();
        assert_eq!(e.code, "BAD_ARGUMENT", "{path}");
    }
    for (args, why) in [
        (json!({ "server": id, "method": "PATCH", "path": "/api/v1/me" }), "method"),
        (json!({ "server": id, "method": "GET", "path": "/api/v1/me", "headers": { "authorization": "Bearer x" } }), "authorization header"),
        (json!({ "server": id, "method": "GET", "path": "/api/v1/me", "headers": { "cookie": "a=b" } }), "cookie header"),
        (json!({ "server": "server_nope", "method": "GET", "path": "/api/v1/me" }), "unknown server"),
    ] {
        assert!(h.call("api.call", args).is_err(), "{why}");
    }
    assert_eq!(h.call_bytes("api.call", json!({ "server": id, "method": "GET", "path": "/api/v1/me" }), Some(b"x")).unwrap_err().code, "BAD_ARGUMENT");

    let to = format!("{}/api/v1/me", target.origin);
    let reply = h.ok("api.call", json!({ "server": id, "method": "GET", "path": "/api/v1/redirect", "query": { "to": to } }));
    assert_eq!(reply["status"], 302);
    assert_eq!(reply["headers"]["location"], to.as_str());
    assert!(target.lock().requests.is_empty(), "the redirect was not followed, so no token went to it");
    h.assert_no_leaks(&[&fake, &target]);
}

#[test]
fn network_failures_are_server_unreachable() {
    let fake = Fake::start(Config { sign_in: false, ..Config::default() });
    let h = Harness::new();
    let id = h.add(&fake);
    // Point the saved server at a closed port by rewriting the list and reloading.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let closed = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    drop(listener);
    let list = std::fs::read_to_string(h.dir.path().join("servers.json")).unwrap().replace(&fake.origin, &closed);
    std::fs::write(h.dir.path().join("servers.json"), list).unwrap();
    let h2 = Harness::with(TestBrowser::default(), h.dir, Arc::new(MemorySecretStore::default()));
    let e = h2.call("api.call", json!({ "server": id, "method": "GET", "path": "/api/v1/me" })).unwrap_err();
    assert_eq!(e.code, "SERVER_UNREACHABLE");
}

/// Drives sign-in through the stdio harness binary and checks that no token reaches its output.
#[test]
fn stdio_harness_never_prints_a_secret() {
    use std::io::{BufRead, BufReader, Write};
    let fake = Fake::start(Config::default());
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_thoth-host-stdio"))
        .arg("--data-dir")
        .arg(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut printed: Vec<String> = Vec::new();
    let send = |stdin: &mut std::process::ChildStdin, id: u64, command: &str, args: Value| writeln!(stdin, "{}", json!({ "id": id, "command": command, "args": args })).unwrap();
    let mut until = |printed: &mut Vec<String>, pred: &dyn Fn(&Value) -> bool| -> Value {
        loop {
            let line = lines.next().unwrap().unwrap();
            printed.push(line.clone());
            let v: Value = serde_json::from_str(&line).unwrap();
            if pred(&v) {
                return v;
            }
        }
    };

    send(&mut stdin, 1, "server.add", json!({ "url": fake.origin }));
    let added = until(&mut printed, &|v| v["id"] == 1);
    let id = added["result"]["id"].as_str().unwrap().to_owned();
    send(&mut stdin, 2, "server.signIn", json!({ "server": id }));
    let opened = until(&mut printed, &|v| v["event"] == "browser.open");
    let page = follow(opened["payload"]["url"].as_str().unwrap());
    let signed = until(&mut printed, &|v| v["id"] == 2);
    assert_eq!(signed["result"]["auth"], "browser", "{signed}");
    assert_eq!(page.join().unwrap().unwrap().0, 200);
    send(&mut stdin, 3, "api.call", json!({ "server": id, "method": "GET", "path": "/api/v1/me" }));
    assert_eq!(until(&mut printed, &|v| v["id"] == 3)["result"]["status"], 200);
    fake.expire_access_tokens();
    send(&mut stdin, 4, "api.call", json!({ "server": id, "method": "GET", "path": "/api/v1/me" }));
    assert_eq!(until(&mut printed, &|v| v["id"] == 4)["result"]["status"], 200);
    send(&mut stdin, 5, "server.signOut", json!({ "server": id }));
    assert_eq!(until(&mut printed, &|v| v["id"] == 5)["result"]["auth"], "signed-out");
    let pat = fake.add_pat();
    send(&mut stdin, 6, "server.useToken", json!({ "server": id, "token": pat }));
    assert_eq!(until(&mut printed, &|v| v["id"] == 6)["result"]["auth"], "token");
    drop(stdin);
    for line in lines {
        printed.push(line.unwrap());
    }
    let mut stderr = String::new();
    std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut stderr).unwrap();
    assert!(child.wait().unwrap().success());

    let s = fake.lock();
    assert!(s.refreshes >= 1 && s.session_revoked);
    assert!(s.issued.len() >= 6);
    let list = std::fs::read_to_string(dir.path().join("servers.json")).unwrap();
    for secret in &s.issued {
        for line in printed.iter().chain([&stderr, &list]) {
            assert!(!line.contains(secret.as_str()), "harness output leaks a secret: {line}");
        }
    }
}
