//! Proposed changes from connected apps (ADR-0048): kept by the host in `<data>/mcp/proposals/`, one owner-only file
//! each, never in the notes folder. A tool call only adds one here; the user reviews it in a window, which applies it
//! with compare-and-swap and then settles it here (applied, declined or conflicted).
//!
//! At most `MAX_OPEN` wait at once (pending or conflicted). One that waits `KEEP_SECS` expires. A settled one keeps
//! only what it was (no page text) for `KEEP_SECS` more, so the app can still see what happened to it.
use super::{private_dir, write_private};
use crate::error::{HostError, HostResult};
use crate::handles::new_handle;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

pub const DIR: &str = "proposals";
/// Proposals waiting for review at once, from every app.
pub const MAX_OPEN: usize = 100;
/// How long a proposal waits (then it expires), and how long a settled one is remembered: 7 days.
pub const KEEP_SECS: u64 = 7 * 86_400;
/// Settled proposals remembered at most.
const MAX_SETTLED: usize = 500;
/// The largest proposal file read back (a page before and after, at most 1 MB each, and the fields around them).
const MAX_FILE: u64 = 3 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Applied,
    Declined,
    Expired,
    Conflicted,
}

impl Status {
    /// Still waiting for the user.
    pub fn open(self) -> bool {
        matches!(self, Status::Pending | Status::Conflicted)
    }

    pub fn name(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Applied => "applied",
            Status::Declined => "declined",
            Status::Expired => "expired",
            Status::Conflicted => "conflicted",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Create,
    Edit,
    Append,
}

/// What is known of a proposal without its text.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub app: String,
    pub kind: Kind,
    /// The Private Space's canonical root, and its name as the app saw it.
    pub root: String,
    pub space: String,
    pub path: String,
    #[serde(default)]
    pub page_id: Option<String>,
    /// The page's version the proposal was made from; None: a new page (which must not exist when applied).
    #[serde(default)]
    pub base_hash: Option<String>,
    /// Seconds since 1970.
    pub created: u64,
    pub status: Status,
    #[serde(default)]
    pub settled: Option<u64>,
}

impl Record {
    /// As the windows and the app see it (times as UTC text).
    pub fn to_json(&self) -> Value {
        let mut out = json!({
            "id": self.id, "app": self.app, "kind": self.kind, "root": self.root, "space": self.space, "path": self.path,
            "pageId": self.page_id, "baseHash": self.base_hash, "status": self.status,
            "createdAt": super::log::iso(self.created),
        });
        if self.status.open() {
            out["expiresAt"] = json!(super::log::iso(self.created + KEEP_SECS));
        }
        if let Some(settled) = self.settled {
            out["settledAt"] = json!(super::log::iso(settled));
        }
        out
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    #[serde(flatten)]
    record: Record,
    /// The page when proposed (None for a new page), and the page as proposed. Dropped once settled.
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    after: Option<String>,
}

/// A proposal about to be kept.
pub struct New {
    pub app: String,
    pub kind: Kind,
    pub root: String,
    pub space: String,
    pub path: String,
    pub page_id: Option<String>,
    pub base_hash: Option<String>,
    pub before: Option<String>,
    pub after: String,
}

pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub struct Proposals {
    dir: Option<PathBuf>,
    clock: Clock,
    records: Mutex<Vec<Record>>,
}

impl Proposals {
    /// `mcp_dir` is `<data>/mcp` (None: kept in memory only, without text, so nothing can be reviewed).
    pub fn new(mcp_dir: Option<&Path>, clock: Clock) -> Self {
        let dir = mcp_dir.map(|d| d.join(DIR));
        let mut records = Vec::new();
        if let Some(dir) = &dir {
            for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(id) = name.strip_suffix(".json") else { continue };
                if !super::tools::is_proposal_id(id) {
                    continue;
                }
                if let Some(stored) = read(&entry.path())
                    && stored.record.id == id
                {
                    records.push(stored.record);
                }
            }
        }
        records.sort_by_key(|r: &Record| r.created);
        Self { dir, clock, records: Mutex::new(records) }
    }

    /// Keeps a new proposal (`BUSY` when `MAX_OPEN` already wait).
    pub fn add(&self, new: New) -> HostResult<Record> {
        let dir = self.dir.as_ref().ok_or_else(|| HostError::not_allowed("Proposals need the app data folder"))?;
        let mut records = self.records();
        self.sweep(&mut records);
        if records.iter().filter(|r| r.status.open()).count() >= MAX_OPEN {
            return Err(HostError::new(
                "BUSY",
                format!("{MAX_OPEN} proposals already wait for review in Thoth: wait until the user has reviewed some, then try again"),
            ));
        }
        let record = Record {
            id: new_handle("prop")?,
            app: new.app,
            kind: new.kind,
            root: new.root,
            space: new.space,
            path: new.path,
            page_id: new.page_id,
            base_hash: new.base_hash,
            created: (self.clock)(),
            status: Status::Pending,
            settled: None,
        };
        private_dir(dir)?;
        write(dir, &Stored { record: record.clone(), before: new.before, after: Some(new.after) })?;
        records.push(record.clone());
        Ok(record)
    }

    /// Every proposal remembered, oldest first.
    pub fn list(&self) -> Vec<Record> {
        let mut records = self.records();
        self.sweep(&mut records);
        records.clone()
    }

    /// One proposal with its text: the page when proposed and as proposed (None once settled).
    pub fn get(&self, id: &str) -> HostResult<(Record, Option<String>, Option<String>)> {
        let record = self.list().into_iter().find(|r| r.id == id).ok_or_else(|| not_found(id))?;
        if !record.status.open() {
            return Ok((record, None, None));
        }
        let stored = self.dir.as_ref().and_then(|d| read(&d.join(format!("{id}.json")))).ok_or_else(|| not_found(id))?;
        Ok((record, stored.before, stored.after))
    }

    /// The user's decision, or a window's report that the page had changed: pending → applied, declined or
    /// conflicted; conflicted → applied or declined. Applied and declined drop the text.
    pub fn settle(&self, id: &str, status: Status) -> HostResult<Record> {
        let mut records = self.records();
        self.sweep(&mut records);
        let at = records.iter().position(|r| r.id == id).ok_or_else(|| not_found(id))?;
        let from = records[at].status;
        let allowed = matches!(
            (from, status),
            (Status::Pending, Status::Applied | Status::Declined | Status::Conflicted) | (Status::Conflicted, Status::Applied | Status::Declined)
        );
        if !allowed {
            return Err(HostError::new("CONFLICT", format!("That proposal is {} already", from.name())));
        }
        let mut record = records[at].clone();
        record.status = status;
        if !status.open() {
            record.settled = Some((self.clock)());
        }
        if let Some(dir) = &self.dir {
            let path = dir.join(format!("{id}.json"));
            let (before, after) = if status.open() { read(&path).map(|s| (s.before, s.after)).unwrap_or_default() } else { (None, None) };
            write(dir, &Stored { record: record.clone(), before, after })?;
        }
        records[at] = record.clone();
        Ok(record)
    }

    /// Proposals waiting for the user.
    pub fn open(&self) -> usize {
        self.list().iter().filter(|r| r.status.open()).count()
    }

    /// Expires what waited too long, forgets what was settled long ago (and the oldest beyond `MAX_SETTLED`).
    fn sweep(&self, records: &mut Vec<Record>) {
        let now = (self.clock)();
        for record in records.iter_mut().filter(|r| r.status.open() && r.created + KEEP_SECS <= now) {
            record.status = Status::Expired;
            record.settled = Some(now);
            if let Some(dir) = &self.dir {
                let _ = write(dir, &Stored { record: record.clone(), before: None, after: None });
            }
        }
        let settled = records.iter().filter(|r| !r.status.open()).count();
        let mut over = settled.saturating_sub(MAX_SETTLED);
        records.retain(|r| {
            let old = r.settled.is_some_and(|s| s + KEEP_SECS <= now);
            let drop = !r.status.open() && (old || over > 0);
            if drop {
                over = over.saturating_sub(1);
                if let Some(dir) = &self.dir {
                    let _ = std::fs::remove_file(dir.join(format!("{}.json", r.id)));
                }
            }
            !drop
        });
    }

    fn records(&self) -> MutexGuard<'_, Vec<Record>> {
        self.records.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn not_found(id: &str) -> HostError {
    HostError::new("NOT_FOUND", format!("No proposal {id}"))
}

fn write(dir: &Path, stored: &Stored) -> HostResult<()> {
    let body = serde_json::to_vec(stored).map_err(|e| HostError::internal(format!("Could not keep the proposal: {e}")))?;
    write_private(&dir.join(format!("{}.json", stored.record.id)), &body)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn store(dir: &Path, now: Arc<AtomicU64>) -> Proposals {
        Proposals::new(Some(dir), Arc::new(move || now.load(Ordering::SeqCst)))
    }

    fn new(path: &str) -> New {
        New {
            app: "Claude".into(),
            kind: Kind::Edit,
            root: "/Notes".into(),
            space: "Notes".into(),
            path: path.into(),
            page_id: None,
            base_hash: Some("h1".into()),
            before: Some("old".into()),
            after: "new".into(),
        }
    }

    #[test]
    fn a_proposal_is_kept_in_its_own_owner_only_file_and_read_back() {
        let data = tempfile::tempdir().unwrap();
        let now = Arc::new(AtomicU64::new(1_000));
        let proposals = store(data.path(), now.clone());
        let made = proposals.add(new("Plan.md")).unwrap();
        assert!(super::super::tools::is_proposal_id(&made.id));
        let file = data.path().join(DIR).join(format!("{}.json", made.id));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(data.path().join(DIR)).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let (record, before, after) = proposals.get(&made.id).unwrap();
        assert_eq!((record.status, before.as_deref(), after.as_deref()), (Status::Pending, Some("old"), Some("new")));
        // Another start finds it.
        let again = store(data.path(), now);
        assert_eq!(again.list().len(), 1);
        assert_eq!(again.get(&made.id).unwrap().2.as_deref(), Some("new"));
    }

    #[test]
    fn settling_follows_the_rules_and_drops_the_text() {
        let data = tempfile::tempdir().unwrap();
        let proposals = store(data.path(), Arc::new(AtomicU64::new(1_000)));
        let a = proposals.add(new("A.md")).unwrap();
        assert_eq!(proposals.settle(&a.id, Status::Conflicted).unwrap().status, Status::Conflicted);
        // Still open, with its text, for the user to decline or re-apply.
        assert_eq!(proposals.get(&a.id).unwrap().2.as_deref(), Some("new"));
        assert_eq!(proposals.settle(&a.id, Status::Applied).unwrap().settled, Some(1_000));
        assert_eq!(proposals.get(&a.id).unwrap().2, None);
        let text = std::fs::read_to_string(data.path().join(DIR).join(format!("{}.json", a.id))).unwrap();
        assert!(!text.contains("\"new\"") && !text.contains("\"old\""), "{text}");
        assert_eq!(proposals.settle(&a.id, Status::Declined).unwrap_err().code, "CONFLICT");
        assert_eq!(proposals.settle(&a.id, Status::Pending).unwrap_err().code, "CONFLICT");
        assert_eq!(proposals.settle("prop_00000000000000000000000000000000", Status::Applied).unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn at_most_100_wait_and_they_expire_after_7_days() {
        let data = tempfile::tempdir().unwrap();
        let now = Arc::new(AtomicU64::new(1_000));
        let proposals = store(data.path(), now.clone());
        let first = proposals.add(new("0.md")).unwrap();
        for i in 1..MAX_OPEN {
            proposals.add(new(&format!("{i}.md"))).unwrap();
        }
        assert_eq!(proposals.add(new("one-more.md")).unwrap_err().code, "BUSY");
        // A declined one makes room.
        proposals.settle(&first.id, Status::Declined).unwrap();
        let last = proposals.add(new("one-more.md")).unwrap();
        assert_eq!(proposals.open(), MAX_OPEN);

        now.store(1_000 + KEEP_SECS, Ordering::SeqCst);
        assert_eq!(proposals.open(), 0);
        let (expired, _, after) = proposals.get(&last.id).unwrap();
        assert_eq!((expired.status, after), (Status::Expired, None));
        assert_eq!(proposals.settle(&last.id, Status::Applied).unwrap_err().code, "CONFLICT");
        // Remembered 7 more days, then forgotten, file and all.
        now.store(1_000 + 2 * KEEP_SECS, Ordering::SeqCst);
        assert!(proposals.list().is_empty());
        assert_eq!(std::fs::read_dir(data.path().join(DIR)).unwrap().count(), 0);
    }
}
