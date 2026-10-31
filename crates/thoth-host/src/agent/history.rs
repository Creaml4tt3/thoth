//! Local-only run details (ADR-0007, "History"): the streamed transcript of a run and the files it proposed, kept
//! under `<app data>/agent-history/<run id>/<name>`, so a run that waits for review can be opened again after the app
//! restarts and an earlier run's transcript and diffs can be read. They are never written inside a vault, so they are
//! never synced or backed up with it.
//!
//! The webview is untrusted (ADR-0008), so this is not a general file API:
//!
//! - A run is named by a UUID (a run record's ID), a file by a short flat name (`transcript.jsonl`, `review.json`,
//!   `change-0003.bin`): no separators, no dots at the start, no upper case. Nothing else can be named.
//! - Files are replaced atomically (a temporary file in the same folder, then a rename).
//! - Size is bounded: per file, per run, and in the number of runs and files, so a forged caller cannot fill the disk.
//! - Reading refuses anything that is not a regular file.
//!
//! Pruning (by age) is the webview's job, because only it knows the retention setting and which runs still wait for
//! review; the host lists what exists (with each run's last change time) and deletes what it is told to.
use super::{Agents, HostError, HostResult};
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const HISTORY_DIR: &str = "agent-history";

/// What the history may hold. The defaults suit real use; tests pass smaller ones.
#[derive(Clone, Copy, Debug)]
pub struct HistoryLimits {
    pub max_file_bytes: u64,
    pub max_run_bytes: u64,
    pub max_runs: usize,
    pub max_files_per_run: usize,
}

pub const LIMITS: HistoryLimits = HistoryLimits { max_file_bytes: 64 * 1024 * 1024, max_run_bytes: 512 * 1024 * 1024, max_runs: 2000, max_files_per_run: 4096 };

/// A UUID in its canonical lower-case form (run records are named by UUIDv7).
pub fn is_run_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 36 && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_digit() || (b'a'..=b'f').contains(c) })
}

/// A flat file name: 1 to 64 of `a-z 0-9 . _ -`, not starting with a dot.
pub fn is_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
}

fn io(e: &std::io::Error, op: &str, path: &Path) -> HostError {
    HostError::io(e, op, &path.to_string_lossy())
}

fn private_dir(dir: &Path) -> HostResult<()> {
    std::fs::create_dir_all(dir).map_err(|e| io(&e, "mkdir", dir))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| io(&e, "chmod", dir))?;
    }
    Ok(())
}

fn check_ids(id: &str, name: Option<&str>) -> HostResult<()> {
    if !is_run_id(id) {
        return Err(HostError::bad_argument("A run ID is a lower-case UUID"));
    }
    if let Some(name) = name
        && !is_file_name(name)
    {
        return Err(HostError::bad_argument("A history file name is 1 to 64 of a-z 0-9 . _ - and does not start with a dot"));
    }
    Ok(())
}

/// The regular files of one run folder: (name, size, modified in ms since the epoch).
fn files_of(dir: &Path) -> HostResult<Vec<(String, u64, u64)>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| io(&e, "scandir", dir))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
        if !meta.is_file() || !is_file_name(&name) {
            continue;
        }
        let modified =
            meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        out.push((name, meta.len(), modified));
    }
    out.sort();
    Ok(out)
}

/// Writes `name` of run `id` under `root` (replacing it), within `limits`.
pub fn write_file(root: &Path, id: &str, name: &str, data: &[u8], limits: HistoryLimits) -> HostResult<()> {
    check_ids(id, Some(name))?;
    if data.len() as u64 > limits.max_file_bytes {
        return Err(HostError::bad_argument("That history file is too large"));
    }
    private_dir(root)?;
    let dir = root.join(id);
    if !dir.exists() {
        let runs = std::fs::read_dir(root).map_err(|e| io(&e, "scandir", root))?.flatten().filter(|e| is_run_id(&e.file_name().to_string_lossy())).count();
        if runs >= limits.max_runs {
            return Err(HostError::not_allowed("Too many runs in the history; delete some first"));
        }
    }
    private_dir(&dir)?;
    let existing = files_of(&dir)?;
    let others: u64 = existing.iter().filter(|(n, ..)| n != name).map(|(_, size, _)| size).sum();
    let count = existing.iter().filter(|(n, ..)| n != name).count();
    if others + data.len() as u64 > limits.max_run_bytes || count >= limits.max_files_per_run {
        return Err(HostError::not_allowed("This run's history is full"));
    }
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|e| HostError::internal(format!("No randomness: {e}")))?;
    let temp = dir.join(format!(".tmp-{}", random.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| io(&e, "open", &temp))?;
        file.write_all(data).map_err(|e| io(&e, "write", &temp))?;
        file.sync_all().map_err(|e| io(&e, "fsync", &temp))?;
        drop(file);
        std::fs::rename(&temp, dir.join(name)).map_err(|e| io(&e, "rename", &temp))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// The bytes of `name` of run `id` (`ENOENT` when there is no such file).
pub fn read_file(root: &Path, id: &str, name: &str, limits: HistoryLimits) -> HostResult<Vec<u8>> {
    check_ids(id, Some(name))?;
    let path = root.join(id).join(name);
    let meta = std::fs::symlink_metadata(&path).map_err(|e| io(&e, "lstat", &path))?;
    if !meta.is_file() {
        return Err(HostError::unsafe_path(name, "not a regular file"));
    }
    if meta.len() > limits.max_file_bytes {
        return Err(HostError::not_allowed("That history file is too large"));
    }
    std::fs::read(&path).map_err(|e| io(&e, "read", &path))
}

/// Every run folder: `{ id, modifiedMs, bytes, files: [{ name, size }] }`, oldest first. Other entries are ignored.
pub fn list_runs(root: &Path) -> HostResult<Value> {
    let Ok(meta) = std::fs::symlink_metadata(root) else { return Ok(json!([])) };
    if !meta.is_dir() {
        return Ok(json!([]));
    }
    let mut runs = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| io(&e, "scandir", root))?.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        if !is_run_id(&id) || !std::fs::symlink_metadata(entry.path()).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let files = files_of(&entry.path())?;
        let modified = files.iter().map(|(_, _, m)| *m).max().unwrap_or(0);
        let bytes: u64 = files.iter().map(|(_, s, _)| s).sum();
        runs.push((modified, id, bytes, files));
    }
    runs.sort();
    Ok(Value::Array(
        runs.into_iter().map(|(modified, id, bytes, files)| json!({ "id": id, "modifiedMs": modified, "bytes": bytes, "files": files.iter().map(|(name, size, _)| json!({ "name": name, "size": size })).collect::<Vec<_>>() })).collect(),
    ))
}

/// Deletes run `id`'s folder. Idempotent. `remove_dir_all` does not follow symlinks.
pub fn delete_run(root: &Path, id: &str) -> HostResult<()> {
    check_ids(id, None)?;
    let dir = root.join(id);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(&e, "rm", &dir)),
    }
}

impl Agents {
    fn history_root(&self) -> HostResult<PathBuf> {
        let data = self.data_dir.as_ref().ok_or_else(|| HostError::not_allowed("The run history needs the app data folder"))?;
        Ok(data.join(HISTORY_DIR))
    }

    /// Creates or replaces one file of a run's local details.
    pub fn history_write(&self, id: &str, name: &str, data: &[u8]) -> HostResult<()> {
        write_file(&self.history_root()?, id, name, data, LIMITS)
    }

    pub fn history_read(&self, id: &str, name: &str) -> HostResult<Vec<u8>> {
        read_file(&self.history_root()?, id, name, LIMITS)
    }

    /// Without an app data folder there is no history: the list is empty rather than an error.
    pub fn history_list(&self) -> HostResult<Value> {
        match &self.data_dir {
            Some(data) => list_runs(&data.join(HISTORY_DIR)),
            None => Ok(json!([])),
        }
    }

    pub fn history_delete(&self, id: &str) -> HostResult<()> {
        delete_run(&self.history_root()?, id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "019e0000-0000-7000-8000-000000000001";
    const OTHER: &str = "019e0000-0000-7000-8000-000000000002";
    const SMALL: HistoryLimits = HistoryLimits { max_file_bytes: 10, max_run_bytes: 16, max_runs: 2, max_files_per_run: 3 };

    #[test]
    fn names_are_uuids_and_flat_files() {
        assert!(is_run_id(ID));
        for bad in [
            "",
            "run_0123",
            "019E0000-0000-7000-8000-000000000001",
            "019e0000-0000-7000-8000-00000000000",
            "../019e0000-0000-7000-8000-000000000001",
            "019e0000_0000-7000-8000-000000000001",
        ] {
            assert!(!is_run_id(bad), "{bad}");
        }
        for good in ["transcript.jsonl", "review.json", "change-0003.bin", "a", "x_y-z.0"] {
            assert!(is_file_name(good), "{good}");
        }
        for bad in ["", ".hidden", "a/b", "..", "A.md", "a b", "a\\b", "é", &"x".repeat(65)] {
            assert!(!is_file_name(bad), "{bad}");
        }
    }

    #[test]
    fn writes_reads_lists_and_deletes() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().join("agent-history");
        write_file(&root, ID, "review.json", b"{}", LIMITS).unwrap();
        write_file(&root, ID, "transcript.jsonl", b"one\n", LIMITS).unwrap();
        write_file(&root, ID, "transcript.jsonl", b"one\ntwo\n", LIMITS).unwrap(); // replaces
        assert_eq!(read_file(&root, ID, "transcript.jsonl", LIMITS).unwrap(), b"one\ntwo\n");
        let listed = list_runs(&root).unwrap();
        assert_eq!(listed[0]["id"], json!(ID));
        assert_eq!(listed[0]["bytes"], json!(10));
        assert_eq!(listed[0]["files"], json!([{ "name": "review.json", "size": 2 }, { "name": "transcript.jsonl", "size": 8 }]));
        assert_eq!(read_file(&root, ID, "nope.bin", LIMITS).unwrap_err().code, "ENOENT");
        // No temporary file is left behind.
        assert!(std::fs::read_dir(root.join(ID)).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".tmp")));
        delete_run(&root, ID).unwrap();
        delete_run(&root, ID).unwrap();
        assert_eq!(list_runs(&root).unwrap(), json!([]));
    }

    #[test]
    fn refuses_anything_that_is_not_a_run_or_a_flat_file_name() {
        let root = tempfile::tempdir().unwrap();
        for (id, name) in [("../x", "a.bin"), (ID, "../a.bin"), (ID, "a/b.bin"), (ID, ".hidden"), ("", "a.bin"), (ID, "")] {
            assert_eq!(write_file(root.path(), id, name, b"x", LIMITS).unwrap_err().code, "BAD_ARGUMENT", "{id} {name}");
            assert_eq!(read_file(root.path(), id, name, LIMITS).unwrap_err().code, "BAD_ARGUMENT", "{id} {name}");
        }
        assert_eq!(delete_run(root.path(), "../x").unwrap_err().code, "BAD_ARGUMENT");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn bounds_files_runs_and_bytes() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(write_file(root.path(), ID, "a.bin", &[0; 11], SMALL).unwrap_err().code, "BAD_ARGUMENT");
        write_file(root.path(), ID, "a.bin", &[0; 10], SMALL).unwrap();
        assert_eq!(write_file(root.path(), ID, "b.bin", &[0; 7], SMALL).unwrap_err().code, "NOT_ALLOWED"); // 17 > 16 bytes
        write_file(root.path(), ID, "a.bin", &[0; 4], SMALL).unwrap(); // replacing does not count twice
        write_file(root.path(), ID, "b.bin", &[0; 6], SMALL).unwrap();
        write_file(root.path(), ID, "c.bin", &[0; 1], SMALL).unwrap();
        assert_eq!(write_file(root.path(), ID, "d.bin", &[0; 1], SMALL).unwrap_err().code, "NOT_ALLOWED"); // a fourth file
        write_file(root.path(), OTHER, "a.bin", b"x", SMALL).unwrap();
        let third = "019e0000-0000-7000-8000-000000000003";
        assert_eq!(write_file(root.path(), third, "a.bin", b"x", SMALL).unwrap_err().code, "NOT_ALLOWED"); // a third run
        assert!(!root.path().join(third).exists());
    }

    #[cfg(unix)]
    #[test]
    fn will_not_read_through_a_symlink() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), b"secret").unwrap();
        std::fs::create_dir_all(root.path().join(ID)).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join(ID).join("review.json")).unwrap();
        assert_eq!(read_file(root.path(), ID, "review.json", LIMITS).unwrap_err().code, "UNSAFE_PATH");
        // A link is not listed as a file either.
        assert_eq!(list_runs(root.path()).unwrap()[0]["files"], json!([]));
    }
}
