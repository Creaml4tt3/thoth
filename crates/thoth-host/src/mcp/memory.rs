//! Agents' memory (ADR-0052): what the host checks before a memory is written without review, and the history of those
//! writes.
//!
//! Every write without review keeps the text before and after for 30 days in `<data>/mcp/memory/`, one owner-only file
//! each, never in the notes folder: the Memories view lists them with Undo, and the per-app daily limit counts them.
use super::{private_dir, write_private};
use crate::error::{HostError, HostResult};
use crate::handles::new_handle;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

pub const DIR: &str = "memory";
/// How long a write is remembered: 30 days.
pub const KEEP_SECS: u64 = 30 * 86_400;
/// Writes without review an app may make in a day (then `BUSY`).
pub const DAILY_LIMIT: usize = 100;
const DAY_SECS: u64 = 86_400;
/// Writes remembered at most; the oldest go first.
const MAX_KEPT: usize = 5000;
/// The largest history file read back (a memory file before and after, and the fields around them).
const MAX_FILE: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Created,
    Updated,
    Forgot,
}

/// One write without review, without its text.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub app: String,
    pub action: Action,
    /// The Private Space's canonical root, and its name as the app saw it.
    pub root: String,
    pub space: String,
    pub path: String,
    pub page_id: String,
    pub title: String,
    /// The file's version before (None: it was new) and after (None: forgotten).
    #[serde(default)]
    pub before_hash: Option<String>,
    #[serde(default)]
    pub after_hash: Option<String>,
    /// Seconds since 1970.
    pub created: u64,
}

impl Change {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "app": self.app, "action": self.action, "root": self.root, "space": self.space, "path": self.path,
            "pageId": self.page_id, "title": self.title, "beforeHash": self.before_hash, "afterHash": self.after_hash,
            "createdAt": super::log::iso(self.created),
        })
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    #[serde(flatten)]
    change: Change,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    after: Option<String>,
}

/// A write about to be remembered.
pub struct New {
    pub app: String,
    pub action: Action,
    pub root: String,
    pub space: String,
    pub path: String,
    pub page_id: String,
    pub title: String,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
}

pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub struct History {
    dir: Option<PathBuf>,
    clock: Clock,
    changes: Mutex<Vec<Change>>,
}

impl History {
    /// `mcp_dir` is `<data>/mcp` (None: counted in memory only, nothing can be undone).
    pub fn new(mcp_dir: Option<&Path>, clock: Clock) -> Self {
        let dir = mcp_dir.map(|d| d.join(DIR));
        let mut changes = Vec::new();
        if let Some(dir) = &dir {
            for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(id) = name.strip_suffix(".json") else { continue };
                if !is_change_id(id) {
                    continue;
                }
                if let Some(stored) = read(&entry.path())
                    && stored.change.id == id
                {
                    changes.push(stored.change);
                }
            }
        }
        changes.sort_by_key(|c: &Change| c.created);
        Self { dir, clock, changes: Mutex::new(changes) }
    }

    pub fn now(&self) -> u64 {
        (self.clock)()
    }

    /// Writes `app` made in the last day.
    pub fn today(&self, app: &str) -> usize {
        let since = self.now().saturating_sub(DAY_SECS);
        self.list().iter().filter(|c| c.app == app && c.created > since).count()
    }

    pub fn add(&self, new: New) -> HostResult<Change> {
        let change = Change {
            id: new_handle("mem")?,
            app: new.app,
            action: new.action,
            root: new.root,
            space: new.space,
            path: new.path,
            page_id: new.page_id,
            title: new.title,
            before_hash: new.before_hash,
            after_hash: new.after_hash,
            created: self.now(),
        };
        let mut changes = self.changes();
        self.sweep(&mut changes);
        if let Some(dir) = &self.dir {
            private_dir(dir)?;
            let body = serde_json::to_vec(&Stored { change: change.clone(), before: new.before, after: new.after })
                .map_err(|e| HostError::internal(format!("Could not keep the memory's history: {e}")))?;
            write_private(&dir.join(format!("{}.json", change.id)), &body)?;
        }
        changes.push(change.clone());
        Ok(change)
    }

    /// Every write remembered, oldest first.
    pub fn list(&self) -> Vec<Change> {
        let mut changes = self.changes();
        self.sweep(&mut changes);
        changes.clone()
    }

    /// One write with the text before and after.
    pub fn get(&self, id: &str) -> HostResult<(Change, Option<String>, Option<String>)> {
        let not_found = || HostError::new("NOT_FOUND", format!("No memory change {id}"));
        let change = self.list().into_iter().find(|c| c.id == id).ok_or_else(not_found)?;
        let stored = self.dir.as_ref().and_then(|d| read(&d.join(format!("{id}.json")))).ok_or_else(not_found)?;
        Ok((change, stored.before, stored.after))
    }

    /// Forgets what is older than `KEEP_SECS`, and the oldest beyond `MAX_KEPT`.
    fn sweep(&self, changes: &mut Vec<Change>) {
        let now = self.now();
        let mut over = changes.len().saturating_sub(MAX_KEPT);
        changes.retain(|c| {
            let drop = c.created + KEEP_SECS <= now || over > 0;
            if drop {
                over = over.saturating_sub(1);
                if let Some(dir) = &self.dir {
                    let _ = std::fs::remove_file(dir.join(format!("{}.json", c.id)));
                }
            }
            !drop
        });
    }

    fn changes(&self) -> MutexGuard<'_, Vec<Change>> {
        self.changes.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// `mem_` and 32 lowercase hex digits (`new_handle("mem")`).
pub fn is_change_id(id: &str) -> bool {
    id.strip_prefix("mem_").is_some_and(|hex| hex.len() == 32 && hex.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)))
}

fn read(path: &Path) -> Option<Stored> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path).ok()?.take(MAX_FILE + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_FILE {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// Known prefixes of API keys and tokens, each followed by at least 16 more characters of the token.
const TOKEN_PREFIXES: &[&str] = &[
    "sk-",
    "sk_live_",
    "sk_test_",
    "rk_live_",
    "rk_test_",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxs-",
    "xapp-",
    "AKIA",
    "ASIA",
    "AIza",
    "npm_",
    "hf_",
    "pypi-",
    "shpat_",
    "shpss_",
    "sq0atp-",
    "SG.",
    "dop_v1_",
    "whsec_",
];

/// Text that looks like a secret (ADR-0052 rule 5): a private key, a token with a known prefix, a JSON Web Token, or a
/// long random string. This backs up the instructions; it cannot find every secret.
pub fn looks_like_secret(text: &str) -> bool {
    if text.contains("PRIVATE KEY-----") || text.contains("BEGIN OPENSSH PRIVATE KEY") || text.contains("BEGIN PGP PRIVATE KEY") {
        return true;
    }
    let token_char = |c: char| c.is_ascii_alphanumeric() || "_-+=./".contains(c);
    text.split(|c: char| !token_char(c)).filter(|t| t.len() >= 20).any(|token| {
        let token = token.trim_matches(|c: char| c == '.' || c == '/');
        TOKEN_PREFIXES.iter().any(|p| token.starts_with(p) && token_like(&token[p.len()..])) || jwt(token) || token.split(['.', '/']).any(random)
    })
}

/// What follows a known prefix in a real token: 16 characters or more, with letters and digits, nothing else but `_-.`.
fn token_like(rest: &str) -> bool {
    rest.len() >= 16
        && rest.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
        && rest.chars().any(|c| c.is_ascii_digit())
        && rest.chars().any(|c| c.is_ascii_alphabetic())
}

/// Three base64url parts, the first two JSON objects (`eyJ` is `{"` in base64).
fn jwt(token: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    parts.len() == 3 && parts[0].starts_with("eyJ") && parts[1].starts_with("eyJ") && parts.iter().all(|p| p.len() >= 8)
}

/// A long string of mixed letters and digits with high entropy, as keys are; not hex (hashes, ids) or words.
fn random(part: &str) -> bool {
    if part.len() < 32 {
        return false;
    }
    let count = |f: fn(&char) -> bool| part.chars().filter(f).count();
    let (upper, lower, digits) = (count(char::is_ascii_uppercase), count(char::is_ascii_lowercase), count(char::is_ascii_digit));
    if upper < 3 || lower < 3 || digits < 3 {
        return false;
    }
    let mut seen = [0usize; 128];
    for b in part.bytes() {
        seen[(b & 0x7f) as usize] += 1;
    }
    let n = part.len() as f64;
    let entropy: f64 = seen.iter().filter(|c| **c > 0).map(|c| *c as f64 / n).map(|p| -p * p.log2()).sum();
    entropy >= 4.3
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn finds_what_looks_like_a_secret_and_leaves_ordinary_text() {
        // Fake tokens, joined at run time so secret scanners do not take this file for a leak.
        for secret in [
            ["my key is sk-", "proj-AbC123dEf456GhI789jKl012"].concat(),
            ["token: gh", "p_1234567890abcdefghijABCDEFGHIJ123456"].concat(),
            ["AKIA", "IOSFODNN7EXAMPLE1"].concat(),
            ["AI", "zaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"].concat(),
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE...".to_owned(),
            ["eyJhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].concat(),
            "password=Zx8pQ2vL9mR4tY7wB1nK6cH3jF5sD0gA".to_owned(),
            ["xo", "xb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"].concat(),
        ] {
            assert!(looks_like_secret(&secret), "{secret}");
        }
        for ordinary in [
            "Prefers status updates with blockers first, then risks.",
            "ชอบให้สรุปงานเป็นภาษาไทย แล้วตามด้วยภาษาอังกฤษ",
            "The commit is 3f786850e387550fdab836ed7e6dc881de23001b and the id 0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
            "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "See https://github.com/Creaml4tt3/thoth/blob/main/docs/adr/0052-agent-memory-and-skills.md",
            "apps/desktop/src/features/connected-apps/ConnectedAppsSettings.tsx",
            "Uses the task-list skill, and sk-learn for models.",
            "Compare sk-learn-and-pytorch-for-models in the notes.",
            "VeryLongCamelCaseIdentifierNameForTheSettingsPanel",
        ] {
            assert!(!looks_like_secret(ordinary), "{ordinary}");
        }
    }

    fn new(app: &str) -> New {
        New {
            app: app.into(),
            action: Action::Created,
            root: "/Notes".into(),
            space: "Notes".into(),
            path: "Memory/a.md".into(),
            page_id: "p1".into(),
            title: "A".into(),
            before_hash: None,
            after_hash: Some("h".into()),
            before: None,
            after: Some("text".into()),
        }
    }

    #[test]
    fn keeps_each_write_with_its_text_for_30_days_in_an_owner_only_file() {
        let data = tempfile::tempdir().unwrap();
        let now = Arc::new(AtomicU64::new(1_000_000));
        let clock = now.clone();
        let history = History::new(Some(data.path()), Arc::new(move || clock.load(Ordering::SeqCst)));
        let change = history.add(new("Claude")).unwrap();
        history.add(new("Codex")).unwrap();
        assert!(is_change_id(&change.id));
        let file = data.path().join(DIR).join(format!("{}.json", change.id));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(history.get(&change.id).unwrap().2.as_deref(), Some("text"));
        assert_eq!(history.today("Claude"), 1);

        // Read back after a restart; a day later it no longer counts toward the limit; after 30 days it is gone.
        let clock = now.clone();
        let again = History::new(Some(data.path()), Arc::new(move || clock.load(Ordering::SeqCst)));
        assert_eq!(again.list().len(), 2);
        now.store(1_000_000 + DAY_SECS, Ordering::SeqCst);
        assert_eq!(again.today("Claude"), 0);
        assert_eq!(again.list().len(), 2);
        now.store(1_000_000 + KEEP_SECS, Ordering::SeqCst);
        assert!(again.list().is_empty());
        assert!(!file.exists());
    }
}
