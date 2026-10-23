//! The host's only HTTP client. Blocking (host calls already run off the UI thread), rustls with the
//! webpki roots, no redirects, no cookies, no proxy from the environment, a timeout on every request and a
//! cap on every body. Error messages name the server's origin and a fixed reason, never a URL with a query,
//! a header or a body, so no secret can reach a message.
use crate::error::{HostError, HostResult};
use std::time::Duration;
use ureq::Agent;
use ureq::http::{Method, Request};
use url::Url;

/// Largest request or response body `api.call` carries.
pub const MAX_BODY: usize = 32 * 1024 * 1024;
/// Largest body the host reads for its own requests (capabilities, token, me).
pub const MAX_SMALL_BODY: usize = 1024 * 1024;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const GLOBAL_TIMEOUT: Duration = Duration::from_secs(120);

pub struct HttpResponse {
    pub status: u16,
    /// Lower-cased names, in arrival order.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

pub struct Http {
    agent: Agent,
}

impl Default for Http {
    fn default() -> Self {
        Self::new()
    }
}

impl Http {
    pub fn new() -> Self {
        let config = Agent::config_builder()
            // Redirects are returned to the caller as they are, so a bearer token never follows one.
            .max_redirects(0)
            // 4xx and 5xx are answers, not failures.
            .http_status_as_error(false)
            // A proxy from HTTP(S)_PROXY would see loopback traffic and could be set by another program.
            .proxy(None)
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_response(Some(RESPONSE_TIMEOUT))
            .timeout_global(Some(GLOBAL_TIMEOUT))
            .user_agent(concat!("thoth-desktop/", env!("CARGO_PKG_VERSION")))
            .build();
        Self { agent: Agent::new_with_config(config) }
    }

    /// One request. `headers` are sent as given; `body` is sent for POST and PUT (empty when `None`).
    /// The response body is read up to `limit` bytes; a longer body is a `SERVER_UNREACHABLE` error.
    pub fn send(&self, method: &str, url: &Url, headers: &[(&str, &str)], body: Option<&[u8]>, limit: usize) -> HostResult<HttpResponse> {
        let origin = url.origin().ascii_serialization();
        let method = Method::from_bytes(method.as_bytes()).map_err(|_| HostError::bad_argument("Unsupported HTTP method"))?;
        let with_body = method == Method::POST || method == Method::PUT;
        let mut builder = Request::builder().method(method).uri(url.as_str());
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let result = if with_body {
            let request = builder.body(body.unwrap_or_default().to_vec()).map_err(|_| HostError::bad_argument("Invalid request header"))?;
            self.agent.run(request)
        } else {
            let request = builder.body(()).map_err(|_| HostError::bad_argument("Invalid request header"))?;
            self.agent.run(request)
        };
        let mut response = result.map_err(|e| unreachable(&origin, &e))?;
        let status = response.status().as_u16();
        let headers = response.headers().iter().filter_map(|(n, v)| v.to_str().ok().map(|v| (n.as_str().to_owned(), v.to_owned()))).collect();
        let body = response.body_mut().with_config().limit(limit as u64).read_to_vec().map_err(|e| match e {
            ureq::Error::BodyExceedsLimit(_) => HostError::new("SERVER_UNREACHABLE", format!("{origin} sent a response larger than {} MiB", limit / (1024 * 1024))),
            other => unreachable(&origin, &other),
        })?;
        Ok(HttpResponse { status, headers, body })
    }

    /// `application/x-www-form-urlencoded` POST (OAuth token and revocation requests).
    pub fn post_form(&self, url: &Url, form: &[(&str, &str)]) -> HostResult<HttpResponse> {
        let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(form).finish();
        self.send("POST", url, &[("content-type", "application/x-www-form-urlencoded"), ("accept", "application/json")], Some(body.as_bytes()), MAX_SMALL_BODY)
    }
}

/// A network failure as `SERVER_UNREACHABLE`, with a fixed reason.
fn unreachable(origin: &str, error: &ureq::Error) -> HostError {
    let reason = match error {
        ureq::Error::Timeout(_) => "the request timed out",
        ureq::Error::HostNotFound => "the host name was not found",
        ureq::Error::ConnectionFailed => "the connection failed",
        ureq::Error::Io(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => "the connection was refused",
        ureq::Error::Io(_) => "the connection broke",
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) | ureq::Error::TlsRequired => "the secure connection failed (check the certificate)",
        ureq::Error::LargeResponseHeader(..) => "the response headers are too large",
        _ => "the response was not valid HTTP",
    };
    HostError::new("SERVER_UNREACHABLE", format!("Could not reach {origin}: {reason}"))
}
