//! The request log of Connected apps (ADR-0021 rule 5): one JSON line per request (time, app, tool, Private Spaces,
//! page paths and how it ended; never page text or search words), in one owner-only file per day under
//! `<data>/mcp/log/`, kept 30 days.
use super::private_dir;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const LOG_DIR: &str = "log";
/// Days a day's file is kept.
pub const KEEP_DAYS: u64 = 30;
/// The most entries `read` returns (newest first).
pub const MAX_READ: usize = 500;
/// A line longer than this is not one the host wrote: skipped when read.
const MAX_LINE: usize = 64 * 1024;

pub struct Log {
    dir: Option<PathBuf>,
    /// The day whose old files were last deleted (days since 1970).
    pruned: Mutex<Option<u64>>,
}

impl Log {
    pub fn new(mcp_dir: Option<&Path>) -> Self {
        Self { dir: mcp_dir.map(|d| d.join(LOG_DIR)), pruned: Mutex::new(None) }
    }

    /// Adds one entry to today's file (UTC) and, once a day, deletes the files older than `KEEP_DAYS`. A log that
    /// cannot be written does not stop the request (it is reported nowhere else either).
    pub fn append(&self, entry: &Value) {
        let Some(dir) = &self.dir else { return };
        let today = days_now();
        if private_dir(dir).is_err() {
            return;
        }
        self.prune(dir, today);
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        if let Ok(mut file) = options.open(dir.join(file_name(today))) {
            let _ = writeln!(file, "{entry}");
        }
    }

    /// The entries of the last `KEEP_DAYS` days, newest first, at most `MAX_READ`.
    pub fn read(&self) -> Vec<Value> {
        let Some(dir) = &self.dir else { return Vec::new() };
        self.prune(dir, days_now());
        let mut days: Vec<(u64, PathBuf)> = std::fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| day_of(&e.file_name().to_string_lossy()).map(|d| (d, e.path()))).collect();
        days.sort_by(|a, b| b.0.cmp(&a.0));
        let mut out = Vec::new();
        for (_, path) in days {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            for line in text.lines().rev() {
                if line.len() > MAX_LINE {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    out.push(value);
                    if out.len() >= MAX_READ {
                        return out;
                    }
                }
            }
        }
        out
    }

    fn prune(&self, dir: &Path, today: u64) {
        let mut pruned = self.pruned.lock().unwrap_or_else(|p| p.into_inner());
        if *pruned == Some(today) {
            return;
        }
        *pruned = Some(today);
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if let Some(day) = day_of(&entry.file_name().to_string_lossy())
                && day + KEEP_DAYS <= today
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

fn days_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0)
}

fn file_name(day: u64) -> String {
    let (y, m, d) = civil(day as i64);
    format!("{y:04}-{m:02}-{d:02}.jsonl")
}

/// `YYYY-MM-DD.jsonl` → days since 1970; anything else is not a log file.
fn day_of(name: &str) -> Option<u64> {
    let stem = name.strip_suffix(".jsonl")?;
    let mut parts = stem.split('-');
    let (y, m, d) = (parts.next()?.parse::<i64>().ok()?, parts.next()?.parse::<u32>().ok()?, parts.next()?.parse::<u32>().ok()?);
    if parts.next().is_some() || stem.len() != 10 || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    u64::try_from(days_from_civil(y, m, d)).ok()
}

/// The time now as `YYYY-MM-DDTHH:MM:SSZ` (UTC).
pub fn timestamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (y, m, d) = civil((secs / 86_400) as i64);
    let s = secs % 86_400;
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", s / 3600, s / 60 % 60, s % 60)
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (Howard Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// The inverse of `civil` (Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_utc_calendar_days() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(11_016), (2000, 2, 29));
        // 2026-10-26 is day 20,752.
        assert_eq!(civil(20_752), (2026, 10, 26));
        assert_eq!(file_name(20_752), "2026-10-26.jsonl");
        assert_eq!(day_of("2026-10-26.jsonl"), Some(20_752));
        assert_eq!(day_of("2000-02-29.jsonl"), Some(11_016));
        for other in ["settings.json", "2026-13-01.jsonl", "2026-1-1.jsonl", "x-10-26.jsonl", "2026-10-26-1.jsonl"] {
            assert_eq!(day_of(other), None, "{other}");
        }
    }
}
