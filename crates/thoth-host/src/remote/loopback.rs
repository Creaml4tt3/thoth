//! The RFC 8252 loopback redirect: a one-shot listener on `127.0.0.1:0` that waits for the browser to come
//! back to `/callback`. Other paths (a favicon, a stray request) are answered 404 and do not end the wait.
//! The first `GET /callback` ends it either way: it is checked (state in constant time, `iss`, a code or an
//! OAuth error), the browser gets a small page, and the listener closes, so a second callback is refused.
use crate::error::{HostError, HostResult};
use sha2::{Digest, Sha256};
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// How long the browser has to come back.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_REQUEST: usize = 8 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(25);
const MAX_CODE: usize = 1024;

pub struct Loopback {
    listener: TcpListener,
    port: u16,
}

/// What the browser brought back.
#[derive(Debug, PartialEq, Eq)]
pub struct Callback {
    pub code: String,
}

impl Loopback {
    pub fn bind() -> HostResult<Self> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).map_err(|_| sign_in_failed("Could not open a local port for the browser to return to"))?;
        listener.set_nonblocking(true).map_err(|_| sign_in_failed("Could not open a local port for the browser to return to"))?;
        let port = listener.local_addr().map_err(|_| sign_in_failed("Could not open a local port for the browser to return to"))?.port();
        Ok(Self { listener, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    /// Waits for the one `GET /callback`, until `timeout` passes or `cancel` is set. Consumes the listener.
    pub fn wait(self, state: &str, issuer: &str, timeout: Duration, cancel: &Arc<AtomicBool>) -> HostResult<Callback> {
        let deadline = Instant::now() + timeout;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(sign_in_failed("Sign-in was cancelled"));
            }
            if Instant::now() >= deadline {
                return Err(sign_in_failed("Sign-in timed out: the browser did not come back within 5 minutes"));
            }
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if let Some(outcome) = serve(stream, state, issuer) {
                        return outcome;
                    }
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => std::thread::sleep(POLL),
                Err(_) => std::thread::sleep(POLL),
            }
        }
    }
}

/// Answers one connection. `None`: not the callback (or not a complete request), keep waiting.
fn serve(mut stream: TcpStream, state: &str, issuer: &str) -> Option<HostResult<Callback>> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
    let head = read_head(&mut stream)?;
    let line = head.split("\r\n").next().unwrap_or_default();
    let mut parts = line.split(' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if !version.starts_with("HTTP/1.") || parts.next().is_some() {
        respond(&mut stream, 400, "Bad request", "");
        return None;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if method != "GET" || path != "/callback" {
        respond(&mut stream, 404, "Not found", "");
        return None;
    }
    let outcome = check(query, state, issuer);
    match &outcome {
        Ok(_) => respond(&mut stream, 200, "Signed in", "You are signed in to Thoth. You can close this window and return to the app."),
        Err(e) => respond(&mut stream, 400, "Sign-in failed", &format!("{} Return to the Thoth app and try again.", e.message)),
    }
    Some(outcome)
}

/// Reads up to the end of the request head. `None` for an empty, slow, oversized or non-UTF-8 request.
fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let started = Instant::now();
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        if buf.len() > MAX_REQUEST || started.elapsed() > READ_TIMEOUT {
            return None;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    String::from_utf8(buf).ok()
}

/// The callback's verdict. Every parameter appears at most once; `state` must match in constant time;
/// `iss` (RFC 9207) must be the server's origin; then either `code` or an OAuth `error`.
fn check(query: &str, state: &str, issuer: &str) -> HostResult<Callback> {
    let mut seen: Vec<(String, String)> = Vec::new();
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        if seen.iter().any(|(s, _)| *s == k) {
            return Err(sign_in_failed("The browser returned a malformed sign-in response"));
        }
        seen.push((k.into_owned(), v.into_owned()));
    }
    let get = |key: &str| seen.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    if !get("state").is_some_and(|got| constant_time_eq(got, state)) {
        return Err(sign_in_failed("The browser returned a sign-in response that does not belong to this sign-in"));
    }
    if get("iss") != Some(issuer) {
        return Err(sign_in_failed("The sign-in response came from a different server"));
    }
    if let Some(error) = get("error") {
        return Err(sign_in_failed(match error {
            "access_denied" => "Sign-in was declined or the server is not accepting new accounts",
            "server_error" | "temporarily_unavailable" => "The server could not complete the sign-in; try again later",
            _ => "The server refused the sign-in request",
        }));
    }
    match get("code") {
        Some(code) if !code.is_empty() && code.len() <= MAX_CODE => Ok(Callback { code: code.to_owned() }),
        _ => Err(sign_in_failed("The browser returned a sign-in response without a code")),
    }
}

/// Compares SHA-256 digests of both values, so neither the content nor the length leaks through timing.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (da, db) = (Sha256::digest(a.as_bytes()), Sha256::digest(b.as_bytes()));
    da.iter().zip(db.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn respond(stream: &mut TcpStream, status: u16, title: &str, text: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let body = if text.is_empty() {
        String::new()
    } else {
        format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{t}</title></head><body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem\"><h1>{t}</h1><p>{x}</p></body></html>",
            t = escape(title),
            x = escape(text)
        )
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

pub fn sign_in_failed(message: impl Into<String>) -> HostError {
    HostError::new("SIGN_IN_FAILED", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;

    const ISS: &str = "http://127.0.0.1:9";

    /// Starts `wait` on a thread; returns the port and the join handle.
    fn waiting(timeout: Duration, cancel: Arc<AtomicBool>) -> (u16, std::thread::JoinHandle<HostResult<Callback>>) {
        let loopback = Loopback::bind().unwrap();
        assert!(loopback.redirect_uri().starts_with("http://127.0.0.1:"));
        let port = loopback.port;
        (port, std::thread::spawn(move || loopback.wait("the-state", ISS, timeout, &cancel)))
    }

    /// One raw GET; returns the status code and body.
    fn get(port: u16, target: &str) -> std::io::Result<(u16, String)> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        write!(stream, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")?;
        let mut reader = std::io::BufReader::new(stream);
        let mut status = String::new();
        reader.read_line(&mut status)?;
        let mut rest = String::new();
        reader.read_to_string(&mut rest)?;
        let code = status.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        Ok((code, rest))
    }

    fn callback(query: &str) -> String {
        format!("/callback?{query}")
    }

    #[test]
    fn accepts_one_valid_callback_and_ignores_other_paths() {
        let (port, waiter) = waiting(Duration::from_secs(10), Arc::new(AtomicBool::new(false)));
        assert_eq!(get(port, "/favicon.ico").unwrap().0, 404);
        // A connection that sends nothing (a browser preconnect) does not end the wait either.
        drop(TcpStream::connect(("127.0.0.1", port)).unwrap());
        let (status, body) = get(port, &callback("code=c0de&state=the-state&iss=http%3A%2F%2F127.0.0.1%3A9")).unwrap();
        assert_eq!(status, 200);
        assert!(body.contains("You can close this window"));
        assert_eq!(waiter.join().unwrap().unwrap(), Callback { code: "c0de".into() });
        // The listener is gone: a second callback cannot connect.
        assert!(get(port, &callback("code=again&state=the-state&iss=http%3A%2F%2F127.0.0.1%3A9")).is_err());
    }

    #[test]
    fn refuses_a_wrong_or_missing_state() {
        for query in ["code=c&state=other&iss=http%3A%2F%2F127.0.0.1%3A9", "code=c&iss=http%3A%2F%2F127.0.0.1%3A9", "code=c&state=the-statE&iss=http%3A%2F%2F127.0.0.1%3A9", "code=c&state=the-state&state=the-state&iss=http%3A%2F%2F127.0.0.1%3A9"] {
            let (port, waiter) = waiting(Duration::from_secs(10), Arc::new(AtomicBool::new(false)));
            let (status, body) = get(port, &callback(query)).unwrap();
            assert_eq!(status, 400, "{query}");
            assert!(body.contains("Sign-in failed"));
            assert_eq!(waiter.join().unwrap().unwrap_err().code, "SIGN_IN_FAILED", "{query}");
        }
    }

    #[test]
    fn refuses_a_wrong_or_missing_issuer() {
        for query in ["code=c&state=the-state&iss=https%3A%2F%2Fevil.example.org", "code=c&state=the-state", "code=c&state=the-state&iss=http%3A%2F%2F127.0.0.1%3A9%2F"] {
            let (port, waiter) = waiting(Duration::from_secs(10), Arc::new(AtomicBool::new(false)));
            assert_eq!(get(port, &callback(query)).unwrap().0, 400, "{query}");
            let error = waiter.join().unwrap().unwrap_err();
            assert_eq!(error.message, "The sign-in response came from a different server", "{query}");
        }
    }

    #[test]
    fn reports_an_oauth_error_without_echoing_it() {
        let (port, waiter) = waiting(Duration::from_secs(10), Arc::new(AtomicBool::new(false)));
        let (status, body) = get(port, &callback("error=%3Cscript%3E&error_description=%3Cb%3Ex&state=the-state&iss=http%3A%2F%2F127.0.0.1%3A9")).unwrap();
        assert_eq!(status, 400);
        assert!(!body.contains("<script>") && !body.contains("<b>"));
        assert_eq!(waiter.join().unwrap().unwrap_err().message, "The server refused the sign-in request");
    }

    #[test]
    fn times_out() {
        let (_port, waiter) = waiting(Duration::from_millis(200), Arc::new(AtomicBool::new(false)));
        assert!(waiter.join().unwrap().unwrap_err().message.starts_with("Sign-in timed out"));
    }

    #[test]
    fn can_be_cancelled() {
        let cancel = Arc::new(AtomicBool::new(false));
        let (_port, waiter) = waiting(Duration::from_secs(30), cancel.clone());
        std::thread::sleep(Duration::from_millis(100));
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(waiter.join().unwrap().unwrap_err().message, "Sign-in was cancelled");
    }

    #[test]
    fn constant_time_eq_compares_content_and_length() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(!constant_time_eq("", "a"));
    }
}
