//! Link previews (ADR-0020 rules 3, 4 and 6) against a local page server. The server runs on 127.0.0.1, which the
//! rules refuse; tests that need to reach it turn on the test switch (`allow_loopback`, the stdio harness's
//! `--link-preview-loopback`), which lets loopback through and nothing else. Names resolve through a fake resolver,
//! so private, link-local and rebinding names are tested without a real DNS server.
//!
//! The update notice (ADR-0022) asks `latest.json` through the same fetcher, so its fetch rules are tested here too,
//! against the same server and the same fake resolver (the last section).
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use thoth_host::links::cache::CacheLimits;
use thoth_host::links::fetch::{Lookup, USER_AGENT};
use thoth_host::links::{LinkOptions, LinkPreviews};
use thoth_host::updates::{UpdateOptions, Updates};
use thoth_host::{Browser, FileManager, Host, HostConfig, HostResult, MemorySecretStore, Picker};

// ---------------------------------------------------------------------------------------------- the page server

/// What a route answers.
#[derive(Clone)]
enum Answer {
    /// Status, headers and body, then the connection closes.
    Full(u16, Vec<(&'static str, String)>, Vec<u8>),
    /// Headers and the first bytes, then the connection stays open (and silent) for a long time.
    Hang(Vec<(&'static str, String)>, Vec<u8>),
    /// Headers, then one byte every 300 ms, forever.
    Drip,
    /// Accepts and never answers.
    Silent,
}

type Routes = Arc<Mutex<HashMap<String, Answer>>>;

struct Server {
    port: u16,
    routes: Routes,
    /// Every request's head (request line and headers), in order.
    seen: Arc<Mutex<Vec<String>>>,
}

impl Server {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let routes: Routes = Arc::default();
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let (r, s) = (routes.clone(), seen.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (r, s) = (r.clone(), s.clone());
                std::thread::spawn(move || serve(stream, &r, &s));
            }
        });
        Self { port, routes, seen }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn route(&self, path: &str, answer: Answer) -> &Self {
        self.routes.lock().unwrap().insert(path.to_owned(), answer);
        self
    }

    fn html(&self, path: &str, html: &str) -> &Self {
        self.route(path, Answer::Full(200, vec![("content-type", "text/html; charset=utf-8".into())], html.as_bytes().to_vec()))
    }

    fn redirect(&self, path: &str, to: &str) -> &Self {
        self.route(path, Answer::Full(302, vec![("location", to.into()), ("set-cookie", "session=secret; Path=/".into())], Vec::new()))
    }

    fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }

    fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

fn serve(stream: TcpStream, routes: &Routes, seen: &Arc<Mutex<Vec<String>>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        if line == "\r\n" {
            break;
        }
        head.push_str(&line);
    }
    seen.lock().unwrap().push(head.clone());
    let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
    let answer = routes.lock().unwrap().get(&path).cloned().unwrap_or(Answer::Full(404, vec![], b"no".to_vec()));
    let mut out = stream;
    let write_head = |out: &mut TcpStream, status: u16, headers: &[(&str, String)], length: Option<usize>| {
        let mut text = format!("HTTP/1.1 {status} X\r\n");
        for (n, v) in headers {
            text.push_str(&format!("{n}: {v}\r\n"));
        }
        if let Some(length) = length {
            text.push_str(&format!("content-length: {length}\r\n"));
        }
        text.push_str("connection: close\r\n\r\n");
        let _ = out.write_all(text.as_bytes());
    };
    match answer {
        Answer::Full(status, headers, body) => {
            write_head(&mut out, status, &headers, Some(body.len()));
            let _ = out.write_all(&body);
        }
        Answer::Hang(headers, body) => {
            write_head(&mut out, 200, &headers, None);
            let _ = out.write_all(&body);
            let _ = out.flush();
            std::thread::sleep(Duration::from_secs(20));
        }
        Answer::Drip => {
            write_head(&mut out, 200, &[("content-type", "text/html".into())], None);
            for _ in 0..100 {
                if out.write_all(b" ").and_then(|()| out.flush()).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }
        Answer::Silent => std::thread::sleep(Duration::from_secs(20)),
    }
}

// ------------------------------------------------------------------------------------------- the fake resolver

/// Answers names from a table; a name with several answers gives the next one on each lookup.
#[derive(Default)]
struct FakeDns {
    answers: Mutex<HashMap<String, Vec<Vec<IpAddr>>>>,
    lookups: AtomicUsize,
}

impl FakeDns {
    fn with(entries: &[(&str, &[&str])]) -> Arc<Self> {
        let dns = Self::default();
        for (name, ips) in entries {
            dns.answers.lock().unwrap().entry((*name).to_owned()).or_default().push(ips.iter().map(|ip| ip.parse().unwrap()).collect());
        }
        Arc::new(dns)
    }
}

impl Lookup for FakeDns {
    fn lookup(&self, host: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        let mut answers = self.answers.lock().unwrap();
        let list = answers.get_mut(host).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no such name"))?;
        let ips = if list.len() > 1 { list.remove(0) } else { list[0].clone() };
        Ok(ips.into_iter().map(|ip| SocketAddr::new(ip, port)).collect())
    }
}

fn previews(loopback: bool, dns: Option<Arc<FakeDns>>, data: Option<PathBuf>) -> LinkPreviews {
    let mut options = LinkOptions { allow_loopback: loopback, ..LinkOptions::default() };
    if let Some(dns) = dns {
        options.lookup = dns;
    }
    LinkPreviews::new(data, options)
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\rIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\0\x05\0\x01\xff\x89\x99=\x1d\0\0\0\0IEND\xaeB`\x82";

fn image(server: &Server, path: &str, bytes: &[u8], content_type: &str) {
    server.route(path, Answer::Full(200, vec![("content-type", content_type.into())], bytes.to_vec()));
}

fn page(title: &str, image: &str) -> String {
    format!(r#"<!doctype html><html><head><meta charset="utf-8"><title>Fallback</title><meta property="og:title" content="{title}"><meta property="og:description" content="Line one.
Line two."><meta property="og:site_name" content="Example Site"><meta property="og:image" content="{image}"></head><body>Body</body></html>"#)
}

// ------------------------------------------------------------------------------------------------------- tests

#[test]
fn reads_a_preview_and_its_image_as_a_data_url() {
    let server = Server::start();
    server.html("/page", &page("A &lt;b&gt;title&lt;/b&gt; \u{202e}here", "/img.png"));
    image(&server, "/img.png", PNG, "image/png");
    let p = previews(true, None, None).preview(&server.url("/page#part")).unwrap();
    assert_eq!(p["url"], server.url("/page"));
    assert_eq!(p["finalUrl"], server.url("/page"));
    assert_eq!(p["siteName"], "Example Site");
    // Decoded, stripped of the override, still the same text (markup stays text).
    assert_eq!(p["title"], "A <b>title</b> here");
    assert_eq!(p["description"], "Line one. Line two.");
    let data = p["image"].as_str().unwrap();
    assert!(data.starts_with("data:image/png;base64,"), "{data}");
    assert_eq!(B64.decode(&data["data:image/png;base64,".len()..]).unwrap(), PNG);
    // Nothing else is sent to the webview.
    assert_eq!(p.as_object().unwrap().keys().cloned().collect::<Vec<_>>(), ["url", "finalUrl", "siteName", "title", "description", "image"]);
}

#[test]
fn cuts_title_description_and_site_name() {
    let server = Server::start();
    let long = |n: usize| "ก".repeat(n);
    server.html("/long", &format!(r#"<head><meta property="og:title" content="{}"><meta property="og:description" content="{}"><meta property="og:site_name" content="{}"></head>"#, long(500), long(500), long(500)));
    let p = previews(true, None, None).preview(&server.url("/long")).unwrap();
    assert_eq!(p["title"].as_str().unwrap().chars().count(), 200);
    assert_eq!(p["description"].as_str().unwrap().chars().count(), 300);
    assert_eq!(p["siteName"].as_str().unwrap().chars().count(), 80);
    assert!(p.get("image").is_none());
}

#[test]
fn refuses_every_non_public_address_without_connecting() {
    let server = Server::start();
    server.html("/page", &page("T", ""));
    let port = server.port;
    let dns = FakeDns::with(&[
        ("ten.test", &["10.1.2.3"]),
        ("home.test", &["192.168.1.1"]),
        ("corp.test", &["172.16.5.5"]),
        ("meta.test", &["169.254.169.254"]),
        ("cgnat.test", &["100.64.1.1"]),
        ("multi.test", &["239.1.1.1"]),
        ("zero.test", &["0.0.0.0"]),
        ("loop.test", &["127.0.0.1"]),
        ("ula.test", &["fd00::1"]),
        ("ll6.test", &["fe80::1"]),
        ("mapped.test", &["::ffff:10.0.0.1"]),
        ("mapped-loop.test", &["::ffff:127.0.0.1"]),
        ("loop6.test", &["::1"]),
    ]);
    let links = previews(false, Some(dns.clone()), None);
    let mut urls: Vec<String> = ["ten", "home", "corp", "meta", "cgnat", "multi", "zero", "loop", "ula", "ll6", "mapped", "mapped-loop", "loop6"].iter().map(|n| format!("http://{n}.test:{port}/page")).collect();
    urls.extend([
        format!("http://127.0.0.1:{port}/page"),
        format!("http://[::1]:{port}/page"),
        format!("http://[::ffff:127.0.0.1]:{port}/page"),
        format!("http://0.0.0.0:{port}/page"),
        format!("http://0x7f000001:{port}/page"),
        format!("http://localhost:{port}/page"),
        format!("http://app.localhost:{port}/page"),
        format!("http://printer.local:{port}/page"),
        "http://10.0.0.1/".into(),
        "http://169.254.169.254/latest/meta-data/".into(),
        "http://[fd00::1]/".into(),
        "http://[fe80::1]/".into(),
        "http://100.100.100.100/".into(),
        "http://224.0.0.251/".into(),
    ]);
    for url in &urls {
        let e = links.preview(url).unwrap_err();
        assert_eq!(e.code, "NOT_ALLOWED", "{url}: {e:?}");
        assert!(!e.message.contains("/page"), "the message names the origin only: {}", e.message);
    }
    assert_eq!(server.count(), 0, "nothing was connected to");
    // `localhost` and `.local` are refused before any lookup.
    assert_eq!(dns.lookups.load(Ordering::SeqCst), 13);
    // Other schemes and credentials never get that far.
    for url in ["javascript:alert(1)", "data:text/html,x", "file:///etc/hosts", "ftp://example.com/", "https://user:pw@example.com/"] {
        assert_eq!(links.preview(url).unwrap_err().code, "NOT_ALLOWED", "{url}");
    }
    assert_eq!(links.preview("not a link").unwrap_err().code, "BAD_ARGUMENT");
}

#[test]
fn the_test_switch_lets_loopback_through_and_nothing_else() {
    let server = Server::start();
    server.html("/page", &page("T", ""));
    let dns = FakeDns::with(&[("ten.test", &["10.0.0.1"])]);
    let links = previews(true, Some(dns), None);
    assert!(links.preview(&server.url("/page")).is_ok());
    assert_eq!(links.preview(&format!("http://ten.test:{}/page", server.port)).unwrap_err().code, "NOT_ALLOWED");
    assert_eq!(links.preview(&format!("http://localhost:{}/page", server.port)).unwrap_err().code, "NOT_ALLOWED");
}

#[test]
fn a_redirect_to_a_private_address_is_refused() {
    let server = Server::start();
    let port = server.port;
    server.html("/page", &page("T", ""));
    server.redirect("/to-ten", "http://10.0.0.1/admin");
    server.redirect("/to-name", &format!("http://inside.test:{port}/page"));
    server.redirect("/to-localhost", &format!("http://localhost:{port}/page"));
    server.redirect("/to-metadata", "http://[::ffff:169.254.169.254]/");
    server.redirect("/to-file", "file:///etc/passwd");
    let dns = FakeDns::with(&[("inside.test", &["192.168.0.10"])]);
    let links = previews(true, Some(dns), None);
    for path in ["/to-ten", "/to-name", "/to-localhost", "/to-metadata", "/to-file"] {
        assert_eq!(links.preview(&server.url(path)).unwrap_err().code, "NOT_ALLOWED", "{path}");
    }
    // Only the first hop of each reached the server.
    assert_eq!(server.count(), 5);
}

#[test]
fn a_name_is_resolved_once_per_connection_and_used_as_resolved() {
    // DNS rebinding: the name resolves to an allowed address, then to a private one. The connection goes to the
    // address that was checked (the server sees it), and the name is not looked up again for that connection.
    let server = Server::start();
    let port = server.port;
    server.html("/page", &page("Pinned", ""));
    let dns = FakeDns::with(&[("rebind.test", &["127.0.0.1"]), ("rebind.test", &["10.0.0.1"])]);
    let links = previews(true, Some(dns.clone()), None);
    assert_eq!(links.preview(&format!("http://rebind.test:{port}/page")).unwrap()["title"], "Pinned");
    assert_eq!(dns.lookups.load(Ordering::SeqCst), 1);
    // The next connection resolves again and now gets the private address: refused, not connected.
    assert_eq!(links.preview(&format!("http://rebind.test:{port}/page?again")).unwrap_err().code, "NOT_ALLOWED");
    assert_eq!(server.count(), 1);

    // Each redirect hop is a new connection, resolved and checked again.
    let server = Server::start();
    let port = server.port;
    server.redirect("/hop", &format!("http://flip.test:{port}/page"));
    server.html("/page", &page("T", ""));
    let dns = FakeDns::with(&[("flip.test", &["127.0.0.1"]), ("flip.test", &["169.254.169.254"])]);
    let links = previews(true, Some(dns.clone()), None);
    assert_eq!(links.preview(&format!("http://flip.test:{port}/hop")).unwrap_err().code, "NOT_ALLOWED");
    assert_eq!(dns.lookups.load(Ordering::SeqCst), 2);
    assert_eq!(server.count(), 1);

    // Private first, then public: refused at the first lookup.
    let dns = FakeDns::with(&[("early.test", &["10.0.0.1"]), ("early.test", &["127.0.0.1"])]);
    assert_eq!(previews(true, Some(dns), None).preview(&format!("http://early.test:{port}/page")).unwrap_err().code, "NOT_ALLOWED");
    // A name with a private and an allowed address connects to the allowed one only.
    let dns = FakeDns::with(&[("mixed.test", &["10.0.0.1", "127.0.0.1"])]);
    assert!(previews(true, Some(dns), None).preview(&format!("http://mixed.test:{port}/page")).is_ok());
}

#[test]
fn follows_at_most_five_redirects() {
    let server = Server::start();
    server.html("/r0", &page("End", ""));
    for n in 1..=6 {
        server.redirect(&format!("/r{n}"), &format!("/r{}", n - 1));
    }
    let links = previews(true, None, None);
    let p = links.preview(&server.url("/r5")).unwrap();
    assert_eq!(p["title"], "End");
    assert_eq!(p["finalUrl"], server.url("/r0"));
    let e = links.preview(&server.url("/r6")).unwrap_err();
    assert_eq!(e.code, "PREVIEW_UNAVAILABLE");
    assert!(e.message.contains("too many redirects"), "{}", e.message);
}

#[test]
fn sends_no_cookies_credentials_or_referer() {
    let server = Server::start();
    server.redirect("/start", "/page");
    server.html("/page", &page("T", "/img.png"));
    image(&server, "/img.png", PNG, "image/png");
    previews(true, None, None).preview(&server.url("/start")).unwrap();
    let requests = server.requests();
    assert_eq!(requests.len(), 3, "{requests:?}");
    for request in &requests {
        let lower = request.to_ascii_lowercase();
        assert!(lower.contains(&format!("user-agent: {}\r\n", USER_AGENT.to_ascii_lowercase())), "{request}");
        for header in ["cookie:", "authorization:", "referer:", "proxy-authorization:", "origin:"] {
            assert!(!lower.contains(&format!("\r\n{header}")), "{header} in {request}");
        }
    }
    assert!(USER_AGENT.starts_with("Thoth/") && USER_AGENT.ends_with(" (link preview)"));
}

#[test]
fn reads_at_most_512_kb_and_stops_after_the_head() {
    let server = Server::start();
    // The title comes after 600 KB of head: it is never read.
    let padding = format!("<meta name=\"pad\" content=\"{}\">", "a".repeat(600 * 1024));
    server.html("/big", &format!("<head><meta property=\"og:description\" content=\"early\">{padding}<meta property=\"og:title\" content=\"late\"></head>"));
    let p = previews(true, None, None).preview(&server.url("/big")).unwrap();
    assert_eq!(p["description"], "early");
    assert!(p.get("title").is_none());

    // After `</head>` the host stops reading: a page that never ends still gives its preview at once.
    server.route("/endless", Answer::Hang(vec![("content-type", "text/html".into())], page("Quick", "").split("<body>").next().unwrap().as_bytes().to_vec()));
    let started = Instant::now();
    assert_eq!(previews(true, None, None).preview(&server.url("/endless")).unwrap()["title"], "Quick");
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
}

#[test]
fn gives_up_after_five_seconds() {
    let server = Server::start();
    server.route("/drip", Answer::Drip);
    server.route("/silent", Answer::Silent);
    let links = previews(true, None, None);
    for path in ["/drip", "/silent"] {
        let started = Instant::now();
        let e = links.preview(&server.url(path)).unwrap_err();
        let took = started.elapsed();
        assert_eq!(e.code, "PREVIEW_UNAVAILABLE", "{path}: {e:?}");
        assert!(took >= Duration::from_millis(4500) && took < Duration::from_millis(6500), "{path}: {took:?}");
    }
}

#[test]
fn refuses_what_is_not_html() {
    let server = Server::start();
    server.route("/json", Answer::Full(200, vec![("content-type", "application/json".into())], br#"{"og:title":"x"}"#.to_vec()));
    server.route("/svg", Answer::Full(200, vec![("content-type", "image/svg+xml".into())], b"<svg><title>x</title></svg>".to_vec()));
    server.route("/none", Answer::Full(200, vec![], b"<head><title>x</title></head>".to_vec()));
    server.route("/missing", Answer::Full(404, vec![("content-type", "text/html".into())], b"<head><title>Not found</title></head>".to_vec()));
    let links = previews(true, None, None);
    for path in ["/json", "/svg", "/none", "/missing"] {
        assert_eq!(links.preview(&server.url(path)).unwrap_err().code, "PREVIEW_UNAVAILABLE", "{path}");
    }
}

#[test]
fn keeps_only_small_raster_images() {
    let server = Server::start();
    let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"/>";
    image(&server, "/a.svg", svg, "image/png");
    let mut big = PNG.to_vec();
    big.resize(2 * 1024 * 1024 + 1, 0);
    image(&server, "/big.png", &big, "image/png");
    let mut exact = PNG.to_vec();
    exact.resize(2 * 1024 * 1024, 0);
    image(&server, "/exact.png", &exact, "image/png");
    image(&server, "/image", b"GIF89a\x01\0\x01\0\0\0\0;", "application/octet-stream");
    server.html("/svg", &page("T", "/a.svg"));
    server.html("/big", &page("T", "/big.png"));
    server.html("/exact", &page("T", "/exact.png"));
    server.html("/gif", &page("T", "/image"));
    server.html("/private", &page("T", "http://10.0.0.1/x.png"));
    server.html("/js", &page("T", "javascript:alert(1)"));
    let links = previews(true, None, None);
    for path in ["/svg", "/big", "/private", "/js"] {
        let p = links.preview(&server.url(path)).unwrap();
        assert_eq!(p["title"], "T", "{path}: the preview is still given");
        assert!(p.get("image").is_none(), "{path}");
    }
    assert!(links.preview(&server.url("/exact")).unwrap()["image"].as_str().unwrap().starts_with("data:image/png;base64,"));
    // By its bytes, not by what the server calls it.
    assert!(links.preview(&server.url("/gif")).unwrap()["image"].as_str().unwrap().starts_with("data:image/gif;base64,"));
}

#[test]
fn caches_previews_and_failures_in_the_app_data_folder() {
    let server = Server::start();
    server.html("/page", &page("Cached", ""));
    server.route("/down", Answer::Full(500, vec![("content-type", "text/html".into())], Vec::new()));
    let data = tempfile::tempdir().unwrap();
    let links = previews(true, None, Some(data.path().to_owned()));
    assert_eq!(links.preview(&server.url("/page")).unwrap()["title"], "Cached");
    assert_eq!(links.preview(&server.url("/page")).unwrap()["title"], "Cached");
    assert_eq!(links.preview(&server.url("/page#other-part")).unwrap()["title"], "Cached");
    assert_eq!(server.count(), 1, "the second and third came from the cache");
    assert_eq!(links.preview(&server.url("/down")).unwrap_err().code, "PREVIEW_UNAVAILABLE");
    assert_eq!(links.preview(&server.url("/down")).unwrap_err().code, "PREVIEW_UNAVAILABLE");
    assert_eq!(server.count(), 2, "a failure is remembered too");
    // A new host on the same folder (the app restarted) still has them.
    let again = previews(true, None, Some(data.path().to_owned()));
    assert_eq!(again.preview(&server.url("/page")).unwrap()["title"], "Cached");
    assert_eq!(server.count(), 2);
    assert!(data.path().join("link-previews").is_dir());
    again.clear().unwrap();
    assert_eq!(again.cache_usage().0, 0);
    assert_eq!(again.preview(&server.url("/page")).unwrap()["title"], "Cached");
    assert_eq!(server.count(), 3, "fetched again after clearing");
}

#[test]
fn the_cache_expires_and_stays_bounded() {
    let server = Server::start();
    for n in 0..4 {
        server.html(&format!("/p{n}"), &page(&format!("P{n}"), ""));
    }
    let now = Arc::new(Mutex::new(SystemTime::UNIX_EPOCH + Duration::from_secs(1_900_000_000)));
    let clock = now.clone();
    let data = tempfile::tempdir().unwrap();
    let links = LinkPreviews::new(
        Some(data.path().to_owned()),
        LinkOptions { allow_loopback: true, limits: CacheLimits { max_entries: 3, ..thoth_host::links::cache::LIMITS }, clock: Arc::new(move || *clock.lock().unwrap()), ..LinkOptions::default() },
    );
    let tick = |secs: u64| *now.lock().unwrap() += Duration::from_secs(secs);
    for n in 0..4 {
        links.preview(&server.url(&format!("/p{n}"))).unwrap();
        tick(1);
    }
    assert_eq!(links.cache_usage().0, 3, "the least recently used went");
    assert_eq!(server.count(), 4);
    links.preview(&server.url("/p0")).unwrap();
    assert_eq!(server.count(), 5, "p0 was the one evicted");
    links.preview(&server.url("/p3")).unwrap();
    assert_eq!(server.count(), 5);
    tick(7 * 24 * 3600);
    links.preview(&server.url("/p3")).unwrap();
    assert_eq!(server.count(), 6, "older than 7 days: fetched again");
}

// ------------------------------------------------------------------------------------------- through the host

struct NoPicker;
impl Picker for NoPicker {
    fn pick_vault(&self) -> Option<PathBuf> {
        None
    }
    fn pick_source(&self, _: bool) -> Option<PathBuf> {
        None
    }
}

#[derive(Default)]
struct Opened(Mutex<Vec<String>>);
impl Browser for Opened {
    fn open(&self, url: &str) -> HostResult<()> {
        self.0.lock().unwrap().push(url.to_owned());
        Ok(())
    }
}

struct NoFiles;
impl FileManager for NoFiles {
    fn reveal(&self, _: &std::path::Path, _: Option<&std::path::Path>) -> HostResult<()> {
        Ok(())
    }
}

fn host(data: &std::path::Path, loopback: bool, browser: Arc<Opened>) -> Host {
    Host::new(HostConfig {
        data_dir: Some(data.to_owned()),
        allow_roots: Vec::new(),
        picker: Arc::new(NoPicker),
        events: Arc::new(|_, _| {}),
        disable_hardlink: false,
        secrets: Arc::new(MemorySecretStore::default()),
        browser,
        file_manager: Arc::new(NoFiles),
        agent_search_dirs: None,
        link_preview_loopback: loopback,
    })
}

#[test]
fn the_host_commands() {
    let server = Server::start();
    server.html("/page", &page("Via host", ""));
    let data = tempfile::tempdir().unwrap();
    let browser = Arc::new(Opened::default());
    // As shipped: the switch is off, so the local server is refused.
    let shipped = host(data.path(), false, browser.clone());
    assert_eq!(shipped.call("link.preview", &json!({ "url": server.url("/page") }), None).unwrap_err().code, "NOT_ALLOWED");
    assert_eq!(server.count(), 0);
    assert_eq!(shipped.call("link.preview", &json!({}), None).unwrap_err().code, "BAD_ARGUMENT");
    assert_eq!(shipped.call("link.preview", &json!({ "url": server.url("/page") }), Some(b"x")).unwrap_err().code, "BAD_ARGUMENT");

    let other = tempfile::tempdir().unwrap();
    let test = host(other.path(), true, browser.clone());
    let (value, bytes) = test.call("link.preview", &json!({ "url": server.url("/page") }), None).unwrap();
    assert_eq!(value["title"], "Via host");
    assert!(bytes.is_none());
    assert_eq!(test.call("link.preview.clear", &json!({}), None).unwrap().0, Value::Null);

    // `link.open` hands web links to the system browser, and nothing else.
    test.call("link.open", &json!({ "url": "https://example.com/a?b=1" }), None).unwrap();
    for bad in ["javascript:alert(1)", "file:///etc/passwd", "mailto:a@b.example", "-a Calculator", "https://example.com/\nrm"] {
        assert_eq!(test.call("link.open", &json!({ "url": bad }), None).unwrap_err().code, "BAD_ARGUMENT", "{bad}");
    }
    assert_eq!(*browser.0.lock().unwrap(), ["https://example.com/a?b=1"]);
}

#[test]
fn the_shipped_desktop_shell_never_turns_the_switch_on() {
    let shell = include_str!("../../../apps/desktop/src-tauri/src/lib.rs");
    assert!(shell.contains("link_preview_loopback: false,"));
    assert!(!shell.contains("link_preview_loopback: true"));
    assert!(!shell.contains("link-preview-loopback"));
    // Only the test harness parses the flag.
    let harness = include_str!("../src/bin/thoth-host-stdio.rs");
    assert!(harness.contains("\"--link-preview-loopback\""));
}

// ------------------------------------------------------------------------------------------- the update notice

fn latest(version: &str) -> String {
    format!(r#"{{"version":"{version}","date":"2026-11-02","base":"https://download.thothnotes.com/v{version}/","files":[],"extra":{{"ignored":true}}}}"#)
}

fn serve_latest(server: &Server, body: &str) {
    server.route("/latest.json", Answer::Full(200, vec![("content-type", "application/json".into())], body.as_bytes().to_vec()));
}

/// A clock the test moves.
#[derive(Clone)]
struct Clock(Arc<Mutex<SystemTime>>);

impl Clock {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(SystemTime::UNIX_EPOCH + Duration::from_secs(1_900_000_000))))
    }
    fn tick(&self, secs: u64) {
        *self.0.lock().unwrap() += Duration::from_secs(secs);
    }
    fn back(&self, secs: u64) {
        *self.0.lock().unwrap() -= Duration::from_secs(secs);
    }
    fn at(&self) -> thoth_host::links::Clock {
        let now = self.0.clone();
        Arc::new(move || *now.lock().unwrap())
    }
}

/// An update notice for app version `current` that reads `url`, with the test switch on or off.
fn updates(current: &str, url: &str, loopback: bool, clock: &Clock, data: Option<&std::path::Path>) -> Updates {
    let mut options = UpdateOptions::new(current, url);
    options.allow_loopback = loopback;
    options.clock = clock.at();
    Updates::new(data.map(std::path::Path::to_owned), options)
}

fn state(check: &Value) -> &str {
    check["state"].as_str().unwrap()
}

#[test]
fn tells_of_a_newer_version_with_where_to_get_it() {
    let server = Server::start();
    serve_latest(&server, &latest("0.2.0"));
    let notice = updates("0.1.3", &server.url("/latest.json"), true, &Clock::new(), None);
    let answer = notice.check(false);
    assert_eq!(state(&answer), "available", "{answer}");
    let update = &answer["update"];
    assert_eq!(update["version"], "0.2.0");
    assert_eq!(update["date"], "2026-11-02");
    assert_eq!(update["downloadUrl"], thoth_host::updates::DEFAULT_DOWNLOADS_PAGE);
    assert_eq!(update["skipped"], false);
    assert!(update.get("notesUrl").is_none(), "{update}");
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn gives_the_release_notes_link_when_latest_json_has_one() {
    let server = Server::start();
    serve_latest(&server, r#"{"version":"0.2.0","notes":"https://thothnotes.com/changes#0.2.0"}"#);
    let answer = updates("0.1.3", &server.url("/latest.json"), true, &Clock::new(), None).check(false);
    assert_eq!(answer["update"]["notesUrl"], "https://thothnotes.com/changes#0.2.0");
}

#[test]
fn says_nothing_for_the_same_an_older_or_a_prerelease_version() {
    for (current, published) in [("0.1.3", "0.1.3"), ("0.1.3", "0.1.2"), ("0.1.3", "0.2.0-rc.1"), ("0.2.0", "0.2.0-rc.9")] {
        let server = Server::start();
        serve_latest(&server, &latest(published));
        let answer = updates(current, &server.url("/latest.json"), true, &Clock::new(), None).check(false);
        assert_eq!(state(&answer), "current", "{current} against {published}: {answer}");
        assert!(answer.get("update").is_none());
    }
    // A person on a pre-release is offered the release, and a newer pre-release.
    for published in ["0.2.0", "0.2.0-rc.2"] {
        let server = Server::start();
        serve_latest(&server, &latest(published));
        assert_eq!(state(&updates("0.2.0-rc.1", &server.url("/latest.json"), true, &Clock::new(), None).check(false)), "available", "{published}");
    }
}

#[test]
fn a_request_carries_nothing_but_a_fixed_user_agent() {
    let server = Server::start();
    serve_latest(&server, &latest("0.2.0"));
    updates("0.1.3", &server.url("/latest.json"), true, &Clock::new(), None).check(false);
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    let lower = requests[0].to_ascii_lowercase();
    assert!(lower.starts_with("get /latest.json http/1.1\r\n"), "{lower}");
    assert!(lower.contains("\r\nuser-agent: thoth/0.1.3 (update check)\r\n"), "{lower}");
    assert!(lower.contains("\r\naccept: application/json\r\n"), "{lower}");
    for header in ["cookie:", "authorization:", "referer:", "proxy-authorization:", "origin:"] {
        assert!(!lower.contains(&format!("\r\n{header}")), "{header} in {lower}");
    }
}

#[test]
fn asks_at_each_start_then_at_most_once_in_24_hours_while_open() {
    let server = Server::start();
    serve_latest(&server, &latest("0.2.0"));
    let (clock, data) = (Clock::new(), tempfile::tempdir().unwrap());
    let url = server.url("/latest.json");
    let notice = updates("0.1.3", &url, true, &clock, Some(data.path()));
    assert_eq!(state(&notice.check(false)), "available");
    // Another window of the same run, or the same window's next timer: no second request that day.
    assert_eq!(state(&notice.check(false)), "waiting");
    clock.tick(23 * 3600 + 59 * 60);
    assert_eq!(state(&notice.check(false)), "waiting");
    assert_eq!(server.count(), 1);
    clock.tick(2 * 60);
    assert_eq!(state(&notice.check(false)), "available", "24 hours later, still open: it asks again");
    assert_eq!(server.count(), 2);

    // The app is closed and started again an hour later: a new start always asks.
    clock.tick(3600);
    let restarted = updates("0.1.3", &url, true, &clock, Some(data.path()));
    assert_eq!(state(&restarted.check(false)), "available");
    assert_eq!(server.count(), 3);
    assert_eq!(state(&restarted.check(false)), "waiting");
    assert_eq!(server.count(), 3);
    // The time of the last request is still kept for Settings, without the address.
    let kept = std::fs::read_to_string(data.path().join("update.json")).unwrap();
    assert!(kept.contains("lastCheck"), "{kept}");
    assert!(!kept.contains(&server.port.to_string()), "the file keeps no address");
    assert!(!kept.contains("asked"), "the run's own wait is never written: {kept}");

    // "Check now" does not wait.
    assert_eq!(state(&restarted.check(true)), "available");
    assert_eq!(server.count(), 4);
    assert_eq!(state(&restarted.check(false)), "waiting", "a manual check counts as the day's check");
}

#[test]
fn a_clock_set_back_does_not_stop_the_checks_for_ever() {
    let server = Server::start();
    serve_latest(&server, &latest("0.2.0"));
    let (clock, data) = (Clock::new(), tempfile::tempdir().unwrap());
    let notice = updates("0.1.3", &server.url("/latest.json"), true, &clock, Some(data.path()));
    clock.tick(10 * 24 * 3600);
    assert_eq!(state(&notice.check(false)), "available");
    // While the app is open, the computer's clock goes ten days back, behind the time of that check.
    clock.back(10 * 24 * 3600);
    assert_eq!(state(&notice.check(false)), "available");
    assert_eq!(server.count(), 2);
}

#[test]
fn turned_off_means_no_request_at_all_even_for_check_now() {
    let server = Server::start();
    serve_latest(&server, &latest("0.2.0"));
    let (clock, data) = (Clock::new(), tempfile::tempdir().unwrap());
    let notice = updates("0.1.3", &server.url("/latest.json"), true, &clock, Some(data.path()));
    assert_eq!(notice.settings(&json!({}), ).unwrap()["notify"], true, "On by default");
    assert_eq!(notice.settings(&json!({ "notify": false })).unwrap()["notify"], false);
    assert_eq!(state(&notice.check(false)), "off");
    assert_eq!(state(&notice.check(true)), "off");
    assert_eq!(server.count(), 0);
    // The choice is kept; turning it on again lets the next check through.
    let restarted = updates("0.1.3", &server.url("/latest.json"), true, &clock, Some(data.path()));
    assert_eq!(restarted.settings(&json!({})).unwrap()["notify"], false);
    assert_eq!(state(&restarted.check(false)), "off");
    assert_eq!(restarted.settings(&json!({ "notify": true })).unwrap()["notify"], true);
    assert_eq!(state(&restarted.check(false)), "available");
    assert_eq!(server.count(), 1);
}

#[test]
fn a_skipped_version_is_remembered_until_a_newer_one_appears() {
    let server = Server::start();
    serve_latest(&server, &latest("0.2.0"));
    let (clock, data) = (Clock::new(), tempfile::tempdir().unwrap());
    let url = server.url("/latest.json");
    let notice = updates("0.1.3", &url, true, &clock, Some(data.path()));
    assert_eq!(notice.settings(&json!({ "skip": "0.2.0" })).unwrap()["skipped"], "0.2.0");
    assert_eq!(notice.check(false)["update"]["skipped"], true);

    clock.tick(25 * 3600);
    let restarted = updates("0.1.3", &url, true, &clock, Some(data.path()));
    assert_eq!(restarted.settings(&json!({})).unwrap()["skipped"], "0.2.0");
    assert_eq!(restarted.check(false)["update"]["skipped"], true, "remembered across a restart");

    clock.tick(25 * 3600);
    serve_latest(&server, &latest("0.2.1"));
    let newer = restarted.check(false);
    assert_eq!(newer["update"]["version"], "0.2.1");
    assert_eq!(newer["update"]["skipped"], false, "a newer version is offered again");

    // Skipping is for a version; anything else is refused, and null forgets it.
    for bad in [json!("v1"), json!(""), json!(2), json!("1.2")] {
        assert_eq!(restarted.settings(&json!({ "skip": bad })).unwrap_err().code, "BAD_ARGUMENT");
    }
    assert_eq!(restarted.settings(&json!({ "skip": null })).unwrap()["skipped"], Value::Null);
    assert_eq!(restarted.settings(&json!({ "notify": "yes" })).unwrap_err().code, "BAD_ARGUMENT");
}

#[test]
fn a_build_without_an_address_never_asks() {
    let notice = Updates::new(None, UpdateOptions::new("0.1.3", ""));
    assert_eq!(state(&notice.check(true)), "unavailable");
    let settings = notice.settings(&json!({})).unwrap();
    assert_eq!(settings["available"], false);
    assert_eq!(settings["current"], "0.1.3");
    // A host that was not given an update notice behaves the same way.
    assert_eq!(state(&Updates::new(None, UpdateOptions::off()).check(false)), "unavailable");
}

#[test]
fn only_https_to_a_public_address_is_asked() {
    let server = Server::start();
    serve_latest(&server, &latest("0.2.0"));
    let clock = Clock::new();
    // As shipped (the test switch off) the local server is refused, and so is every other address the rules refuse.
    assert_eq!(state(&updates("0.1.3", &server.url("/latest.json"), false, &clock, None).check(false)), "failed");
    assert_eq!(server.count(), 0);
    // `http` to a name is refused even when the name resolves to an address the switch lets through.
    let dns = FakeDns::with(&[("updates.test", &["127.0.0.1"]), ("inside.test", &["10.0.0.5"]), ("metadata.test", &["169.254.169.254"])]);
    for name in ["updates.test", "inside.test", "metadata.test"] {
        for scheme in ["http", "https"] {
            let mut options = UpdateOptions::new("0.1.3", format!("{scheme}://{name}:{}/latest.json", server.port));
            options.allow_loopback = scheme == "http";
            options.lookup = dns.clone();
            assert_eq!(state(&Updates::new(None, options).check(false)), "failed", "{scheme}://{name}");
        }
    }
    assert_eq!(server.count(), 0, "nothing reached the server");
    for bad in ["file:///etc/passwd", "ftp://updates.test/latest.json", "https://user:pw@updates.test/latest.json", "not a url"] {
        assert_eq!(state(&updates("0.1.3", bad, true, &clock, None).check(false)), "failed", "{bad}");
    }
}

#[test]
fn a_redirect_is_followed_only_to_another_checked_https_address() {
    let server = Server::start();
    serve_latest(&server, &latest("0.2.0"));
    server.redirect("/moved.json", "/latest.json");
    let clock = Clock::new();
    let ok = updates("0.1.3", &server.url("/moved.json"), true, &clock, None).check(false);
    assert_eq!(state(&ok), "available", "a redirect to the same checked address is followed");
    assert_eq!(server.count(), 2);

    // To a name: `http` is not allowed (the switch exempts a loopback IP address only).
    let dns = FakeDns::with(&[("elsewhere.test", &["127.0.0.1"])]);
    server.redirect("/away.json", &format!("http://elsewhere.test:{}/latest.json", server.port));
    let mut options = UpdateOptions::new("0.1.3", server.url("/away.json"));
    options.allow_loopback = true;
    options.lookup = dns;
    assert_eq!(state(&Updates::new(None, options).check(false)), "failed");
    assert_eq!(server.count(), 3, "only the first hop was made");
    // To a private address.
    server.redirect("/inside.json", "http://10.0.0.5/latest.json");
    assert_eq!(state(&updates("0.1.3", &server.url("/inside.json"), true, &clock, None).check(false)), "failed");
}

#[test]
fn only_a_small_json_answer_is_believed() {
    let clock = Clock::new();
    let server = Server::start();
    let url = server.url("/latest.json");
    let check = |server_answer: Answer| {
        server.route("/latest.json", server_answer);
        state(&updates("0.1.3", &url, true, &clock, None).check(false)).to_owned()
    };
    let json_type = || vec![("content-type", "application/json; charset=utf-8".to_owned())];
    let body = latest("0.2.0").into_bytes();
    assert_eq!(check(Answer::Full(200, json_type(), body.clone())), "available");
    // Not JSON by its type, an error status, a bad file, a file that is too large.
    assert_eq!(check(Answer::Full(200, vec![("content-type", "text/html".into())], body.clone())), "failed");
    assert_eq!(check(Answer::Full(200, vec![], body.clone())), "failed");
    assert_eq!(check(Answer::Full(404, json_type(), body.clone())), "failed");
    assert_eq!(check(Answer::Full(500, json_type(), body.clone())), "failed");
    assert_eq!(check(Answer::Full(200, json_type(), br#"{"version":"soon"}"#.to_vec())), "failed");
    assert_eq!(check(Answer::Full(200, json_type(), b"<html>0.9.0</html>".to_vec())), "failed");
    let mut big = format!(r#"{{"version":"0.2.0","padding":"{}"}}"#, "x".repeat(64 * 1024)).into_bytes();
    assert_eq!(check(Answer::Full(200, json_type(), big.clone())), "failed", "a file over 64 KB");
    // The same file without a length (a stream that goes on) is cut at the limit and then refused.
    big.truncate(70_000);
    assert_eq!(check(Answer::Hang(json_type(), big)), "failed");
}

#[test]
fn an_answer_that_never_comes_gives_up_after_5_seconds() {
    let server = Server::start();
    server.route("/latest.json", Answer::Silent);
    let start = Instant::now();
    let answer = updates("0.1.3", &server.url("/latest.json"), true, &Clock::new(), None).check(false);
    assert_eq!(state(&answer), "failed");
    let took = start.elapsed();
    assert!(took >= Duration::from_secs(4) && took < Duration::from_secs(8), "{took:?}");
}

#[test]
fn a_failed_check_uses_up_the_day_and_tells_nothing_about_the_server() {
    let server = Server::start();
    let clock = Clock::new();
    let notice = updates("0.1.3", &server.url("/latest.json"), true, &clock, None);
    let answer = notice.check(false);
    assert_eq!(state(&answer), "failed");
    assert_eq!(answer.as_object().unwrap().keys().collect::<Vec<_>>(), ["state", "checkedAt"]);
    assert_eq!(state(&notice.check(false)), "waiting");
    assert_eq!(server.count(), 1);
}

#[test]
fn the_update_commands_through_the_host() {
    let server = Server::start();
    serve_latest(&server, &latest("0.2.0"));
    let data = tempfile::tempdir().unwrap();
    let browser = Arc::new(Opened::default());
    // Without `with_updates` there is no notice.
    let plain = host(data.path(), true, browser.clone());
    assert_eq!(plain.call("update.check", &json!({}), None).unwrap().0["state"], "unavailable");
    assert_eq!(plain.call("update.settings", &json!({}), None).unwrap().0["available"], false);

    let noticed = host(data.path(), true, browser).with_updates(UpdateOptions::new("0.1.3", server.url("/latest.json")));
    assert_eq!(noticed.call("update.settings", &json!({}), None).unwrap().0["available"], true);
    let (answer, bytes) = noticed.call("update.check", &json!({ "force": true }), None).unwrap();
    assert!(bytes.is_none());
    assert_eq!(answer["update"]["version"], "0.2.0");
    assert_eq!(noticed.call("update.check", &json!({ "force": "yes" }), None).unwrap_err().code, "BAD_ARGUMENT");
    assert_eq!(noticed.call("update.check", &json!({}), Some(b"x")).unwrap_err().code, "BAD_ARGUMENT");
    assert_eq!(noticed.call("update.settings", &json!({ "notify": 1 }), None).unwrap_err().code, "BAD_ARGUMENT");
    // The host's own loopback switch is what lets the test server through: as shipped, it is refused.
    let shipped = host(tempfile::tempdir().unwrap().path(), false, Arc::new(Opened::default())).with_updates(UpdateOptions::new("0.1.3", server.url("/latest.json")));
    assert_eq!(shipped.call("update.check", &json!({}), None).unwrap().0["state"], "failed");
    assert_eq!(server.count(), 1);
}

#[test]
fn the_shipped_shell_has_no_way_to_change_where_the_notice_looks() {
    let shell = include_str!("../../../apps/desktop/src-tauri/src/lib.rs");
    assert!(!shell.contains("--update-url") && !shell.contains("--update-current") && !shell.contains("--update-now"));
    let harness = include_str!("../src/bin/thoth-host-stdio.rs");
    assert!(harness.contains("\"--update-url\""));
}
