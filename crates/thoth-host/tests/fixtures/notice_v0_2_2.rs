//! The update notice's `latest.json` reader as the installed 0.2.0, 0.2.1 and 0.2.2 apps have it, copied verbatim from
//! git history (ADR-0034): the "versions" and "latest.json" sections of `crates/thoth-host/src/updates.rs` at tag
//! `v0.2.2`, which are byte for byte those of `v0.2.0` and `v0.2.1` (`git diff v0.2.0 v0.2.2 --
//! crates/thoth-host/src/updates.rs` changes only the addresses). Made with:
//!
//!     git show v0.2.2:crates/thoth-host/src/updates.rs | sed -n '/^\/\/ -* versions/,/^\/\/ -* the service/p' | sed '$d'
//!
//! Never edit it: it stands for apps already installed.
#![allow(dead_code)]
use serde_json::Value;
use std::cmp::Ordering;
use url::Url;

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
                let valid = ids.iter().all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') && !(numeric(id) && id.len() > 1 && id.starts_with('0')));
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

