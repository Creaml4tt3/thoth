//! Link previews (ADR-0020): the title, description, site name and image a page gives for itself (Open Graph,
//! Twitter cards, `<title>`), fetched by the host only. The webview has no network (ADR-0008); it names a link and
//! gets text and a `data:` image back, never markup.
//!
//! Every rule that limits what a page can make the host do is in `address` (which addresses), `fetch` (redirects,
//! time, size, headers) and `text` (what comes back). Previews and failures are cached under the app data folder
//! (`cache`), never in a vault.
pub mod address;
pub mod cache;
pub mod fetch;
pub mod html;
pub mod text;

use crate::error::{HostError, HostResult};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use cache::{Cache, CacheLimits, Cached};
use fetch::{Fetcher, Lookup, MAX_HTML, MAX_IMAGE, SystemLookup, TIMEOUT, USER_AGENT, Want, charset, image_type, mime, unavailable};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Instant, SystemTime};
use url::Url;

/// At most this many previews are fetched at once; more wait their turn.
pub const MAX_PARALLEL: usize = 4;

pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

pub struct LinkOptions {
    /// Test switch (stdio harness `--link-preview-loopback`): loopback addresses count as public so a local test
    /// server can be fetched. The desktop shell always passes `false`.
    pub allow_loopback: bool,
    pub lookup: Arc<dyn Lookup>,
    pub limits: CacheLimits,
    pub clock: Clock,
}

impl Default for LinkOptions {
    fn default() -> Self {
        Self { allow_loopback: false, lookup: Arc::new(SystemLookup), limits: cache::LIMITS, clock: Arc::new(SystemTime::now) }
    }
}

struct Gate {
    busy: Mutex<usize>,
    free: Condvar,
}

struct Slot<'a>(&'a Gate);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        *self.0.busy.lock().unwrap_or_else(|p| p.into_inner()) -= 1;
        self.0.free.notify_one();
    }
}

impl Gate {
    fn enter(&self) -> Slot<'_> {
        let mut busy = self.busy.lock().unwrap_or_else(|p| p.into_inner());
        while *busy >= MAX_PARALLEL {
            busy = self.free.wait(busy).unwrap_or_else(|p| p.into_inner());
        }
        *busy += 1;
        Slot(self)
    }
}

pub struct LinkPreviews {
    fetcher: Fetcher,
    cache: Option<Cache>,
    clock: Clock,
    gate: Gate,
}

/// A link the app may open in the browser (`link.open`): `http` or `https` with a host, no control characters.
pub fn openable(input: &str) -> HostResult<Url> {
    if input.len() > address::MAX_URL || input.chars().any(char::is_control) {
        return Err(HostError::bad_argument("Only web addresses can be opened"));
    }
    let url = Url::parse(input).map_err(|_| HostError::bad_argument("Only web addresses can be opened"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err(HostError::bad_argument("Only web addresses can be opened"));
    }
    Ok(url)
}

impl LinkPreviews {
    /// `data_dir`: where the cache lives; `None` (memory only hosts) fetches every time.
    pub fn new(data_dir: Option<PathBuf>, options: LinkOptions) -> Self {
        let cache = data_dir.map(|d| Cache::new(&d, options.limits));
        Self {
            fetcher: Fetcher { lookup: options.lookup, allow_loopback: options.allow_loopback },
            cache,
            clock: options.clock,
            gate: Gate { busy: Mutex::new(0), free: Condvar::new() },
        }
    }

    /// `link.preview`: the preview of `input`, from the cache when it is fresh. Errors: `BAD_ARGUMENT` (not a link),
    /// `NOT_ALLOWED` (a scheme, a credential or an address the rules refuse), `PREVIEW_UNAVAILABLE` (the page could not
    /// be fetched or is not HTML). Failures of the last two kinds are cached for an hour.
    pub fn preview(&self, input: &str) -> HostResult<Value> {
        let mut url = address::web_link(input)?;
        url.set_fragment(None);
        let key = url.as_str().to_owned();
        if let Some(cache) = &self.cache
            && let Some(hit) = cache.get(&key, (self.clock)())
        {
            return match hit {
                Cached::Preview(p) => Ok(p),
                Cached::Failure(e) => Err(e),
            };
        }
        let result = {
            let _slot = self.gate.enter();
            self.fetch(&url)
        };
        if let Some(cache) = &self.cache {
            match &result {
                Ok(p) => cache.put(&key, &Cached::Preview(p.clone()), (self.clock)()),
                Err(e) => cache.put(&key, &Cached::Failure(e.clone()), (self.clock)()),
            }
        }
        result
    }

    /// `link.preview.clear`: forgets every cached preview and failure.
    pub fn clear(&self) -> HostResult<()> {
        self.cache.as_ref().map_or(Ok(()), Cache::clear)
    }

    /// Number of cached entries and their size in bytes.
    pub fn cache_usage(&self) -> (usize, u64) {
        self.cache.as_ref().map_or((0, 0), Cache::usage)
    }

    fn fetch(&self, url: &Url) -> HostResult<Value> {
        let deadline = Instant::now() + TIMEOUT;
        let page = self.fetcher.get(
            url,
            deadline,
            &Want {
                accept: "text/html,application/xhtml+xml;q=0.9",
                user_agent: USER_AGENT,
                https_only: false,
                max: MAX_HTML,
                stop_at_head: true,
                refuse_longer: false,
            },
        )?;
        if mime(page.content_type.as_deref()).as_deref() != Some("text/html") {
            return Err(unavailable(&page.url, "it is not a web page"));
        }
        let html = text::decode(&page.body, charset(page.content_type.as_deref()).as_deref());
        let head = html::read_head(&html);
        let mut out = Map::new();
        out.insert("url".into(), Value::String(url.as_str().to_owned()));
        out.insert("finalUrl".into(), Value::String(page.url.as_str().to_owned()));
        for (key, value, max) in
            [("siteName", &head.site_name, text::MAX_SITE), ("title", &head.title, text::MAX_TITLE), ("description", &head.description, text::MAX_DESCRIPTION)]
        {
            if let Some(clean) = value.as_deref().and_then(|v| text::clean(v, max)) {
                out.insert(key.into(), Value::String(clean));
            }
        }
        let image = head
            .image
            .as_deref()
            .and_then(|src| page.url.join(src.trim()).ok())
            .filter(|u| matches!(u.scheme(), "http" | "https"))
            .and_then(|u| self.image(&u, deadline));
        if let Some(image) = image {
            out.insert("image".into(), Value::String(image));
        }
        Ok(Value::Object(out))
    }

    /// The page's image as a `data:` URL, when it is a PNG, JPEG, GIF or WebP (by its bytes) of at most 2 MB, fetched
    /// under the same rules. Any failure leaves the preview without an image.
    fn image(&self, url: &Url, deadline: Instant) -> Option<String> {
        let mut url = url.clone();
        url.set_fragment(None);
        let fetched = self
            .fetcher
            .get(
                &url,
                deadline,
                &Want {
                    accept: "image/png,image/jpeg,image/gif,image/webp",
                    user_agent: USER_AGENT,
                    https_only: false,
                    max: MAX_IMAGE,
                    stop_at_head: false,
                    refuse_longer: true,
                },
            )
            .ok()?;
        let kind = image_type(&fetched.body)?;
        Some(format!("data:{kind};base64,{}", B64.encode(&fetched.body)))
    }
}
