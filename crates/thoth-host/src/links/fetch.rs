//! The link-preview fetcher (ADR-0020 rule 4). Each connection goes to an address that was resolved and checked
//! first (`address::is_public`), and only to it: the ureq agent for a hop gets a resolver that returns exactly those
//! addresses, so the name is not looked up a second time between the check and the connection (no DNS rebinding).
//! Redirects are followed here, at most `MAX_REDIRECTS`, each target checked and resolved like the first. One
//! deadline covers the whole preview, page and image. No cookies, no credentials, no `Referer`, no proxy.
use super::address::{check_link, is_public, origin, refused};
use crate::error::{HostError, HostResult};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::{Duration, Instant};
use ureq::Agent;
use ureq::config::Config;
use ureq::http::{Request, Uri};
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};
use url::{Host, Url};

pub const MAX_REDIRECTS: usize = 5;
/// The whole preview (every hop, the page and its image) gets this long.
pub const TIMEOUT: Duration = Duration::from_secs(5);
/// Most of a page's HTML read; reading also stops after `</head>`.
pub const MAX_HTML: usize = 512 * 1024;
/// Largest image kept.
pub const MAX_IMAGE: usize = 2 * 1024 * 1024;
pub const USER_AGENT: &str = concat!("Thoth/", env!("CARGO_PKG_VERSION"), " (link preview)");

/// Looks up the addresses of a host name. The system resolver in the app; tests pass a fake one.
pub trait Lookup: Send + Sync {
    fn lookup(&self, host: &str, port: u16) -> std::io::Result<Vec<SocketAddr>>;
}

/// The operating system's resolver.
pub struct SystemLookup;

impl Lookup for SystemLookup {
    fn lookup(&self, host: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
        Ok((host, port).to_socket_addrs()?.collect())
    }
}

/// Returns the addresses checked for this hop, whatever the URI asks for.
#[derive(Debug)]
struct Pinned(Vec<SocketAddr>);

impl Resolver for Pinned {
    fn resolve(&self, _uri: &Uri, _config: &Config, _timeout: NextTimeout) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let mut out = self.empty();
        for addr in self.0.iter().take(16) {
            out.push(*addr);
        }
        if out.is_empty() { Err(ureq::Error::HostNotFound) } else { Ok(out) }
    }
}

pub struct Fetcher {
    pub lookup: Arc<dyn Lookup>,
    /// Test switch (ADR-0020): loopback addresses count as public, for a local test server.
    pub allow_loopback: bool,
}

/// A fetched body: the URL it finally came from, its `Content-Type` and its first bytes.
pub struct Fetched {
    pub url: Url,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

pub fn unavailable(url: &Url, reason: &str) -> HostError {
    HostError::new("PREVIEW_UNAVAILABLE", format!("No preview from {}: {reason}", origin(url)))
}

fn network(url: &Url, error: &ureq::Error) -> HostError {
    let reason = match error {
        ureq::Error::Timeout(_) => "it took too long",
        ureq::Error::HostNotFound => "the host name was not found",
        ureq::Error::ConnectionFailed => "the connection failed",
        ureq::Error::Io(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => "the connection was refused",
        ureq::Error::Io(e) if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock) => "it took too long",
        ureq::Error::Io(_) => "the connection broke",
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) | ureq::Error::TlsRequired => "the secure connection failed",
        _ => "the answer was not valid HTTP",
    };
    unavailable(url, reason)
}

/// What to read from a hop's answer.
pub struct Want<'a> {
    /// `Accept` header.
    pub accept: &'a str,
    /// `User-Agent` header (fixed for each kind of request).
    pub user_agent: &'a str,
    /// Only `https` is followed, redirects included (the update notice, ADR-0022). The test switch lets an `http` link
    /// to a loopback address through, for a local test server.
    pub https_only: bool,
    /// Most bytes read.
    pub max: usize,
    /// Stop reading after `</head>` (HTML).
    pub stop_at_head: bool,
    /// A longer body is refused instead of cut (images).
    pub refuse_longer: bool,
}

impl Fetcher {
    fn remaining(url: &Url, deadline: Instant) -> HostResult<Duration> {
        let left = deadline.saturating_duration_since(Instant::now());
        if left < Duration::from_millis(10) { Err(unavailable(url, "it took too long")) } else { Ok(left) }
    }

    /// The checked addresses for `url`'s host: an IP literal as it is, a name looked up (within the deadline). Only
    /// public addresses are kept; none left is `NOT_ALLOWED`.
    pub fn resolve(&self, url: &Url, deadline: Instant) -> HostResult<Vec<SocketAddr>> {
        let port = url.port_or_known_default().ok_or_else(|| unavailable(url, "no port"))?;
        let candidates: Vec<SocketAddr> = match url.host() {
            Some(Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
            Some(Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
            Some(Host::Domain(name)) => {
                let name = name.to_owned();
                let lookup = self.lookup.clone();
                let (send, receive) = std::sync::mpsc::channel();
                // The system resolver has no timeout of its own; a lookup that hangs is left behind.
                std::thread::spawn(move || {
                    let _ = send.send(lookup.lookup(&name, port));
                });
                match receive.recv_timeout(Self::remaining(url, deadline)?) {
                    Ok(Ok(addrs)) => addrs,
                    Ok(Err(_)) => return Err(unavailable(url, "the host name was not found")),
                    Err(_) => return Err(unavailable(url, "it took too long")),
                }
            }
            None => return Err(refused(url)),
        };
        if candidates.is_empty() {
            return Err(unavailable(url, "the host name was not found"));
        }
        let public: Vec<SocketAddr> =
            candidates.into_iter().filter(|a| is_public(a.ip(), self.allow_loopback)).map(|a| SocketAddr::new(a.ip(), port)).collect();
        if public.is_empty() {
            return Err(refused(url));
        }
        Ok(public)
    }

    /// GETs `url`, following up to `MAX_REDIRECTS` redirects, each checked like the first. A 2xx answer's body is read
    /// as `want` says; any other status is `PREVIEW_UNAVAILABLE`.
    pub fn get(&self, url: &Url, deadline: Instant, want: &Want<'_>) -> HostResult<Fetched> {
        let mut current = url.clone();
        for hop in 0..=MAX_REDIRECTS {
            check_link(&current)?;
            if want.https_only && current.scheme() != "https" && !(self.allow_loopback && matches!(current.host(), Some(Host::Ipv4(ip)) if ip.is_loopback())) {
                return Err(HostError::not_allowed(format!("{} is not an https address", origin(&current))));
            }
            let addrs = self.resolve(&current, deadline)?;
            let config = Agent::config_builder()
                .max_redirects(0)
                .http_status_as_error(false)
                .proxy(None)
                .timeout_global(Some(Self::remaining(&current, deadline)?))
                .user_agent(want.user_agent)
                .build();
            let agent = Agent::with_parts(config, DefaultConnector::new(), Pinned(addrs));
            let request = Request::builder()
                .method("GET")
                .uri(current.as_str())
                .header("accept", want.accept)
                .body(())
                .map_err(|_| unavailable(&current, "the link could not be requested"))?;
            let mut response = agent.run(request).map_err(|e| network(&current, &e))?;
            let status = response.status().as_u16();
            if (300..400).contains(&status) && status != 304 {
                let location =
                    response.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| unavailable(&current, "a redirect without a target"))?;
                let next = current.join(location).map_err(|_| unavailable(&current, "a redirect to an invalid address"))?;
                if hop == MAX_REDIRECTS {
                    return Err(unavailable(url, "too many redirects"));
                }
                current = next;
                current.set_fragment(None);
                continue;
            }
            if !(200..300).contains(&status) {
                return Err(unavailable(&current, &format!("the server answered {status}")));
            }
            let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).map(str::to_owned);
            if want.refuse_longer
                && response
                    .headers()
                    .get("content-length")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse::<u64>().ok())
                    .is_some_and(|n| n > want.max as u64)
            {
                return Err(unavailable(&current, "it is too large"));
            }
            let body = read_body(&current, response.body_mut().with_config().limit(u64::MAX).reader(), want)?;
            return Ok(Fetched { url: current, content_type, body });
        }
        Err(unavailable(url, "too many redirects"))
    }
}

/// Reads up to `want.max` bytes (one more for `refuse_longer`), stopping after `</head>` when asked.
fn read_body(url: &Url, mut reader: impl Read, want: &Want<'_>) -> HostResult<Vec<u8>> {
    let mut body = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let cap = if want.refuse_longer { want.max + 1 } else { want.max };
    while body.len() < cap {
        let room = (cap - body.len()).min(chunk.len());
        let n = match reader.read(&mut chunk[..room]) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                let timed_out = matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock)
                    || e.to_string().to_ascii_lowercase().contains("timeout")
                    || e.to_string().to_ascii_lowercase().contains("timed out");
                return Err(unavailable(url, if timed_out { "it took too long" } else { "the connection broke" }));
            }
        };
        let from = body.len().saturating_sub(7);
        body.extend_from_slice(&chunk[..n]);
        if want.stop_at_head && body[from..].windows(7).any(|w| w.eq_ignore_ascii_case(b"</head>")) {
            break;
        }
    }
    if want.refuse_longer && body.len() > want.max {
        return Err(unavailable(url, "it is too large"));
    }
    Ok(body)
}

/// The media type of a `Content-Type` value, lower case, without parameters.
pub fn mime(content_type: Option<&str>) -> Option<String> {
    content_type.map(|c| c.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
}

/// The `charset` parameter of a `Content-Type` value.
pub fn charset(content_type: Option<&str>) -> Option<String> {
    content_type?.split(';').skip(1).find_map(|p| {
        let (k, v) = p.split_once('=')?;
        k.trim().eq_ignore_ascii_case("charset").then(|| v.trim().trim_matches('"').to_owned())
    })
}

/// The image type of `bytes` by its magic numbers: PNG, JPEG, GIF or WebP. Anything else (SVG included) is `None`.
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_images_by_their_bytes_only() {
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(image_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(image_type(b"GIF89a.."), Some("image/gif"));
        assert_eq!(image_type(b"RIFF\x10\0\0\0WEBPVP8 "), Some("image/webp"));
        for bad in [&b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"[..], b"<?xml version=\"1.0\"?><svg/>", b"", b"RIFF\0\0\0\0WAVE", b"BM....", b"\x89PN"] {
            assert_eq!(image_type(bad), None, "{:?}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn reads_content_type_parts() {
        assert_eq!(mime(Some("Text/HTML; charset=UTF-8")).as_deref(), Some("text/html"));
        assert_eq!(charset(Some("text/html; Charset=\"iso-8859-1\"")).as_deref(), Some("iso-8859-1"));
        assert_eq!(charset(Some("text/html")), None);
        assert_eq!(USER_AGENT, format!("Thoth/{} (link preview)", env!("CARGO_PKG_VERSION")));
    }
}
