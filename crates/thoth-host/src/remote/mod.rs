//! Workspace servers (Phase 2b part 3): the server list, browser sign-in, the token store and the API proxy
//! behind the `server.*` and `api.call` commands.
//!
//! The host is the HTTP client, so the webview never holds a credential:
//!
//! - Refresh tokens and personal access tokens live only in the `SecretStore` (the OS keychain), keyed by the
//!   server's handle. Access tokens live only in memory. The persisted server list (`servers.json` in
//!   `data_dir`) holds addresses, labels, providers and endpoints, never a secret.
//! - Sign-in is RFC 8252: a loopback redirect on `127.0.0.1:0`, PKCE S256, a random `state` checked in
//!   constant time, and `iss` (RFC 9207) checked against the server's origin. The sign-in endpoints must be on
//!   the server's own origin.
//! - Refreshes are single flight per server (a mutex held across the token request): the server treats two
//!   uses of one refresh token as theft and revokes the session. A rotated refresh token is stored before
//!   the new access token is used.
//! - `api.call` only reaches `/api/v1/...` on the server's origin, with allow-listed headers, a capped body
//!   and no redirects. Server errors are results; only network failures are `SERVER_UNREACHABLE`.
//! - No token appears in a result, an event, an error message or a log line: messages are fixed text plus the
//!   server's origin.
pub mod address;
pub mod http;
pub mod loopback;

use crate::error::{HostError, HostResult};
use crate::{handles, lock, str_arg};
use address::{api_path, api_url, host_label, query_pairs, request_headers, same_origin, server_origin};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use http::{Http, HttpResponse, MAX_BODY, MAX_SMALL_BODY};
use loopback::{Loopback, SIGN_IN_TIMEOUT, sign_in_failed};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use url::Url;

/// The public OAuth client the desktop app signs in as (docs/protocol/sign-in.md section 2).
pub const CLIENT_ID: &str = "thoth-desktop";
/// Keychain service name of the desktop app's secrets (the bundle identifier).
pub const KEYCHAIN_SERVICE: &str = "com.thothnotes.desktop";
/// The service the secrets were kept under before the identifier changed (ADR-0031); `MovingSecretStore` reads it.
pub const LEGACY_KEYCHAIN_SERVICE: &str = crate::data_dir::LEGACY_IDENTIFIER;
/// The hosted trial (`packages/app-ui/src/workspace/starter.ts`) and where it was before ADR-0031.
const TRIAL_ORIGIN: &str = "https://api.thothnotes.com";
const LEGACY_TRIAL_ORIGIN: &str = "https://api.thoth.creaml4tt3.me";
const LIST_FILE: &str = "servers.json";
const MAX_SERVERS: usize = 64;
const MAX_PROVIDERS: usize = 16;
/// Longest server label kept (the reference server's `SERVER_NAME` limit).
const MAX_LABEL: usize = 64;
const MAX_TOKEN: usize = 4096;
/// Refresh this long before the access token expires (at most half its lifetime).
const REFRESH_MARGIN: Duration = Duration::from_secs(60);

/// Where refresh tokens and personal access tokens are kept, one secret per server handle.
/// The desktop shell uses the OS keychain; tests use `MemorySecretStore`.
pub trait SecretStore: Send + Sync {
    fn get(&self, server: &str) -> HostResult<Option<String>>;
    fn set(&self, server: &str, secret: &str) -> HostResult<()>;
    /// Deleting a missing secret succeeds.
    fn delete(&self, server: &str) -> HostResult<()>;
}

/// Opens the sign-in page. The desktop shell opens the system browser; the stdio harness emits an event.
/// `url` is always an `https` URL, or `http` on a loopback host.
pub trait Browser: Send + Sync {
    fn open(&self, url: &str) -> HostResult<()>;
}

/// In-memory secrets (the stdio harness and tests).
#[derive(Default)]
pub struct MemorySecretStore {
    secrets: Mutex<HashMap<String, String>>,
}

impl MemorySecretStore {
    /// Number of stored secrets (tests check that sign-out deletes them).
    pub fn len(&self) -> usize {
        lock(&self.secrets).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl SecretStore for MemorySecretStore {
    fn get(&self, server: &str) -> HostResult<Option<String>> {
        Ok(lock(&self.secrets).get(server).cloned())
    }
    fn set(&self, server: &str, secret: &str) -> HostResult<()> {
        lock(&self.secrets).insert(server.to_owned(), secret.to_owned());
        Ok(())
    }
    fn delete(&self, server: &str) -> HostResult<()> {
        lock(&self.secrets).remove(server);
        Ok(())
    }
}

/// Secrets under the current keychain service, with the ones an older build kept under its service moved over the
/// first time they are read (ADR-0031). A secret is removed from the old service only after the new one holds it.
pub struct MovingSecretStore {
    current: Arc<dyn SecretStore>,
    legacy: Arc<dyn SecretStore>,
}

impl MovingSecretStore {
    pub fn new(current: Arc<dyn SecretStore>, legacy: Arc<dyn SecretStore>) -> Self {
        Self { current, legacy }
    }
}

impl SecretStore for MovingSecretStore {
    fn get(&self, server: &str) -> HostResult<Option<String>> {
        if let Some(secret) = self.current.get(server)? {
            return Ok(Some(secret));
        }
        let Some(secret) = self.legacy.get(server)? else { return Ok(None) };
        if self.current.set(server, &secret).is_ok() {
            let _ = self.legacy.delete(server);
        }
        Ok(Some(secret))
    }

    fn set(&self, server: &str, secret: &str) -> HostResult<()> {
        self.current.set(server, secret)
    }

    fn delete(&self, server: &str) -> HostResult<()> {
        self.current.delete(server)?;
        self.legacy.delete(server)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
enum Auth {
    #[serde(rename = "signed-out")]
    SignedOut,
    #[serde(rename = "browser")]
    Browser,
    #[serde(rename = "token")]
    Token,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Account {
    id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Provider {
    id: String,
    name: String,
}

/// Where tokens are refreshed and revoked, recorded at sign-in (same origin as the server).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Endpoints {
    token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revocation: Option<String>,
}

/// One entry of `servers.json`. No secrets.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Record {
    id: String,
    url: String,
    label: String,
    auth: Auth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account: Option<Account>,
    #[serde(default)]
    providers: Vec<Provider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    limits: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    endpoints: Option<Endpoints>,
}

impl Record {
    /// `ServerInfo` in ipc.ts.
    fn info(&self) -> Value {
        let mut info = json!({ "id": self.id, "url": self.url, "label": self.label, "auth": self.auth, "providers": self.providers });
        if let Some(account) = &self.account {
            info["account"] = json!(account);
        }
        if let Some(limits) = &self.limits {
            info["limits"] = Value::Object(limits.clone());
        }
        info
    }

    fn endpoint(&self, pick: impl Fn(&Endpoints) -> Option<&String>) -> Option<Url> {
        self.endpoints.as_ref().and_then(pick).and_then(|e| same_origin(e, &self.url))
    }
}

/// An access token held in memory. Personal access tokens never expire here; the server decides.
struct Access {
    token: String,
    refresh_after: Option<Instant>,
}

impl Access {
    fn expiring(token: String, expires_in: u64) -> Self {
        let lifetime = Duration::from_secs(expires_in);
        let margin = REFRESH_MARGIN.min(lifetime / 2);
        Self { token, refresh_after: Some(Instant::now() + lifetime - margin) }
    }

    fn personal(token: String) -> Self {
        Self { token, refresh_after: None }
    }

    fn due(&self) -> bool {
        self.refresh_after.is_some_and(|at| Instant::now() >= at)
    }
}

/// Per-server credential state. The mutex is held across a refresh, which makes refreshes single flight.
#[derive(Default)]
struct Session {
    access: Mutex<Option<Access>>,
}

/// What `/api/v1/capabilities` told us.
struct Capabilities {
    label: Option<String>,
    providers: Vec<Provider>,
    limits: Option<Map<String, Value>>,
    /// Raw `signIn` endpoints (authorization, token, revocation), checked for the origin when used.
    sign_in: Option<(String, String, Option<String>)>,
}

/// A token endpoint's answer (RFC 6749 section 5.1).
struct Grant {
    access: String,
    refresh: Option<String>,
    expires_in: u64,
}

pub struct Remote {
    http: Http,
    secrets: Arc<dyn SecretStore>,
    browser: Arc<dyn Browser>,
    list_path: Option<PathBuf>,
    records: Mutex<Vec<Record>>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    sign_ins: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// Removes the in-progress mark when a sign-in ends, however it ends.
struct SignInGuard<'a> {
    remote: &'a Remote,
    id: String,
}

impl Drop for SignInGuard<'_> {
    fn drop(&mut self) {
        lock(&self.remote.sign_ins).remove(&self.id);
    }
}

impl Remote {
    pub fn new(data_dir: Option<PathBuf>, secrets: Arc<dyn SecretStore>, browser: Arc<dyn Browser>) -> Self {
        let list_path = data_dir.map(|d| d.join(LIST_FILE));
        let mut records = list_path.as_deref().map(load).unwrap_or_default();
        let moved = move_trial(&mut records);
        let remote = Self { http: Http::new(), secrets, browser, list_path, records: Mutex::new(records), sessions: Mutex::default(), sign_ins: Mutex::default() };
        if moved {
            remote.save(&lock(&remote.records));
        }
        remote
    }

    /// Cancels every sign-in in progress.
    pub fn shutdown(&self) {
        for cancel in lock(&self.sign_ins).values() {
            cancel.store(true, Ordering::SeqCst);
        }
    }

    // ------------------------------------------------------------- list

    pub fn list(&self) -> Value {
        Value::Array(lock(&self.records).iter().map(Record::info).collect())
    }

    /// Checks that `url` is a Thoth server speaking protocol 1.x and remembers it. Adding a known origin again
    /// refreshes its label, providers and limits and returns the existing entry.
    pub fn add(&self, url: &str) -> HostResult<Value> {
        let origin = server_origin(url)?;
        let caps = self.capabilities(&origin)?;
        let label = caps.label.unwrap_or_else(|| host_label(&origin));
        let mut records = lock(&self.records);
        if let Some(existing) = records.iter_mut().find(|r| r.url == origin) {
            existing.label = label;
            existing.providers = caps.providers;
            existing.limits = caps.limits;
            let info = existing.info();
            self.save(&records);
            return Ok(info);
        }
        if records.len() >= MAX_SERVERS {
            return Err(HostError::bad_argument("Too many servers; remove one first"));
        }
        let record = Record { id: handles::new_handle("server")?, url: origin, label, auth: Auth::SignedOut, account: None, providers: caps.providers, limits: caps.limits, endpoints: None };
        let info = record.info();
        records.push(record);
        self.save(&records);
        Ok(info)
    }

    /// Signs out (best effort), deletes the secret and forgets the server.
    pub fn remove(&self, id: &str) -> HostResult<()> {
        self.record(id)?;
        if let Some(cancel) = lock(&self.sign_ins).get(id) {
            cancel.store(true, Ordering::SeqCst);
        }
        let session = self.session(id);
        {
            let mut access = lock(&session.access);
            self.revoke_stored(id);
            *access = None;
            let _ = self.secrets.delete(id);
            let mut records = lock(&self.records);
            records.retain(|r| r.id != id);
            self.save(&records);
        }
        lock(&self.sessions).remove(id);
        Ok(())
    }

    // ---------------------------------------------------------- sign-in

    /// Browser sign-in: loopback redirect, PKCE S256, state and iss checks, code exchange, `GET /me`.
    pub fn sign_in(&self, id: &str, provider: Option<&str>) -> HostResult<Value> {
        let origin = self.record(id)?.url;
        let cancel = Arc::new(AtomicBool::new(false));
        let _guard = {
            let mut sign_ins = lock(&self.sign_ins);
            if sign_ins.contains_key(id) {
                return Err(sign_in_failed("A sign-in to this server is already in progress"));
            }
            sign_ins.insert(id.to_owned(), cancel.clone());
            SignInGuard { remote: self, id: id.to_owned() }
        };

        let caps = self.capabilities(&origin)?;
        let Some((authorization, token, revocation)) = caps.sign_in.as_ref() else {
            return Err(sign_in_failed("This server does not offer browser sign-in; use a personal access token"));
        };
        let off_origin = || sign_in_failed(format!("The server's sign-in addresses are not on {origin}, so Thoth will not use them"));
        let authorization = same_origin(authorization, &origin).ok_or_else(off_origin)?;
        let token_endpoint = same_origin(token, &origin).ok_or_else(off_origin)?;
        let revocation = match revocation {
            Some(r) => Some(same_origin(r, &origin).ok_or_else(off_origin)?),
            None => None,
        };
        if let Some(p) = provider
            && !caps.providers.iter().any(|x| x.id == p)
        {
            return Err(HostError::bad_argument("This server does not offer that sign-in provider"));
        }

        let loopback = Loopback::bind()?;
        let redirect_uri = loopback.redirect_uri();
        let verifier = random_b64(32)?;
        let state = random_b64(32)?;
        let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = authorization;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("response_type", "code").append_pair("client_id", CLIENT_ID).append_pair("redirect_uri", &redirect_uri);
            q.append_pair("code_challenge", &challenge).append_pair("code_challenge_method", "S256").append_pair("state", &state);
            if let Some(p) = provider {
                q.append_pair("provider", p);
            }
        }
        self.browser.open(url.as_str()).map_err(|_| sign_in_failed("Could not open the web browser for sign-in"))?;
        let callback = loopback.wait(&state, &origin, SIGN_IN_TIMEOUT, &cancel)?;

        let form = [("grant_type", "authorization_code"), ("code", callback.code.as_str()), ("redirect_uri", redirect_uri.as_str()), ("client_id", CLIENT_ID), ("code_verifier", verifier.as_str())];
        let response = self.http.post_form(&token_endpoint, &form)?;
        let Some(Grant { access, refresh: Some(refresh), expires_in }) = grant(&response) else {
            return Err(sign_in_failed("The server refused to complete the sign-in"));
        };
        let Some(account) = self.me(&origin, &access)? else {
            self.revoke(revocation.as_ref(), &refresh);
            return Err(sign_in_failed("The server did not accept the new sign-in"));
        };

        let session = self.session(id);
        let mut current = lock(&session.access);
        let Ok(record) = self.record(id) else {
            self.revoke(revocation.as_ref(), &refresh);
            return Err(sign_in_failed("The server was removed during sign-in"));
        };
        if cancel.load(Ordering::SeqCst) {
            self.revoke(revocation.as_ref(), &refresh);
            return Err(sign_in_failed("Sign-in was cancelled"));
        }
        let previous = if record.auth == Auth::Browser { self.secrets.get(id).ok().flatten().map(|t| (record.endpoint(|e| e.revocation.as_ref()), t)) } else { None };
        if self.secrets.set(id, &refresh).is_err() {
            self.revoke(revocation.as_ref(), &refresh);
            return Err(HostError::internal("Could not save the sign-in to the system keychain"));
        }
        *current = Some(Access::expiring(access, expires_in));
        let endpoints = Endpoints { token: token_endpoint.to_string(), revocation: revocation.map(|r| r.to_string()) };
        let info = self.update(id, |r| {
            r.auth = Auth::Browser;
            r.account = Some(account);
            r.endpoints = Some(endpoints);
            r.providers = caps.providers;
            r.limits = caps.limits;
        })?;
        if let Some((endpoint, old)) = previous
            && old != refresh
        {
            self.revoke(endpoint.as_ref(), &old);
        }
        Ok(info)
    }

    /// Ends a sign-in in progress for `id`, if any. Idempotent.
    pub fn cancel_sign_in(&self, id: &str) -> HostResult<()> {
        self.record(id)?;
        if let Some(cancel) = lock(&self.sign_ins).get(id) {
            cancel.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    /// Stores a personal access token after the server accepted it at `GET /api/v1/me`.
    pub fn use_token(&self, id: &str, token: &str) -> HostResult<Value> {
        let token = token.trim();
        if !token_shape(token) {
            return Err(HostError::bad_argument("That is not a valid personal access token"));
        }
        let origin = self.record(id)?.url;
        let account = self.me(&origin, token)?.ok_or_else(|| sign_in_failed("The server did not accept this token"))?;
        let session = self.session(id);
        let mut current = lock(&session.access);
        let record = self.record(id)?;
        let previous = if record.auth == Auth::Browser { self.secrets.get(id).ok().flatten() } else { None };
        self.secrets.set(id, token).map_err(|_| HostError::internal("Could not save the token to the system keychain"))?;
        *current = Some(Access::personal(token.to_owned()));
        let info = self.update(id, |r| {
            r.auth = Auth::Token;
            r.account = Some(account);
        })?;
        if let Some(old) = previous {
            self.revoke(record.endpoint(|e| e.revocation.as_ref()).as_ref(), &old);
        }
        Ok(info)
    }

    /// Revokes the session on the server (best effort) and deletes the secret. The server stays listed.
    pub fn sign_out(&self, id: &str) -> HostResult<Value> {
        self.record(id)?;
        let session = self.session(id);
        let mut access = lock(&session.access);
        self.revoke_stored(id);
        self.signed_out(id, &mut access)
    }

    // ---------------------------------------------------------- api.call

    /// One `/api/v1` request with the server's credential. `ApiCallArgs` / `ApiCallResult` in ipc.ts.
    pub fn api_call(&self, args: &Value, bytes: Option<&[u8]>) -> HostResult<Value> {
        let id = str_arg(args, "server")?;
        let method = match str_arg(args, "method")? {
            m @ ("GET" | "POST" | "PUT" | "DELETE") => m,
            _ => return Err(HostError::bad_argument("method must be GET, POST, PUT or DELETE")),
        };
        let path = api_path(str_arg(args, "path")?)?;
        let query = query_pairs(args.get("query"))?;
        let headers = request_headers(args.get("headers"))?;
        if bytes.is_some() && matches!(method, "GET" | "DELETE") {
            return Err(HostError::bad_argument(format!("{method} requests take no body")));
        }
        if bytes.is_some_and(|b| b.len() > MAX_BODY) {
            return Err(HostError::bad_argument("Request body is larger than 32 MiB"));
        }
        let origin = self.record(id)?.url;
        let url = api_url(&origin, path, &query)?;
        let session = self.session(id);

        let used = self.credential(id, &session)?;
        let mut response = self.send(method, &url, &headers, bytes, used.as_deref())?;
        if response.status == 401
            && let Some(used) = used
            && let Some(next) = self.after_unauthorized(id, &session, &used)?
        {
            response = self.send(method, &url, &headers, bytes, Some(&next))?;
        }

        let mut kept: Map<String, Value> = Map::new();
        for (name, value) in &response.headers {
            if address::RESPONSE_HEADERS.contains(&name.as_str()) {
                let joined = match kept.get(name).and_then(Value::as_str) {
                    Some(prev) => format!("{prev}, {value}"),
                    None => value.clone(),
                };
                kept.insert(name.clone(), Value::String(joined));
            }
        }
        // `responseBytes` (an attachment's bytes, ADR-0028): a successful body is sent as base64, never as lossy text.
        if args.get("responseBytes").and_then(Value::as_bool) == Some(true) && (200..300).contains(&response.status) {
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&response.body);
            return Ok(json!({ "status": response.status, "headers": kept, "body": "", "bodyBase64": encoded }));
        }
        Ok(json!({ "status": response.status, "headers": kept, "body": String::from_utf8_lossy(&response.body) }))
    }

    fn send(&self, method: &str, url: &Url, headers: &[(&'static str, String)], body: Option<&[u8]>, token: Option<&str>) -> HostResult<HttpResponse> {
        let bearer = token.map(|t| format!("Bearer {t}"));
        let mut all: Vec<(&str, &str)> = headers.iter().map(|(n, v)| (*n, v.as_str())).collect();
        if let Some(bearer) = &bearer {
            all.push(("authorization", bearer));
        }
        self.http.send(method, url, &all, body, MAX_BODY)
    }

    /// The credential for the next request: the cached access token, a refreshed one when it is due, the
    /// personal access token, or none when signed out.
    fn credential(&self, id: &str, session: &Session) -> HostResult<Option<String>> {
        let mut access = lock(&session.access);
        let record = self.record(id)?;
        match record.auth {
            Auth::SignedOut => Ok(None),
            Auth::Token => {
                if let Some(a) = access.as_ref() {
                    return Ok(Some(a.token.clone()));
                }
                match self.secrets.get(id)? {
                    Some(token) => {
                        *access = Some(Access::personal(token.clone()));
                        Ok(Some(token))
                    }
                    None => {
                        self.signed_out(id, &mut access)?;
                        Ok(None)
                    }
                }
            }
            Auth::Browser => match access.as_ref() {
                Some(a) if !a.due() => Ok(Some(a.token.clone())),
                _ => self.refresh(id, &record, &mut access),
            },
        }
    }

    /// After a 401 with `used`: another request may already have refreshed (use that token); otherwise refresh
    /// once. A refused refresh, or a personal access token the server rejects, signs the server out.
    fn after_unauthorized(&self, id: &str, session: &Session, used: &str) -> HostResult<Option<String>> {
        let mut access = lock(&session.access);
        if let Some(current) = access.as_ref()
            && current.token != used
        {
            return Ok(Some(current.token.clone()));
        }
        let record = self.record(id)?;
        match record.auth {
            Auth::Browser => self.refresh(id, &record, &mut access),
            Auth::Token => {
                self.signed_out(id, &mut access)?;
                Ok(None)
            }
            Auth::SignedOut => Ok(None),
        }
    }

    /// Exchanges the stored refresh token for a new pair. The caller holds the session lock, so this is the
    /// only refresh in flight for the server. `Ok(None)`: the server refused, and the server is now signed
    /// out with its secret deleted. A network failure or a 5xx keeps the secret and is `SERVER_UNREACHABLE`.
    fn refresh(&self, id: &str, record: &Record, access: &mut Option<Access>) -> HostResult<Option<String>> {
        *access = None;
        let endpoint = record.endpoint(|e| Some(&e.token));
        let (Some(endpoint), Some(refresh)) = (endpoint, self.secrets.get(id)?) else {
            self.signed_out(id, access)?;
            return Ok(None);
        };
        let response = self.http.post_form(&endpoint, &[("grant_type", "refresh_token"), ("refresh_token", refresh.as_str()), ("client_id", CLIENT_ID)])?;
        if response.status >= 500 || response.status == 429 {
            return Err(HostError::new("SERVER_UNREACHABLE", format!("{} could not renew the sign-in right now; try again later", record.url)));
        }
        let Some(Grant { access: token, refresh: Some(next), expires_in }) = grant(&response) else {
            self.signed_out(id, access)?;
            return Ok(None);
        };
        // The old refresh token is spent: store the new one before the new access token is used.
        if self.secrets.set(id, &next).is_err() {
            self.signed_out(id, access)?;
            return Err(HostError::internal("Could not save the renewed sign-in to the system keychain"));
        }
        *access = Some(Access::expiring(token.clone(), expires_in));
        Ok(Some(token))
    }

    /// Forgets the credential: memory, secret store, and `auth` in the list. The caller holds the session lock.
    fn signed_out(&self, id: &str, access: &mut Option<Access>) -> HostResult<Value> {
        *access = None;
        let _ = self.secrets.delete(id);
        self.update(id, |r| {
            r.auth = Auth::SignedOut;
            r.account = None;
        })
    }

    /// Revokes the stored refresh token of a browser sign-in (best effort). The caller holds the session lock.
    fn revoke_stored(&self, id: &str) {
        let Ok(record) = self.record(id) else { return };
        if record.auth == Auth::Browser
            && let Ok(Some(refresh)) = self.secrets.get(id)
        {
            self.revoke(record.endpoint(|e| e.revocation.as_ref()).as_ref(), &refresh);
        }
    }

    /// RFC 7009 revocation, best effort: the outcome is ignored.
    fn revoke(&self, endpoint: Option<&Url>, token: &str) {
        if let Some(endpoint) = endpoint {
            let _ = self.http.post_form(endpoint, &[("token", token), ("token_type_hint", "refresh_token"), ("client_id", CLIENT_ID)]);
        }
    }

    // ---------------------------------------------------------- helpers

    fn record(&self, id: &str) -> HostResult<Record> {
        lock(&self.records).iter().find(|r| r.id == id).cloned().ok_or_else(|| HostError::bad_handle("server"))
    }

    fn session(&self, id: &str) -> Arc<Session> {
        lock(&self.sessions).entry(id.to_owned()).or_default().clone()
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut Record)) -> HostResult<Value> {
        let mut records = lock(&self.records);
        let record = records.iter_mut().find(|r| r.id == id).ok_or_else(|| HostError::bad_handle("server"))?;
        change(record);
        let info = record.info();
        self.save(&records);
        Ok(info)
    }

    /// Atomically replaces `servers.json`. No secrets are in it.
    fn save(&self, records: &[Record]) {
        let Some(path) = &self.list_path else { return };
        let Some(dir) = path.parent() else { return };
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        let tmp = dir.join(format!("{LIST_FILE}.tmp"));
        let body = json!({ "version": 1, "servers": records }).to_string();
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }

    /// `GET /api/v1/capabilities`: must be JSON with `protocolVersion` 1.x.
    fn capabilities(&self, origin: &str) -> HostResult<Capabilities> {
        let url = Url::parse(&format!("{origin}/api/v1/capabilities")).map_err(|_| HostError::bad_argument("Invalid server address"))?;
        let response = self.http.send("GET", &url, &[("accept", "application/json")], None, MAX_SMALL_BODY)?;
        let not_thoth = || HostError::new("SERVER_UNREACHABLE", format!("{origin} is not a Thoth server"));
        if response.status != 200 {
            return Err(not_thoth());
        }
        let caps = response.json().filter(Value::is_object).ok_or_else(not_thoth)?;
        let version = caps.get("protocolVersion").and_then(Value::as_str).ok_or_else(not_thoth)?;
        if version.split('.').next() != Some("1") {
            return Err(HostError::new("SERVER_UNREACHABLE", format!("{origin} speaks a protocol version this app does not support")));
        }
        let label = caps.pointer("/server/name").and_then(Value::as_str).map(clean_label).filter(|s| !s.is_empty());
        let limits = caps.get("limits").and_then(Value::as_object).map(|m| m.iter().filter(|(k, v)| v.is_number() && k.len() <= 64).take(32).map(|(k, v)| (k.clone(), v.clone())).collect::<Map<_, _>>()).filter(|m| !m.is_empty());
        let sign_in = caps.get("signIn").and_then(Value::as_object);
        let providers = sign_in
            .and_then(|s| s.get("providers"))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|p| Some(Provider { id: p.get("id")?.as_str().filter(|id| !id.is_empty() && id.len() <= 64)?.to_owned(), name: clean_text(p.get("name")?.as_str()?) }))
                    .take(MAX_PROVIDERS)
                    .collect()
            })
            .unwrap_or_default();
        let endpoint = |key: &str| sign_in.and_then(|s| s.get(key)).and_then(Value::as_str).map(str::to_owned);
        let sign_in = match (endpoint("authorizationEndpoint"), endpoint("tokenEndpoint")) {
            (Some(a), Some(t)) => Some((a, t, endpoint("revocationEndpoint"))),
            _ => None,
        };
        Ok(Capabilities { label, providers, limits, sign_in })
    }

    /// `GET /api/v1/me` with `token`. `None` when the server does not accept it.
    fn me(&self, origin: &str, token: &str) -> HostResult<Option<Account>> {
        let url = Url::parse(&format!("{origin}/api/v1/me")).map_err(|_| HostError::bad_argument("Invalid server address"))?;
        let bearer = format!("Bearer {token}");
        let response = self.http.send("GET", &url, &[("accept", "application/json"), ("authorization", &bearer)], None, MAX_SMALL_BODY)?;
        if response.status != 200 {
            return Ok(None);
        }
        let Some(me) = response.json() else { return Ok(None) };
        let text = |key: &str| me.get(key).and_then(Value::as_str).map(clean_text).filter(|s| !s.is_empty());
        Ok(match (text("id"), text("displayName")) {
            (Some(id), Some(display_name)) => Some(Account { id, display_name, email: text("email") }),
            _ => None,
        })
    }
}

/// A successful token response. `None` for an error, a non-Bearer type or a malformed token.
fn grant(response: &HttpResponse) -> Option<Grant> {
    if response.status != 200 {
        return None;
    }
    let body = response.json()?;
    if !body.get("token_type")?.as_str()?.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let access = body.get("access_token")?.as_str().filter(|t| token_shape(t))?.to_owned();
    let refresh = match body.get("refresh_token") {
        None | Some(Value::Null) => None,
        Some(Value::String(t)) if token_shape(t) => Some(t.clone()),
        Some(_) => return None,
    };
    let expires_in = body.get("expires_in").and_then(Value::as_u64).unwrap_or(900).clamp(1, 24 * 3600);
    Some(Grant { access, refresh, expires_in })
}

/// A bearer token as RFC 6750 `b64token`: 16 to 4096 of `A-Za-z0-9-._~+/=`. Safe in a header.
fn token_shape(token: &str) -> bool {
    (16..=MAX_TOKEN).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(&b))
}

/// A server-supplied display string: no control characters, at most 200 characters.
fn clean_text(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(200).collect::<String>().trim().to_owned()
}

/// A server's display name: `clean_text`, kept to the 64 characters a reference server allows (`SERVER_NAME`).
fn clean_label(s: &str) -> String {
    clean_text(s).chars().take(MAX_LABEL).collect::<String>().trim_end().to_owned()
}

fn random_b64(bytes: usize) -> HostResult<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|_| HostError::internal("No randomness available for sign-in"))?;
    Ok(B64URL.encode(buf))
}

/// Reads `servers.json`, keeping only well-formed entries.
/// The hosted trial saved at its address before ADR-0031 moves to its address now: both hostnames serve the same
/// server, and after the move the server signs in and names itself (`iss`, endpoints) on the new one only. The handle
/// stays, so the keychain entry keyed by it and the session with it stay too. Left alone when the new address is
/// saved as well. True when something moved.
fn move_trial(records: &mut [Record]) -> bool {
    if records.iter().any(|r| r.url == TRIAL_ORIGIN) {
        return false;
    }
    let Some(record) = records.iter_mut().find(|r| r.url == LEGACY_TRIAL_ORIGIN) else { return false };
    let moved = |endpoint: &str| match endpoint.strip_prefix(LEGACY_TRIAL_ORIGIN) {
        Some(path) if path.starts_with('/') => format!("{TRIAL_ORIGIN}{path}"),
        _ => endpoint.to_owned(),
    };
    record.url = TRIAL_ORIGIN.to_owned();
    if record.label == host_label(LEGACY_TRIAL_ORIGIN) {
        record.label = host_label(TRIAL_ORIGIN);
    }
    if let Some(endpoints) = &mut record.endpoints {
        endpoints.token = moved(&endpoints.token);
        endpoints.revocation = endpoints.revocation.as_deref().map(moved);
    }
    true
}

fn load(path: &std::path::Path) -> Vec<Record> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
    let Some(list) = value.get("servers").and_then(Value::as_array) else { return Vec::new() };
    list.iter()
        .filter_map(|v| serde_json::from_value::<Record>(v.clone()).ok())
        .filter(|r| r.id.starts_with("server_") && server_origin(&r.url).is_ok_and(|o| o == r.url))
        .take(MAX_SERVERS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_need_a_bearer_type_and_well_formed_tokens() {
        let ok = |body: Value| HttpResponse { status: 200, headers: vec![], body: body.to_string().into_bytes() };
        let g = grant(&ok(json!({ "access_token": "thoth_at_0123456789abcdef", "token_type": "Bearer", "expires_in": 900, "refresh_token": "thoth_rt_0123456789abcdef" }))).unwrap();
        assert_eq!((g.expires_in, g.refresh.is_some()), (900, true));
        assert!(grant(&ok(json!({ "access_token": "thoth_at_0123456789abcdef", "token_type": "mac" }))).is_none());
        assert!(grant(&ok(json!({ "access_token": "short", "token_type": "Bearer" }))).is_none());
        assert!(grant(&ok(json!({ "access_token": "thoth_at_0123456789abcdef\r\nx: y", "token_type": "Bearer" }))).is_none());
        assert!(grant(&HttpResponse { status: 400, headers: vec![], body: b"{}".to_vec() }).is_none());
    }

    #[test]
    fn access_tokens_are_refreshed_before_they_expire() {
        assert!(!Access::expiring("t".into(), 900).due());
        assert!(Access::expiring("t".into(), 1).refresh_after.unwrap() <= Instant::now() + Duration::from_millis(500));
        assert!(!Access::personal("t".into()).due());
    }

    #[test]
    fn the_server_list_holds_no_secrets_and_drops_malformed_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LIST_FILE);
        std::fs::write(&path, json!({ "version": 1, "servers": [
            { "id": "server_1", "url": "https://a.example.org", "label": "A", "auth": "browser", "providers": [] },
            { "id": "server_2", "url": "http://evil.example.org", "label": "B", "auth": "token", "providers": [] },
            { "id": "vault_3", "url": "https://c.example.org", "label": "C", "auth": "token", "providers": [] },
            { "id": "server_4", "url": "https://d.example.org/path", "label": "D", "auth": "token", "providers": [] }
        ] }).to_string()).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].info(), json!({ "id": "server_1", "url": "https://a.example.org", "label": "A", "auth": "browser", "providers": [] }));
    }

    #[test]
    fn a_secret_kept_under_the_old_keychain_service_is_read_once_and_moved() {
        let (new, old) = (Arc::new(MemorySecretStore::default()), Arc::new(MemorySecretStore::default()));
        old.set("server_a", "thoth_rt_old").unwrap();
        let store = MovingSecretStore::new(new.clone(), old.clone());
        assert_eq!(store.get("server_a").unwrap().as_deref(), Some("thoth_rt_old"));
        // Moved: the new service has it, the old one no longer does.
        assert_eq!(new.get("server_a").unwrap().as_deref(), Some("thoth_rt_old"));
        assert!(old.is_empty());
        assert_eq!(store.get("server_b").unwrap(), None);
    }

    #[test]
    fn the_new_keychain_service_wins_and_deleting_clears_both() {
        let (new, old) = (Arc::new(MemorySecretStore::default()), Arc::new(MemorySecretStore::default()));
        new.set("server_a", "thoth_rt_new").unwrap();
        old.set("server_a", "thoth_rt_stale").unwrap();
        let store = MovingSecretStore::new(new.clone(), old.clone());
        assert_eq!(store.get("server_a").unwrap().as_deref(), Some("thoth_rt_new"));
        store.set("server_b", "thoth_pat_x").unwrap();
        assert_eq!((new.len(), old.len()), (2, 1));
        // Sign-out or remove: nothing is left under either service.
        store.delete("server_a").unwrap();
        assert_eq!(store.get("server_a").unwrap(), None);
        assert!(old.is_empty());
    }

    /// The new service refuses writes: the old secret stays where it is (read again next time), never lost.
    struct ReadOnly(MemorySecretStore);
    impl SecretStore for ReadOnly {
        fn get(&self, server: &str) -> HostResult<Option<String>> {
            self.0.get(server)
        }
        fn set(&self, _: &str, _: &str) -> HostResult<()> {
            Err(HostError::internal("Could not write to the system keychain"))
        }
        fn delete(&self, server: &str) -> HostResult<()> {
            self.0.delete(server)
        }
    }

    #[test]
    fn a_secret_that_cannot_be_moved_stays_under_the_old_service() {
        let old = Arc::new(MemorySecretStore::default());
        old.set("server_a", "thoth_rt_old").unwrap();
        let store = MovingSecretStore::new(Arc::new(ReadOnly(MemorySecretStore::default())), old.clone());
        assert_eq!(store.get("server_a").unwrap().as_deref(), Some("thoth_rt_old"));
        assert_eq!(old.get("server_a").unwrap().as_deref(), Some("thoth_rt_old"));
    }

    struct NoBrowser;
    impl Browser for NoBrowser {
        fn open(&self, _: &str) -> HostResult<()> {
            Ok(())
        }
    }

    fn remote_with(dir: &std::path::Path, servers: Value, secrets: Arc<MemorySecretStore>) -> Remote {
        std::fs::write(dir.join(LIST_FILE), json!({ "version": 1, "servers": servers }).to_string()).unwrap();
        Remote::new(Some(dir.to_path_buf()), secrets, Arc::new(NoBrowser))
    }

    #[test]
    fn the_hosted_trial_saved_at_its_old_address_moves_to_the_new_one_and_stays_signed_in() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        secrets.set("server_trial", "thoth_rt_0123456789abcdef").unwrap();
        let remote = remote_with(dir.path(), json!([
            { "id": "server_trial", "url": "https://api.thoth.creaml4tt3.me", "label": "Thoth demo server", "auth": "browser",
              "account": { "id": "u1", "displayName": "Ann" }, "providers": [],
              "endpoints": { "token": "https://api.thoth.creaml4tt3.me/oauth/token", "revocation": "https://api.thoth.creaml4tt3.me/oauth/revoke" } },
            { "id": "server_other", "url": "https://a.example.org", "label": "A", "auth": "token", "providers": [] }
        ]), secrets.clone());

        let list = remote.list();
        // Same handle (the keychain entry is keyed by it), new address, still signed in as the same account.
        assert_eq!(list[0]["id"], "server_trial");
        assert_eq!(list[0]["url"], "https://api.thothnotes.com");
        assert_eq!(list[0]["label"], "Thoth demo server");
        assert_eq!(list[0]["auth"], "browser");
        assert_eq!(list[0]["account"]["displayName"], "Ann");
        assert_eq!(list[1]["url"], "https://a.example.org");
        assert_eq!(secrets.get("server_trial").unwrap().as_deref(), Some("thoth_rt_0123456789abcdef"));
        // The token and revocation endpoints moved with it, so refresh and sign-out still pass the same-origin check.
        let record = remote.record("server_trial").unwrap();
        assert_eq!(record.endpoint(|e| Some(&e.token)).unwrap().as_str(), "https://api.thothnotes.com/oauth/token");
        assert_eq!(record.endpoint(|e| e.revocation.as_ref()).unwrap().as_str(), "https://api.thothnotes.com/oauth/revoke");
        // Written back once: the next start reads the new address.
        let saved = load(&dir.path().join(LIST_FILE));
        assert_eq!(saved[0].url, "https://api.thothnotes.com");
        assert_eq!(saved[0].endpoints.as_ref().unwrap().token, "https://api.thothnotes.com/oauth/token");
    }

    #[test]
    fn a_label_that_was_only_the_old_host_name_becomes_the_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let remote = remote_with(dir.path(), json!([
            { "id": "server_trial", "url": "https://api.thoth.creaml4tt3.me", "label": "api.thoth.creaml4tt3.me", "auth": "signed-out", "providers": [] }
        ]), Arc::default());
        assert_eq!(remote.list()[0]["label"], "api.thothnotes.com");
    }

    #[test]
    fn the_old_address_is_left_alone_when_the_new_one_is_saved_too() {
        let dir = tempfile::tempdir().unwrap();
        let servers = json!([
            { "id": "server_old", "url": "https://api.thoth.creaml4tt3.me", "label": "Old", "auth": "browser", "providers": [],
              "endpoints": { "token": "https://api.thoth.creaml4tt3.me/oauth/token" } },
            { "id": "server_new", "url": "https://api.thothnotes.com", "label": "New", "auth": "signed-out", "providers": [] }
        ]);
        let remote = remote_with(dir.path(), servers, Arc::default());
        // Two entries with one address would be one server listed twice; neither is changed.
        let list = remote.list();
        assert_eq!((list[0]["url"].as_str(), list[1]["url"].as_str()), (Some("https://api.thoth.creaml4tt3.me"), Some("https://api.thothnotes.com")));
        assert!(remote.record("server_old").unwrap().endpoint(|e| Some(&e.token)).is_some());
    }
}
