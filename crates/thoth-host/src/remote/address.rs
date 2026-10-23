//! Address rules for workspace servers: which server addresses may be added, which sign-in endpoints may be
//! used, and which `api.call` requests may leave the host. Everything here is pure, so it is unit tested
//! without a network.
use crate::error::{HostError, HostResult};
use serde_json::Value;
use std::net::{Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

/// Every `api.call` path starts with this.
pub const API_PREFIX: &str = "/api/v1/";
const MAX_URL: usize = 2048;
const MAX_QUERY_PAIRS: usize = 32;
const MAX_HEADER_VALUE: usize = 1024;

/// Request headers the webview may set. The host adds `Authorization` itself.
pub const REQUEST_HEADERS: [&str; 4] = ["if-match", "if-none-match", "idempotency-key", "content-type"];
/// Response headers the webview may see. `set-cookie`, `www-authenticate` and the rest stay in the host.
pub const RESPONSE_HEADERS: [&str; 4] = ["content-type", "etag", "location", "retry-after"];

/// 127.0.0.1, [::1] or localhost: the only hosts reachable over plain `http`.
fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain == "localhost",
        Some(Host::Ipv4(ip)) => ip == Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(ip)) => ip == Ipv6Addr::LOCALHOST,
        None => false,
    }
}

/// Normalizes a server address to its origin (`scheme://host[:port]`). It must be `https`, or `http` on
/// 127.0.0.1, [::1] or localhost, without a user name or password. A path, query or fragment is dropped.
pub fn server_origin(raw: &str) -> HostResult<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_URL {
        return Err(HostError::bad_argument("Enter the server address, e.g. https://thoth.example.org"));
    }
    let url = Url::parse(raw).map_err(|_| HostError::bad_argument("Enter the full server address, e.g. https://thoth.example.org"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(HostError::bad_argument("The server address must not contain a user name or password"));
    }
    match url.scheme() {
        "https" if url.host().is_some() => {}
        "http" if is_loopback(&url) => {}
        "http" => return Err(HostError::bad_argument("Plain http is allowed only for 127.0.0.1, [::1] or localhost; use https")),
        _ => return Err(HostError::bad_argument("The server address must start with https://")),
    }
    Ok(url.origin().ascii_serialization())
}

/// The host name shown when the server does not name itself.
pub fn host_label(origin: &str) -> String {
    Url::parse(origin).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_else(|| origin.to_owned())
}

/// `endpoint` parsed, when it is an absolute URL on exactly `origin` (scheme, host and port) with no
/// credentials or fragment. Sign-in endpoints on any other origin are refused, so a server cannot send the
/// user's codes and tokens somewhere else.
pub fn same_origin(endpoint: &str, origin: &str) -> Option<Url> {
    if endpoint.len() > MAX_URL {
        return None;
    }
    let url = Url::parse(endpoint).ok()?;
    let clean = url.username().is_empty() && url.password().is_none() && url.fragment().is_none();
    (clean && url.origin().ascii_serialization() == origin).then_some(url)
}

/// Checks an `api.call` path: `/api/v1/` plus non-empty segments of unreserved characters. Dot segments,
/// `//`, `?`, `#`, `\` and %-escapes that decode to `.`, `/`, `\`, `%`, `?`, `#` or a control character are
/// refused, so the request cannot climb out of the API or be reinterpreted by a proxy or the server.
pub fn api_path(path: &str) -> HostResult<&str> {
    let refuse = |why: &str| Err(HostError::bad_argument(format!("api.call path {why}")));
    if path.len() > MAX_URL {
        return refuse("is too long");
    }
    let Some(rest) = path.strip_prefix(API_PREFIX) else { return refuse("must start with /api/v1/") };
    for segment in rest.split('/') {
        if segment.is_empty() {
            return refuse("must not contain an empty segment (// or a trailing /)");
        }
        if segment == "." || segment == ".." {
            return refuse("must not contain . or .. segments");
        }
        let bytes = segment.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'%' => {
                    let decoded = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
                    match decoded {
                        None => return refuse("has a malformed %-escape"),
                        Some(b'.' | b'/' | b'\\' | b'%' | b'?' | b'#') => return refuse("must not hide . / \\ % ? or # in a %-escape"),
                        Some(b) if b < 0x20 || b == 0x7f => return refuse("must not contain control characters"),
                        Some(_) => i += 3,
                    }
                }
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => i += 1,
                _ => return refuse("may contain only letters, digits, - . _ ~ and %-escapes"),
            }
        }
    }
    Ok(path)
}

/// `query` as (key, value) pairs in order: an object of strings, at most 32 pairs.
pub fn query_pairs(query: Option<&Value>) -> HostResult<Vec<(String, String)>> {
    let map = match query {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Object(map)) => map,
        Some(_) => return Err(HostError::bad_argument("query must be an object of strings")),
    };
    if map.len() > MAX_QUERY_PAIRS {
        return Err(HostError::bad_argument("query has too many parameters"));
    }
    map.iter()
        .map(|(k, v)| match v {
            Value::String(s) if !k.is_empty() && k.len() <= 128 && s.len() <= MAX_URL => Ok((k.clone(), s.clone())),
            _ => Err(HostError::bad_argument("query must be an object of short strings")),
        })
        .collect()
}

/// The request URL: the server origin, the checked path and the query, form-encoded (`a b&c` → `a+b%26c`).
pub fn api_url(origin: &str, path: &str, query: &[(String, String)]) -> HostResult<Url> {
    let mut url = Url::parse(&format!("{origin}{path}")).map_err(|_| HostError::bad_argument("api.call path is not a valid URL path"))?;
    // The path was checked character by character; the parser must not have rewritten it.
    if url.path() != path || url.origin().ascii_serialization() != origin {
        return Err(HostError::bad_argument("api.call path is not a valid URL path"));
    }
    if query.is_empty() {
        url.set_query(None);
    } else {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in query {
            pairs.append_pair(k, v);
        }
    }
    Ok(url)
}

/// The allow-listed request headers, lower-cased. Any other header (including `authorization` and
/// `cookie`) is refused rather than dropped, so a caller notices.
pub fn request_headers(headers: Option<&Value>) -> HostResult<Vec<(&'static str, String)>> {
    let map = match headers {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Object(map)) => map,
        Some(_) => return Err(HostError::bad_argument("headers must be an object of strings")),
    };
    let mut out: Vec<(&'static str, String)> = Vec::new();
    for (name, value) in map {
        let lower = name.to_ascii_lowercase();
        let Some(allowed) = REQUEST_HEADERS.iter().copied().find(|h| *h == lower) else {
            return Err(HostError::bad_argument(format!("Header {:?} is not allowed; only {}", clip(name), REQUEST_HEADERS.join(", "))));
        };
        if out.iter().any(|(n, _)| *n == allowed) {
            return Err(HostError::bad_argument(format!("Header {allowed} is set twice")));
        }
        let Value::String(value) = value else { return Err(HostError::bad_argument(format!("Header {allowed} must be a string"))) };
        // Visible ASCII and spaces only: no CR/LF header injection.
        if value.is_empty() || value.len() > MAX_HEADER_VALUE || !value.bytes().all(|b| (0x20..0x7f).contains(&b)) {
            return Err(HostError::bad_argument(format!("Header {allowed} has an invalid value")));
        }
        out.push((allowed, value.clone()));
    }
    Ok(out)
}

fn clip(s: &str) -> String {
    s.chars().take(40).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn server_addresses_are_https_or_loopback_http_and_normalized_to_the_origin() {
        assert_eq!(server_origin("https://Thoth.Example.org/").unwrap(), "https://thoth.example.org");
        assert_eq!(server_origin(" https://thoth.example.org:443/api/v1/?x=1#y ").unwrap(), "https://thoth.example.org");
        assert_eq!(server_origin("https://thoth.example.org:8443").unwrap(), "https://thoth.example.org:8443");
        assert_eq!(server_origin("http://127.0.0.1:8080/x").unwrap(), "http://127.0.0.1:8080");
        assert_eq!(server_origin("http://[::1]:8080").unwrap(), "http://[::1]:8080");
        assert_eq!(server_origin("http://LOCALHOST:3000").unwrap(), "http://localhost:3000");
        for bad in [
            "http://example.org",
            "http://192.168.1.10:8080",
            "http://127.0.0.2",
            "http://localhost.example.org",
            "http://localhost.",
            "ftp://example.org",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:pw@example.org",
            "https://user@example.org",
            "example.org",
            "",
        ] {
            assert_eq!(server_origin(bad).unwrap_err().code, "BAD_ARGUMENT", "{bad}");
        }
    }

    #[test]
    fn sign_in_endpoints_must_share_the_server_origin() {
        let origin = "https://thoth.example.org";
        assert!(same_origin("https://thoth.example.org/auth/token", origin).is_some());
        assert!(same_origin("https://thoth.example.org:443/auth/token", origin).is_some());
        for bad in [
            "https://evil.example.org/auth/token",
            "https://thoth.example.org.evil.org/auth/token",
            "http://thoth.example.org/auth/token",
            "https://thoth.example.org:8443/auth/token",
            "https://user@thoth.example.org/auth/token",
            "https://thoth.example.org/auth/token#x",
            "/auth/token",
            "not a url",
        ] {
            assert!(same_origin(bad, origin).is_none(), "{bad}");
        }
    }

    #[test]
    fn api_paths_stay_inside_api_v1() {
        for ok in ["/api/v1/me", "/api/v1/workspaces/ws_1/pages/0b6c3c5e-1c51-4a8a-9b75-3c6b2a1d8f00", "/api/v1/a/b.c/d~e", "/api/v1/caf%C3%A9"] {
            assert_eq!(api_path(ok).unwrap(), ok);
        }
        for bad in [
            "/api/v1/",
            "/api/v1",
            "/api/v2/me",
            "/auth/token",
            "api/v1/me",
            "/api/v1/../auth/token",
            "/api/v1/./me",
            "/api/v1/me/..",
            "/api/v1//me",
            "/api/v1/me/",
            "/api/v1/me?x=1",
            "/api/v1/me#x",
            "/api/v1/%2e%2e/auth",
            "/api/v1/%2E%2E/auth",
            "/api/v1/a%2fb",
            "/api/v1/a%2Fb",
            "/api/v1/a%5cb",
            "/api/v1/a%25b",
            "/api/v1/a%3fb",
            "/api/v1/a%23b",
            "/api/v1/a%0ab",
            "/api/v1/a%zz",
            "/api/v1/a%2",
            "/api/v1/a\\b",
            "/api/v1/a b",
            "/api/v1/me\r\nX: y",
            "/api/v1/caf\u{e9}",
            "//evil.example.org/api/v1/me",
            "https://evil.example.org/api/v1/me",
        ] {
            assert_eq!(api_path(bad).unwrap_err().code, "BAD_ARGUMENT", "{bad:?}");
        }
    }

    #[test]
    fn query_values_are_form_encoded() {
        let query = query_pairs(Some(&json!({ "q": "a b&c=d/é?#", "limit": "10" }))).unwrap();
        let url = api_url("https://thoth.example.org", "/api/v1/workspaces", &query).unwrap();
        assert_eq!(url.as_str(), "https://thoth.example.org/api/v1/workspaces?q=a+b%26c%3Dd%2F%C3%A9%3F%23&limit=10");
        assert_eq!(api_url("http://127.0.0.1:9", "/api/v1/me", &[]).unwrap().as_str(), "http://127.0.0.1:9/api/v1/me");
        assert!(query_pairs(Some(&json!({ "a": 1 }))).is_err());
        assert!(query_pairs(Some(&json!(["a"]))).is_err());
    }

    #[test]
    fn only_allow_listed_request_headers_pass() {
        let headers = request_headers(Some(&json!({ "If-Match": "\"r1\"", "content-type": "application/json" }))).unwrap();
        assert_eq!(headers, vec![("if-match", "\"r1\"".to_owned()), ("content-type", "application/json".to_owned())]);
        for bad in [
            json!({ "authorization": "Bearer x" }),
            json!({ "cookie": "a=b" }),
            json!({ "host": "evil" }),
            json!({ "if-match": "a\r\nx-evil: 1" }),
            json!({ "if-match": "" }),
            json!({ "if-match": 1 }),
            json!({ "if-match": "a", "IF-MATCH": "b" }),
        ] {
            assert_eq!(request_headers(Some(&bad)).unwrap_err().code, "BAD_ARGUMENT", "{bad}");
        }
    }
}
