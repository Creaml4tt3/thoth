//! The update notice (ADR-0022): the host asks one fixed address for `latest.json`, compares the version it names
//! with the running app's, and tells the webview whether a newer one is out. It is a notice and nothing else: no
//! download, no install, no signature (the installers are fetched by the person, from the website, in a browser).
//!
//! The request follows the rules of link previews (ADR-0020), through the same fetcher: https only, a public address
//! after DNS that is the address connected to, no cookies or credentials, no proxy, a fixed `User-Agent`, 5 s in
//! total, at most 64 KB, JSON only. Each start of the app checks once; while it stays open, a check happens at most
//! once in 24 hours, counted across its windows. Never when the person turned the notice off.
//!
//! From 0.2.3 (ADR-0034) a copy that can replace itself also downloads and installs the new version, but only when the
//! person clicks Update and only with "Download and install updates in the app" on (`crate::install`).
use crate::error::{HostError, HostResult};
use crate::install::{InApp, Installer, NoInstaller};
use crate::links::Clock;
use crate::links::fetch::{Fetcher, Lookup, SystemLookup, TIMEOUT, Want, mime};
use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use url::Url;

/// Where the newest release is named (served by the same R2 bucket as the installers, `docs/deploy/release.md`).
pub const DEFAULT_URL: &str = "https://download.thothnotes.com/latest.json";
/// Where "Download" goes: the website's download section, which has the installers and how to open them.
pub const DEFAULT_DOWNLOADS_PAGE: &str = "https://thothnotes.com/#download";
/// Most of `latest.json` read; a longer answer is refused.
pub const MAX_BYTES: usize = 64 * 1024;
/// The least time between two requests while the app stays open. A restart is not held to it: each start checks once.
pub const INTERVAL_SECS: u64 = 24 * 60 * 60;
/// The file in the app data folder that keeps the person's choice, the skipped version and the time of the last check.
pub const STATE_FILE: &str = "update.json";

// --------------------------------------------------------------------------------------------------- versions

/// A semantic version (semver.org 2.0.0): `1.2.3`, `1.2.3-rc.1`, `1.2.3+build`. No leading `v`, no leading zeros.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    core: [u64; 3],
    pre: Vec<String>,
}

fn numeric(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())
}

impl Version {
    /// Parses `text` strictly; anything the semver grammar does not allow is `None`.
    pub fn parse(text: &str) -> Option<Self> {
        if text.is_empty() || text.len() > 64 {
            return None;
        }
        let (rest, build) = match text.split_once('+') {
            Some((rest, build)) => (rest, Some(build)),
            None => (text, None),
        };
        if let Some(build) = build
            && !build.split('.').all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        {
            return None;
        }
        let (core, pre) = match rest.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (rest, None),
        };
        let mut numbers = core.split('.');
        let mut part = || -> Option<u64> {
            let n = numbers.next()?;
            if !numeric(n) || (n.len() > 1 && n.starts_with('0')) {
                return None;
            }
            n.parse().ok()
        };
        let core = [part()?, part()?, part()?];
        if numbers.next().is_some() {
            return None;
        }
        let pre = match pre {
            None => Vec::new(),
            Some(pre) => {
                let ids: Vec<String> = pre.split('.').map(str::to_owned).collect();
                let valid = ids.iter().all(|id| {
                    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') && !(numeric(id) && id.len() > 1 && id.starts_with('0'))
                });
                if !valid {
                    return None;
                }
                ids
            }
        };
        Some(Self { core, pre })
    }

    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.core[0], self.core[1], self.core[2])?;
        if !self.pre.is_empty() {
            write!(f, "-{}", self.pre.join("."))?;
        }
        Ok(())
    }
}

/// Precedence between two pre-release identifiers: numbers by value (and below words), words by their ASCII order.
fn compare_identifier(a: &str, b: &str) -> Ordering {
    match (numeric(a), numeric(b)) {
        // Digits only, no leading zero: a longer number is the larger one, equal lengths compare as text.
        (true, true) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.cmp(b),
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core.cmp(&other.core).then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            // A release is above its own pre-releases.
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                for (a, b) in self.pre.iter().zip(&other.pre) {
                    let order = compare_identifier(a, b);
                    if order != Ordering::Equal {
                        return order;
                    }
                }
                self.pre.len().cmp(&other.pre.len())
            }
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Is `latest` worth telling the person about when they run `current`? It must be newer, and a pre-release is never
/// offered to a stable build (a person on a pre-release is offered newer ones, pre-release or not).
pub fn is_offered(current: &Version, latest: &Version) -> bool {
    latest > current && (current.is_prerelease() || !latest.is_prerelease())
}

// ------------------------------------------------------------------------------------------------ latest.json

/// What `latest.json` says that the notice uses. Everything else in it is ignored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Latest {
    pub version: Version,
    /// `yyyy-mm-dd`, when the file has one.
    pub date: Option<String>,
    /// A release-notes link (`https`), when the file has one.
    pub notes: Option<String>,
}

fn is_date(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

/// A link the notice may hand to the browser: `https`, a host, no credentials, no control characters, short.
fn https_link(text: &str) -> Option<String> {
    if text.len() > 2048 || text.chars().any(char::is_control) {
        return None;
    }
    let url = Url::parse(text).ok()?;
    (url.scheme() == "https" && url.host().is_some() && url.username().is_empty() && url.password().is_none()).then(|| url.into())
}

/// Reads `latest.json` strictly: a JSON object whose `version` is a semver string. `date`, when present, is
/// `yyyy-mm-dd`; `notes`, when present, is an `https` link. Any other value of those three is refused, not skipped.
/// Fields the notice does not know are ignored.
pub fn parse_latest(body: &[u8]) -> Option<Latest> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let object = value.as_object()?;
    let version = Version::parse(object.get("version")?.as_str()?)?;
    let date = match object.get("date") {
        None => None,
        Some(Value::String(d)) if is_date(d) => Some(d.clone()),
        Some(_) => return None,
    };
    let notes = match object.get("notes") {
        None => None,
        Some(Value::String(n)) => Some(https_link(n)?),
        Some(_) => return None,
    };
    Some(Latest { version, date, notes })
}

// ------------------------------------------------------------------------------------------------- the service

pub struct UpdateOptions {
    /// The version of the running app (the desktop shell's own, `tauri.conf.json`).
    pub current: String,
    /// Where `latest.json` is. Empty: this build has no update notice (a self-built copy may choose that).
    pub url: String,
    /// Where "Download" goes.
    pub downloads_page: String,
    /// Test switch (the stdio harness's `--link-preview-loopback`, ADR-0020): an `http` address on loopback may be
    /// fetched, for a local test server. The desktop shell never turns it on.
    pub allow_loopback: bool,
    pub lookup: Arc<dyn Lookup>,
    pub clock: Clock,
    /// What downloads and installs an update (ADR-0034); `NoInstaller` keeps the notice only.
    pub installer: Arc<dyn Installer>,
    /// Where `update.progress` goes (`Host::with_updates` sets the host's event sink).
    pub events: Option<crate::EventSink>,
}

impl UpdateOptions {
    /// An update notice for `current` that looks at `url`.
    pub fn new(current: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            current: current.into(),
            url: url.into(),
            downloads_page: DEFAULT_DOWNLOADS_PAGE.to_owned(),
            allow_loopback: false,
            lookup: Arc::new(SystemLookup),
            clock: Arc::new(SystemTime::now),
            installer: Arc::new(NoInstaller),
            events: None,
        }
    }

    /// No update notice: no request is ever made.
    pub fn off() -> Self {
        Self::new(env!("CARGO_PKG_VERSION"), "")
    }
}

/// What is kept in the app data folder (`update.json`): the person's choice, the version they skipped and when the
/// last request was made (shown in Settings). Never in a vault.
#[derive(Clone, Debug, PartialEq, Eq)]
struct State {
    notify: bool,
    /// "Download and install updates in the app" (ADR-0034); on by default.
    install: bool,
    last_check: Option<u64>,
    skipped: Option<Version>,
    /// When this run of the app last asked. Only this holds back the next check; it is never written, so a new start
    /// of the app always checks.
    asked_this_run: Option<u64>,
}

impl Default for State {
    fn default() -> Self {
        Self { notify: true, install: true, last_check: None, skipped: None, asked_this_run: None }
    }
}

impl State {
    fn read(bytes: &[u8]) -> Self {
        let Ok(Value::Object(o)) = serde_json::from_slice::<Value>(bytes) else { return Self::default() };
        Self {
            notify: o.get("notify").and_then(Value::as_bool).unwrap_or(true),
            install: o.get("install").and_then(Value::as_bool).unwrap_or(true),
            last_check: o.get("lastCheck").and_then(Value::as_u64),
            skipped: o.get("skipped").and_then(Value::as_str).and_then(Version::parse),
            asked_this_run: None,
        }
    }

    fn to_json(&self) -> Value {
        json!({ "v": 1, "notify": self.notify, "install": self.install, "lastCheck": self.last_check, "skipped": self.skipped.as_ref().map(ToString::to_string) })
    }
}

pub struct Updates {
    options: UpdateOptions,
    current: Option<Version>,
    path: Option<PathBuf>,
    fetcher: Fetcher,
    state: Mutex<State>,
    in_app: Arc<InApp>,
    /// One check at a time: a second window's check waits, then finds the first one's time recorded.
    checking: Mutex<()>,
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Updates {
    /// `data_dir`: where `update.json` lives; `None` keeps the state in memory only.
    pub fn new(data_dir: Option<PathBuf>, options: UpdateOptions) -> Self {
        let path = data_dir.map(|d| d.join(STATE_FILE));
        let state = path.as_ref().and_then(|p| std::fs::read(p).ok()).map_or_else(State::default, |bytes| State::read(&bytes));
        let fetcher = Fetcher { lookup: options.lookup.clone(), allow_loopback: options.allow_loopback };
        let current = Version::parse(&options.current);
        let in_app = InApp::new(options.installer.clone(), options.events.clone());
        Self { options, current, path, fetcher, state: Mutex::new(state), in_app, checking: Mutex::new(()) }
    }

    fn enabled(&self) -> bool {
        !self.options.url.is_empty() && self.current.is_some()
    }

    /// Whether this copy can update itself in the app (the switch then shows in Settings).
    fn can_install(&self) -> bool {
        self.enabled() && self.in_app.supported()
    }

    fn save(&self, state: &State) {
        let Some(path) = &self.path else { return };
        // The notice is a convenience: a state that cannot be written is lost with the session, not an error.
        let _ = write_private(path, state.to_json().to_string().as_bytes());
    }

    fn settings_json(&self, state: &State) -> Value {
        json!({
            "available": self.enabled(),
            "current": self.options.current,
            "notify": state.notify,
            "install": state.install,
            "canInstall": self.can_install(),
            "skipped": state.skipped.as_ref().map(ToString::to_string),
            "lastChecked": state.last_check,
        })
    }

    /// `update.settings`: reads the person's choice, after applying `notify` (on or off), `install` (in-app updates on
    /// or off) and `skip` (a version to skip; `null` forgets it) when the arguments have them.
    pub fn settings(&self, args: &Value) -> HostResult<Value> {
        let flag = |name: &str| match args.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(HostError::bad_argument(format!("{name} must be a boolean"))),
        };
        let notify = flag("notify")?;
        let install = flag("install")?;
        let skip = match args.get("skip") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(s)) => Some(Some(Version::parse(s).ok_or_else(|| HostError::bad_argument("skip must be a version such as 1.2.3"))?)),
            Some(_) => return Err(HostError::bad_argument("skip must be a version or null")),
        };
        let mut state = locked(&self.state);
        if notify.is_some() || install.is_some() || skip.is_some() {
            if let Some(notify) = notify {
                state.notify = notify;
            }
            if let Some(install) = install {
                state.install = install;
            }
            if let Some(skip) = skip {
                state.skipped = skip;
            }
            self.save(&state);
        }
        Ok(self.settings_json(&state))
    }

    /// `update.check`: asks `latest.json` whether a newer version is out.
    ///
    /// The answer's `state` is one of:
    /// - `unavailable`: this build has no update notice; nothing was requested.
    /// - `off`: the person turned the notice off (a forced check too); nothing was requested.
    /// - `waiting`: this run of the app asked less than 24 hours ago (from any window); nothing was requested
    ///   (`force` skips this wait). The first check after the app starts is never `waiting`.
    /// - `failed`: the request or the file was not good. It counts as a check: the next one in this run is 24 hours
    ///   away.
    /// - `current`: nothing newer is offered.
    /// - `available`: `update` has `version`, `downloadUrl`, `skipped` (the person skipped this version or a newer
    ///   one), `inApp` (Update installs it in the app, ADR-0034; otherwise Download opens the downloads page) and, when
    ///   the file has them, `date` and `notesUrl`.
    pub fn check(&self, force: bool) -> Value {
        if !self.enabled() {
            return json!({ "state": "unavailable" });
        }
        let _one = locked(&self.checking);
        let now = secs((self.options.clock)());
        let (skipped, in_app) = {
            let mut state = locked(&self.state);
            if !state.notify {
                return json!({ "state": "off" });
            }
            if !force && let Some(last) = state.asked_this_run.filter(|last| *last <= now + 60 && now.saturating_sub(*last) < INTERVAL_SECS) {
                return json!({ "state": "waiting", "checkedAt": last });
            }
            // Recorded before the request: a request that hangs or fails still uses up the day.
            state.asked_this_run = Some(now);
            state.last_check = Some(now);
            self.save(&state);
            (state.skipped.clone(), state.install && self.can_install())
        };
        let Some(current) = &self.current else { return json!({ "state": "unavailable" }) };
        let Some(latest) = self.fetch() else { return json!({ "state": "failed", "checkedAt": now }) };
        if !is_offered(current, &latest.version) {
            return json!({ "state": "current", "checkedAt": now });
        }
        let mut update = Map::new();
        update.insert("version".into(), Value::String(latest.version.to_string()));
        if let Some(date) = latest.date {
            update.insert("date".into(), Value::String(date));
        }
        update.insert("downloadUrl".into(), Value::String(self.options.downloads_page.clone()));
        if let Some(notes) = latest.notes {
            update.insert("notesUrl".into(), Value::String(notes));
        }
        update.insert("skipped".into(), Value::Bool(skipped.is_some_and(|s| latest.version <= s)));
        update.insert("inApp".into(), Value::Bool(in_app));
        json!({ "state": "available", "checkedAt": now, "update": update })
    }

    /// `update.install`: Update was clicked. Starts the download (or joins the one going) and answers its state; the
    /// rest comes as `update.progress` events. Refused where the copy cannot update itself, the person turned in-app
    /// updates off, or the notice is off (no request at all).
    pub fn install(&self) -> HostResult<Value> {
        let state = locked(&self.state);
        if !self.can_install() {
            return Err(HostError::not_allowed("This copy of Thoth cannot update itself: download the new version from the website"));
        }
        if !state.notify || !state.install {
            return Err(HostError::not_allowed("Updates in the app are turned off in Settings"));
        }
        drop(state);
        Ok(self.in_app.start())
    }

    /// `update.cancel`: stops the download going, if one is.
    pub fn cancel(&self) -> Value {
        self.in_app.cancel()
    }

    /// `update.status`: `idle`, `downloading` (`received`, `total` when known), `ready` (`version`, `installed`),
    /// `failed` (`reason`: `offline`, `verify`, `disk`, `cancelled` or `failed`) or `restarting`.
    pub fn status(&self) -> Value {
        self.in_app.status()
    }

    /// `update.restart`: restarts into the ready update, or answers `busy` with the assistant runs going (`running`),
    /// unless `even_if_running`.
    pub fn restart(&self, even_if_running: bool, running: usize) -> HostResult<Value> {
        self.in_app.restart(even_if_running, running)
    }

    /// The request: `None` for any failure (the reason would only echo what a server sent).
    fn fetch(&self) -> Option<Latest> {
        let url = Url::parse(&self.options.url).ok()?;
        let user_agent = format!("Thoth/{} (update check)", self.options.current);
        let want = Want { accept: "application/json", user_agent: &user_agent, https_only: true, max: MAX_BYTES, stop_at_head: false, refuse_longer: true };
        let fetched = self.fetcher.get(&url, Instant::now() + TIMEOUT, &want).ok()?;
        if mime(fetched.content_type.as_deref()).as_deref() != Some("application/json") {
            return None;
        }
        parse_latest(&fetched.body)
    }
}

/// Writes `bytes` to `path` through a temporary file in the same folder, owner-only, then renames it into place.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|e| std::io::Error::other(e.to_string()))?;
    let temp = dir.join(format!(".update-{}", random.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap_or_else(|| panic!("{text} should parse"))
    }

    #[test]
    fn reads_versions_strictly() {
        assert_eq!(v("0.1.3").to_string(), "0.1.3");
        assert_eq!(v("1.2.3-rc.1+build.5").to_string(), "1.2.3-rc.1");
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "v1.2.3",
            "01.2.3",
            "1.02.3",
            "1.2.-3",
            "1.2.3-",
            "1.2.3-01",
            "1.2.3-a..b",
            "1.2.3+",
            "1.2.3+a b",
            "1.2.3 ",
            " 1.2.3",
            "1.2.x",
            "99999999999999999999.0.0",
            "1.2.3-é",
        ] {
            assert!(Version::parse(bad).is_none(), "{bad:?} should be refused");
        }
        assert!(Version::parse(&format!("1.2.3-{}", "a".repeat(80))).is_none());
    }

    #[test]
    fn orders_versions_by_the_semver_rules() {
        // The order semver.org gives as its example, lowest first.
        let chain = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.1",
            "1.1.0",
            "2.0.0",
        ];
        for (i, a) in chain.iter().enumerate() {
            for (j, b) in chain.iter().enumerate() {
                assert_eq!(v(a).cmp(&v(b)), i.cmp(&j), "{a} against {b}");
            }
        }
        // Numbers are compared as numbers, not as text; build metadata does not count.
        assert!(v("0.10.0") > v("0.9.0"));
        assert!(v("1.0.0-9") < v("1.0.0-10"));
        assert_eq!(v("1.0.0+a").cmp(&v("1.0.0+b")), Ordering::Equal);
    }

    #[test]
    fn offers_newer_versions_and_never_a_prerelease_to_a_stable_build() {
        let offered = |current: &str, latest: &str| is_offered(&v(current), &v(latest));
        assert!(offered("0.1.3", "0.1.4"));
        assert!(offered("0.1.3", "1.0.0"));
        assert!(!offered("0.1.3", "0.1.3"));
        assert!(!offered("0.1.3", "0.1.2"));
        assert!(!offered("0.1.3", "0.2.0-rc.1"), "a pre-release is not offered to a stable build");
        assert!(offered("0.2.0-rc.1", "0.2.0-rc.2"));
        assert!(offered("0.2.0-rc.1", "0.2.0"));
        assert!(!offered("0.2.0-rc.2", "0.2.0-rc.1"));
        assert!(!offered("0.2.0", "0.2.0-rc.9"));
    }

    #[test]
    fn reads_the_latest_json_the_release_workflow_writes() {
        // The shape scripts/publish-downloads.ts writes: version, date, base and the files with their sizes and sums.
        let real = br#"{
          "version": "0.1.3", "date": "2026-10-25", "base": "https://download.thothnotes.com/v0.1.3/",
          "files": [{ "platform": "macos", "kind": "dmg", "arch": "universal", "file": "Thoth_0.1.3_universal.dmg", "bytes": 12270577, "sha256": "40c8" }]
        }"#;
        let latest = parse_latest(real).unwrap();
        assert_eq!(latest.version, v("0.1.3"));
        assert_eq!(latest.date.as_deref(), Some("2026-10-25"));
        assert_eq!(latest.notes, None);
    }

    #[test]
    fn reads_the_optional_release_notes_link() {
        let latest = parse_latest(br#"{"version":"0.2.0","notes":"https://thothnotes.com/changes#0.2.0"}"#).unwrap();
        assert_eq!(latest.notes.as_deref(), Some("https://thothnotes.com/changes#0.2.0"));
        assert_eq!(latest.date, None);
    }

    #[test]
    fn ignores_unknown_fields_and_refuses_missing_or_wrong_ones() {
        let ok = parse_latest(br#"{"version":"1.0.0","future":{"a":[1,2]},"files":"not a list","base":7}"#).unwrap();
        assert_eq!(ok.version, v("1.0.0"));
        for bad in [
            &br#"{}"#[..],
            br#"{"date":"2026-10-25"}"#,
            br#"{"version":"v1.0.0"}"#,
            br#"{"version":"one"}"#,
            br#"{"version":1}"#,
            br#"{"version":null}"#,
            br#"{"version":"1.0.0","date":"yesterday"}"#,
            br#"{"version":"1.0.0","date":20261025}"#,
            br#"{"version":"1.0.0","notes":"http://example.org/n"}"#,
            br#"{"version":"1.0.0","notes":"javascript:alert(1)"}"#,
            br#"{"version":"1.0.0","notes":"https://user:pw@example.org/n"}"#,
            br#"{"version":"1.0.0","notes":7}"#,
            br#"["1.0.0"]"#,
            br#""1.0.0""#,
            br#"null"#,
            b"",
            b"<html>1.0.0</html>",
            &[0xff, 0xfe, 0x00],
        ] {
            assert!(parse_latest(bad).is_none(), "{:?} should be refused", String::from_utf8_lossy(bad));
        }
    }
}
