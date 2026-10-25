//! The link-preview cache (ADR-0020 rule 6), under `<app data>/link-previews/`, never in a vault. One file per link
//! (`<sha-256 of the URL>.json`, replaced atomically). A preview is kept 7 days, a failure 1 hour, so a dead site is
//! not asked on every view. Bounded in entries and bytes; the least recently used go first (a file's modification
//! time is when it was last used).
use crate::error::{HostError, HostResult};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const CACHE_DIR: &str = "link-previews";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CacheLimits {
    pub max_entries: usize,
    pub max_bytes: u64,
    /// How long a preview is used.
    pub keep: Duration,
    /// How long a failure is remembered.
    pub keep_failure: Duration,
}

pub const LIMITS: CacheLimits = CacheLimits { max_entries: 500, max_bytes: 20 * 1024 * 1024, keep: Duration::from_secs(7 * 24 * 3600), keep_failure: Duration::from_secs(3600) };

/// A cached answer: the preview (JSON as sent to the webview) or the error.
#[derive(Clone, Debug, PartialEq)]
pub enum Cached {
    Preview(Value),
    Failure(HostError),
}

pub struct Cache {
    dir: PathBuf,
    limits: CacheLimits,
    lock: Mutex<()>,
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn code(name: &str) -> Option<&'static str> {
    ["NOT_ALLOWED", "PREVIEW_UNAVAILABLE"].into_iter().find(|c| *c == name)
}

impl Cache {
    pub fn new(data_dir: &Path, limits: CacheLimits) -> Self {
        Self { dir: data_dir.join(CACHE_DIR), limits, lock: Mutex::new(()) }
    }

    fn path(&self, url: &str) -> PathBuf {
        let hash = Sha256::digest(url.as_bytes());
        self.dir.join(format!("{}.json", hash.iter().map(|b| format!("{b:02x}")).collect::<String>()))
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The cached answer for `url` at `now`, if one is still fresh. A stale or unreadable entry is removed. A hit
    /// marks the entry as just used.
    pub fn get(&self, url: &str, now: SystemTime) -> Option<Cached> {
        let _one = self.guard();
        let path = self.path(url);
        let meta = std::fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > self.limits.max_bytes {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        let entry: Option<(Cached, u64)> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| {
            if v["v"] != 1 || v["url"].as_str() != Some(url) {
                return None;
            }
            let at = v["at"].as_u64()?;
            if let Some(preview) = v.get("ok") {
                return Some((Cached::Preview(preview.clone()), at));
            }
            let error = v.get("error")?;
            Some((Cached::Failure(HostError::new(code(error["code"].as_str()?)?, error["message"].as_str()?.to_owned())), at))
        });
        let Some((cached, at)) = entry else {
            let _ = std::fs::remove_file(&path);
            return None;
        };
        let keep = if matches!(cached, Cached::Preview(_)) { self.limits.keep } else { self.limits.keep_failure };
        let age = secs(now).saturating_sub(at);
        if age >= keep.as_secs() || at > secs(now) + 60 {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        let _ = std::fs::File::options().write(true).open(&path).and_then(|f| f.set_modified(now));
        Some(cached)
    }

    /// Stores the answer for `url` (only previews and `NOT_ALLOWED` or `PREVIEW_UNAVAILABLE` failures), then evicts
    /// the least recently used entries beyond the limits. Failures to write are ignored: the cache is a cache.
    pub fn put(&self, url: &str, answer: &Cached, now: SystemTime) {
        let body = match answer {
            Cached::Preview(p) => json!({ "v": 1, "url": url, "at": secs(now), "ok": p }),
            Cached::Failure(e) if code(e.code).is_some() => json!({ "v": 1, "url": url, "at": secs(now), "error": { "code": e.code, "message": e.message } }),
            Cached::Failure(_) => return,
        };
        let bytes = body.to_string().into_bytes();
        if bytes.len() as u64 > self.limits.max_bytes {
            return;
        }
        let _one = self.guard();
        if self.write(&self.path(url), &bytes, now).is_ok() {
            self.evict();
        }
    }

    fn write(&self, path: &Path, bytes: &[u8], now: SystemTime) -> HostResult<()> {
        private_dir(&self.dir)?;
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|e| HostError::internal(format!("No randomness: {e}")))?;
        let temp = self.dir.join(format!(".tmp-{}", random.iter().map(|b| format!("{b:02x}")).collect::<String>()));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
            file.write_all(bytes)?;
            file.set_modified(now)?;
            drop(file);
            std::fs::rename(&temp, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result.map_err(|e| HostError::io(&e, "write", &path.to_string_lossy()))
    }

    /// The cache's entries: (path, size, last used), oldest first.
    fn entries(&self) -> Vec<(PathBuf, u64, SystemTime)> {
        let Ok(read) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        let mut out: Vec<_> = read
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
            .filter_map(|e| {
                let meta = std::fs::symlink_metadata(e.path()).ok()?;
                meta.is_file().then(|| (e.path(), meta.len(), meta.modified().unwrap_or(UNIX_EPOCH)))
            })
            .collect();
        out.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.0.cmp(&b.0)));
        out
    }

    fn evict(&self) {
        let entries = self.entries();
        let mut total: u64 = entries.iter().map(|e| e.1).sum();
        let mut i = 0;
        while i < entries.len() && (entries.len() - i > self.limits.max_entries || total > self.limits.max_bytes) {
            let _ = std::fs::remove_file(&entries[i].0);
            total -= entries[i].1;
            i += 1;
        }
    }

    /// Number of entries and their total size (for tests and diagnostics).
    pub fn usage(&self) -> (usize, u64) {
        let entries = self.entries();
        (entries.len(), entries.iter().map(|e| e.1).sum())
    }

    /// Removes every entry (Settings → "Clear link previews").
    pub fn clear(&self) -> HostResult<()> {
        let _one = self.guard();
        let Ok(read) = std::fs::read_dir(&self.dir) else { return Ok(()) };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_file = std::fs::symlink_metadata(entry.path()).is_ok_and(|m| m.is_file() || m.file_type().is_symlink());
            if is_file && (name.ends_with(".json") || name.starts_with(".tmp-")) {
                std::fs::remove_file(entry.path()).map_err(|e| HostError::io(&e, "unlink", &name))?;
            }
        }
        Ok(())
    }
}

fn private_dir(dir: &Path) -> HostResult<()> {
    std::fs::create_dir_all(dir).map_err(|e| HostError::io(&e, "mkdir", &dir.to_string_lossy()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| HostError::io(&e, "chmod", &dir.to_string_lossy()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_800_000_000 + s)
    }

    #[test]
    fn the_limits_are_the_adrs() {
        assert_eq!(LIMITS, CacheLimits { max_entries: 500, max_bytes: 20 * 1024 * 1024, keep: Duration::from_secs(604_800), keep_failure: Duration::from_secs(3600) });
    }

    #[test]
    fn keeps_previews_seven_days_and_failures_one_hour() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path(), LIMITS);
        let preview = Cached::Preview(json!({ "url": "https://a.example/", "title": "A" }));
        cache.put("https://a.example/", &preview, at(0));
        assert_eq!(cache.get("https://a.example/", at(7 * 24 * 3600 - 1)), Some(preview));
        assert_eq!(cache.get("https://a.example/", at(7 * 24 * 3600)), None);
        assert_eq!(cache.usage().0, 0, "a stale entry is removed");

        let failure = Cached::Failure(HostError::new("PREVIEW_UNAVAILABLE", "No preview from https://b.example: the server answered 500"));
        cache.put("https://b.example/", &failure, at(0));
        assert_eq!(cache.get("https://b.example/", at(3599)), Some(failure));
        assert_eq!(cache.get("https://b.example/", at(3600)), None);
        // Other errors (a bad argument, an internal one) are not remembered.
        cache.put("https://c.example/", &Cached::Failure(HostError::internal("x")), at(0));
        assert_eq!(cache.get("https://c.example/", at(1)), None);
    }

    #[test]
    fn evicts_the_least_recently_used_beyond_the_limits() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path(), CacheLimits { max_entries: 3, max_bytes: 10_000, ..LIMITS });
        let p = |n: u32| Cached::Preview(json!({ "n": n }));
        for n in 0..3 {
            cache.put(&format!("https://{n}.example/"), &p(n), at(u64::from(n)));
        }
        // Using 0 makes 1 the least recently used.
        assert!(cache.get("https://0.example/", at(10)).is_some());
        cache.put("https://3.example/", &p(3), at(11));
        assert_eq!(cache.usage().0, 3);
        assert!(cache.get("https://1.example/", at(12)).is_none());
        assert!(cache.get("https://0.example/", at(12)).is_some());

        // By bytes: one large entry pushes out older ones until the total fits.
        let big = Cached::Preview(json!({ "image": "x".repeat(9_850) }));
        cache.put("https://big.example/", &big, at(20));
        let (count, bytes) = cache.usage();
        assert!(bytes <= 10_000, "{bytes}");
        assert!(count <= 2, "{count}");
        assert!(cache.get("https://2.example/", at(21)).is_none(), "the least recently used went first");
        assert!(cache.get("https://big.example/", at(21)).is_some());
        // An entry larger than the whole cache is not stored.
        cache.put("https://huge.example/", &Cached::Preview(json!({ "image": "x".repeat(20_000) })), at(22));
        assert!(cache.get("https://huge.example/", at(23)).is_none());
    }

    #[test]
    fn ignores_a_tampered_entry_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path(), LIMITS);
        cache.put("https://a.example/", &Cached::Preview(json!({})), at(0));
        let path = cache.path("https://a.example/");
        std::fs::write(&path, json!({ "v": 1, "url": "https://other.example/", "at": secs(at(0)), "ok": {} }).to_string()).unwrap();
        assert_eq!(cache.get("https://a.example/", at(1)), None);
        std::fs::write(&path, json!({ "v": 1, "url": "https://a.example/", "at": secs(at(0)), "error": { "code": "INTERNAL", "message": "x" } }).to_string()).unwrap();
        assert_eq!(cache.get("https://a.example/", at(1)), None);
        cache.put("https://b.example/", &Cached::Preview(json!({})), at(0));
        std::fs::write(dir.path().join(CACHE_DIR).join("keep.txt"), "not ours").unwrap();
        cache.clear().unwrap();
        assert_eq!(cache.usage().0, 0);
        assert!(dir.path().join(CACHE_DIR).join("keep.txt").exists(), "only cache files are removed");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join(CACHE_DIR)).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }
}
