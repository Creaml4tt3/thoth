//! A small fake Thoth server for the remote tests: capabilities, the sign-in broker (authorize redirects
//! straight back with a code, token endpoint with PKCE and refresh rotation that treats reuse as theft,
//! revocation) and a few `/api/v1` routes. Every secret it issues is recorded, for the leak checks.
#![allow(dead_code)]
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Callback {
    /// Redirect back with the right state and iss.
    Good,
    WrongState,
    WrongIss,
}

pub struct Config {
    /// The origin used in `signIn` endpoints; `None` is the server's own origin.
    pub endpoint_origin: Option<String>,
    pub sign_in: bool,
    pub protocol_version: String,
    pub expires_in: u64,
    pub callback: Callback,
    /// Delay of the token endpoint's refresh answer, so concurrent refreshes would overlap.
    pub refresh_delay: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self { endpoint_origin: None, sign_in: true, protocol_version: "1.0".into(), expires_in: 900, callback: Callback::Good, refresh_delay: Duration::from_millis(150) }
    }
}

#[derive(Default)]
pub struct State {
    pub config: Config,
    /// code -> (challenge, redirect_uri)
    codes: HashMap<String, (String, String)>,
    pub live_access: HashSet<String>,
    /// refresh token -> used
    refresh: HashMap<String, bool>,
    pub pats: HashSet<String>,
    /// Every secret handed out or accepted.
    pub issued: Vec<String>,
    pub refreshes: u64,
    pub reuse_detected: u64,
    pub revoked: Vec<String>,
    pub session_revoked: bool,
    /// Authorization headers seen, per path.
    pub authorization: Vec<(String, Option<String>)>,
    pub requests: Vec<String>,
}

pub struct Fake {
    pub origin: String,
    pub port: u16,
    pub state: Arc<Mutex<State>>,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

fn secret(prefix: &str) -> String {
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).unwrap();
    format!("{prefix}{}_{}", B64URL.encode(b), NEXT.fetch_add(1, Ordering::SeqCst))
}

impl Fake {
    pub fn start(config: Config) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let origin = format!("http://127.0.0.1:{port}");
        let state = Arc::new(Mutex::new(State { config, ..State::default() }));
        let (s, o) = (state.clone(), origin.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (s, o) = (s.clone(), o.clone());
                std::thread::spawn(move || serve(stream, &s, &o));
            }
        });
        Self { origin, port, state }
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    pub fn add_pat(&self) -> String {
        let pat = secret("thoth_pat_");
        let mut s = self.lock();
        s.pats.insert(pat.clone());
        s.issued.push(pat.clone());
        pat
    }

    /// Server-side expiry of every access token (like editing `access_tokens.expires_at`).
    pub fn expire_access_tokens(&self) {
        self.lock().live_access.clear();
    }
}

struct Req {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read(stream: &mut TcpStream) -> Option<Req> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.trim_end().split(' ');
    let method = parts.next()?.to_owned();
    let target = parts.next()?.to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        reader.read_line(&mut h).ok()?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        let (k, v) = h.split_once(':')?;
        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
    }
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body = vec![0; len];
    reader.read_exact(&mut body).ok()?;
    let (path, q) = target.split_once('?').unwrap_or((&target, ""));
    let query = url::form_urlencoded::parse(q.as_bytes()).into_owned().collect();
    Some(Req { method, path: path.to_owned(), query, headers, body })
}

fn send(stream: &mut TcpStream, status: u16, headers: &[(&str, &str)], body: &str) {
    let mut head = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn json_reply(stream: &mut TcpStream, status: u16, body: Value) {
    send(stream, status, &[("content-type", "application/json"), ("set-cookie", "sid=secret-cookie"), ("x-internal", "1")], &body.to_string());
}

fn serve(mut stream: TcpStream, state: &Arc<Mutex<State>>, origin: &str) {
    let Some(req) = read(&mut stream) else { return };
    let bearer = req.headers.get("authorization").and_then(|a| a.strip_prefix("Bearer ")).map(str::to_owned);
    {
        let mut s = state.lock().unwrap();
        s.authorization.push((req.path.clone(), req.headers.get("authorization").cloned()));
        s.requests.push(format!("{} {}", req.method, req.path));
    }
    let form: HashMap<String, String> = url::form_urlencoded::parse(&req.body).into_owned().collect();
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/v1/capabilities") => {
            let s = state.lock().unwrap();
            let base = s.config.endpoint_origin.clone().unwrap_or_else(|| origin.to_owned());
            let mut caps = json!({ "protocolVersion": s.config.protocol_version, "capabilities": [], "limits": { "maxPageSize": 200 }, "server": { "name": "Fake Thoth", "version": "0" } });
            if s.config.sign_in {
                caps["signIn"] = json!({ "authorizationEndpoint": format!("{base}/auth/authorize"), "tokenEndpoint": format!("{base}/auth/token"), "revocationEndpoint": format!("{base}/auth/revoke"), "providers": [{ "id": "google", "name": "Google" }] });
            }
            json_reply(&mut stream, 200, caps);
        }
        ("GET", "/auth/authorize") => {
            let q = &req.query;
            let ok = q.get("client_id").map(String::as_str) == Some("thoth-desktop") && q.get("code_challenge_method").map(String::as_str) == Some("S256") && q.get("response_type").map(String::as_str) == Some("code");
            let redirect = q.get("redirect_uri").cloned().unwrap_or_default();
            assert!(redirect.starts_with("http://127.0.0.1:") && redirect.ends_with("/callback"), "redirect {redirect}");
            let mut s = state.lock().unwrap();
            let code = secret("code_");
            s.issued.push(code.clone());
            s.codes.insert(code.clone(), (q.get("code_challenge").cloned().unwrap_or_default(), redirect.clone()));
            let st = match s.config.callback {
                Callback::WrongState => "not-the-state".to_owned(),
                _ => q.get("state").cloned().unwrap_or_default(),
            };
            let iss = if s.config.callback == Callback::WrongIss { "https://evil.example.org".to_owned() } else { origin.to_owned() };
            drop(s);
            let back = if ok { format!("{redirect}?{}", url::form_urlencoded::Serializer::new(String::new()).append_pair("code", &code).append_pair("state", &st).append_pair("iss", &iss).finish()) } else { format!("{redirect}?error=invalid_request") };
            send(&mut stream, 302, &[("location", &back)], "");
        }
        ("POST", "/auth/token") => {
            if form.get("client_id").map(String::as_str) != Some("thoth-desktop") {
                return json_reply(&mut stream, 400, json!({ "error": "invalid_client" }));
            }
            match form.get("grant_type").map(String::as_str) {
                Some("authorization_code") => {
                    let mut s = state.lock().unwrap();
                    let entry = s.codes.remove(form.get("code").map(String::as_str).unwrap_or(""));
                    let verifier = form.get("code_verifier").cloned().unwrap_or_default();
                    s.issued.push(verifier.clone());
                    let Some((challenge, redirect)) = entry else { drop(s); return json_reply(&mut stream, 400, json!({ "error": "invalid_grant" })) };
                    if B64URL.encode(Sha256::digest(verifier.as_bytes())) != challenge || form.get("redirect_uri") != Some(&redirect) {
                        drop(s);
                        return json_reply(&mut stream, 400, json!({ "error": "invalid_grant" }));
                    }
                    let (at, rt) = (secret("thoth_at_"), secret("thoth_rt_"));
                    s.live_access.insert(at.clone());
                    s.refresh.insert(rt.clone(), false);
                    s.issued.extend([at.clone(), rt.clone()]);
                    let expires_in = s.config.expires_in;
                    drop(s);
                    json_reply(&mut stream, 200, json!({ "access_token": at, "token_type": "Bearer", "expires_in": expires_in, "refresh_token": rt }));
                }
                Some("refresh_token") => {
                    let delay = state.lock().unwrap().config.refresh_delay;
                    std::thread::sleep(delay);
                    let mut s = state.lock().unwrap();
                    s.refreshes += 1;
                    let presented = form.get("refresh_token").cloned().unwrap_or_default();
                    match s.refresh.get(&presented).copied() {
                        Some(false) if !s.session_revoked => {
                            s.refresh.insert(presented, true);
                            let (at, rt) = (secret("thoth_at_"), secret("thoth_rt_"));
                            s.live_access.insert(at.clone());
                            s.refresh.insert(rt.clone(), false);
                            s.issued.extend([at.clone(), rt.clone()]);
                            let expires_in = s.config.expires_in;
                            drop(s);
                            json_reply(&mut stream, 200, json!({ "access_token": at, "token_type": "Bearer", "expires_in": expires_in, "refresh_token": rt }));
                        }
                        Some(true) => {
                            // Reuse: theft. Revoke the whole session.
                            s.reuse_detected += 1;
                            s.session_revoked = true;
                            s.live_access.clear();
                            drop(s);
                            json_reply(&mut stream, 400, json!({ "error": "invalid_grant" }));
                        }
                        _ => {
                            drop(s);
                            json_reply(&mut stream, 400, json!({ "error": "invalid_grant" }));
                        }
                    }
                }
                _ => json_reply(&mut stream, 400, json!({ "error": "unsupported_grant_type" })),
            }
        }
        ("POST", "/auth/revoke") => {
            let mut s = state.lock().unwrap();
            let token = form.get("token").cloned().unwrap_or_default();
            if s.refresh.contains_key(&token) {
                s.session_revoked = true;
                s.live_access.clear();
            }
            s.revoked.push(token);
            drop(s);
            json_reply(&mut stream, 200, json!({}));
        }
        (_, path) if path.starts_with("/api/v1/") => {
            let authorized = {
                let s = state.lock().unwrap();
                bearer.as_ref().is_some_and(|b| s.live_access.contains(b) || s.pats.contains(b))
            };
            if path == "/api/v1/redirect" {
                let to = req.query.get("to").cloned().unwrap_or_default();
                return send(&mut stream, 302, &[("location", &to)], "");
            }
            if !authorized {
                return send(&mut stream, 401, &[("content-type", "application/problem+json"), ("www-authenticate", "Bearer")], r#"{"type":"about:blank","title":"Unauthorized","status":401,"code":"unauthorized"}"#);
            }
            match path {
                "/api/v1/me" => json_reply(&mut stream, 200, json!({ "id": "usr_1", "displayName": "Ada", "email": "ada@example.org" })),
                "/api/v1/echo" => {
                    let body = json!({ "method": req.method, "query": req.query, "ifMatch": req.headers.get("if-match"), "contentType": req.headers.get("content-type"), "body": String::from_utf8_lossy(&req.body) });
                    send(&mut stream, 201, &[("content-type", "application/json"), ("etag", "\"r2\""), ("location", "/api/v1/echo"), ("set-cookie", "sid=x")], &body.to_string());
                }
                "/api/v1/missing" => send(&mut stream, 404, &[("content-type", "application/problem+json")], r#"{"code":"not_found"}"#),
                _ => send(&mut stream, 404, &[], ""),
            }
        }
        _ => send(&mut stream, 404, &[], ""),
    }
}

/// Plays the browser: follows the authorize URL's redirect to the loopback callback, on its own thread.
pub fn follow(url: &str) -> std::thread::JoinHandle<Option<(u16, String)>> {
    let url = url.to_owned();
    std::thread::spawn(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder().max_redirects(0).http_status_as_error(false).build().into();
        let first = agent.get(&url).call().ok()?;
        let location = first.headers().get("location")?.to_str().ok()?.to_owned();
        let mut back = agent.get(&location).call().ok()?;
        let status = back.status().as_u16();
        Some((status, back.body_mut().read_to_string().unwrap_or_default()))
    })
}
