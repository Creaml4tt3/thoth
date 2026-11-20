//! The OCR module's files on disk (ADR-0055, plan §5):
//!
//! ```text
//! <app-data>/modules/ocr/state.json                 { "autoUpdate": false, "serial": 0, "active": {...}, "previous": {...} }
//! <app-data>/modules/ocr/runtime/<version>/         thoth-ocr, ONNX Runtime, NOTICE.txt, files.json
//! <app-data>/modules/ocr/models/<fast|second>/<version>/
//! ```
//!
//! A download goes to `<version>.part/`: each `.gz` is hashed while it streams and decompressed only after its SHA-256
//! matches. The finished folder is renamed to `<version>/` and becomes active; the previous one is kept until
//! `forget_previous` (after the new one read the test image). `files.json` records the SHA-256 of each decompressed
//! file, which `verify` checks again before each run. Stale `.part` folders are removed when the store opens.
use super::catalog::{ModelId, ModuleFile, plain_name};
use crate::error::{HostError, HostResult};
use crate::install::Failure;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

/// Where a set of files goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Dest {
    Runtime,
    Model(ModelId),
}

/// Opens a URL for reading, at most `max` bytes (the listed size). The real one is `links::fetch`'s fetcher.
pub trait Fetch: Send + Sync {
    fn open(&self, url: &str, max: u64) -> Result<Box<dyn Read + Send>, Failure>;
}

/// A finished download, not active yet.
#[derive(Debug, PartialEq, Eq)]
pub struct Staged {
    pub dest: Dest,
    pub version: String,
    pub path: PathBuf,
}

/// What is installed: each part's active version and its bytes on disk.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Installed {
    pub runtime: Option<String>,
    pub fast: Option<String>,
    pub second: Option<String>,
    pub bytes: u64,
}

pub struct Store {
    root: PathBuf,
    /// One change to `state.json` at a time.
    lock: Mutex<()>,
}

/// `state.json`. Unknown or broken: the defaults (nothing active, auto-update off).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct State {
    auto_update: bool,
    serial: u64,
    /// Active version per dest key (`runtime`, `fast`, `second`).
    active: BTreeMap<String, String>,
    /// The version kept until the new one passed its test.
    previous: BTreeMap<String, String>,
}

impl Dest {
    fn key(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::Model(id) => id.as_str(),
        }
    }
}

const STATE: &str = "state.json";
const FILES: &str = "files.json";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn disk(e: &std::io::Error) -> Failure {
    if e.kind() == std::io::ErrorKind::StorageFull { Failure::Disk } else { Failure::Failed }
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn folder_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => folder_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

impl Store {
    /// The store at `root` (`<app-data>/modules/ocr`); removes stale `.part` folders.
    pub fn open(root: PathBuf) -> Store {
        let store = Store { root, lock: Mutex::new(()) };
        for dir in [store.root.join("runtime"), store.root.join("models/fast"), store.root.join("models/second")] {
            for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                if e.path().extension().is_some_and(|x| x == "part") {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
        store
    }

    fn dir(&self, dest: Dest) -> PathBuf {
        match dest {
            Dest::Runtime => self.root.join("runtime"),
            Dest::Model(id) => self.root.join("models").join(id.as_str()),
        }
    }

    fn state(&self) -> State {
        std::fs::read(self.root.join(STATE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn change(&self, f: impl FnOnce(&mut State)) -> HostResult<()> {
        let _one = locked(&self.lock);
        let mut state = self.state();
        f(&mut state);
        std::fs::create_dir_all(&self.root).map_err(|e| HostError::io(&e, "mkdir", "modules"))?;
        let mut tmp = tempfile::NamedTempFile::new_in(&self.root).map_err(|e| HostError::io(&e, "write", STATE))?;
        tmp.write_all(serde_json::to_string(&state).unwrap_or_default().as_bytes()).map_err(|e| HostError::io(&e, "write", STATE))?;
        tmp.persist(self.root.join(STATE)).map_err(|e| HostError::io(&e.error, "rename", STATE))?;
        Ok(())
    }

    pub fn installed(&self) -> Installed {
        let state = self.state();
        let get = |k: &str| state.active.get(k).cloned();
        Installed {
            runtime: get("runtime"),
            fast: get("fast"),
            second: get("second"),
            bytes: folder_size(&self.root.join("runtime")) + folder_size(&self.root.join("models")),
        }
    }

    /// Bytes on disk of one model's folder (every version kept).
    pub fn model_bytes(&self, id: ModelId) -> u64 {
        folder_size(&self.dir(Dest::Model(id)))
    }

    pub fn auto_update(&self) -> bool {
        self.state().auto_update
    }

    pub fn set_auto_update(&self, on: bool) -> HostResult<()> {
        self.change(|s| s.auto_update = on)
    }

    /// The serial of the last signed list read (0: none).
    pub fn serial(&self) -> u64 {
        self.state().serial
    }

    pub fn set_serial(&self, serial: u64) -> HostResult<()> {
        self.change(|s| s.serial = s.serial.max(serial))
    }

    /// The active folder of `dest`, if any.
    pub fn active(&self, dest: Dest) -> Option<PathBuf> {
        self.state().active.get(dest.key()).map(|v| self.dir(dest).join(v))
    }

    /// Downloads `files` (version `version`) for `dest` into a `.part` folder and renames it to the version's folder.
    /// Nothing is left behind on failure.
    pub fn install(
        &self,
        dest: Dest,
        version: &str,
        files: &[ModuleFile],
        fetch: &dyn Fetch,
        progress: &mut dyn FnMut(u64, Option<u64>),
        cancel: &AtomicBool,
    ) -> Result<Staged, Failure> {
        plain_name(version).map_err(|_| Failure::Verify)?;
        for f in files {
            plain_name(&f.name).map_err(|_| Failure::Verify)?;
        }
        let dir = self.dir(dest);
        let part = dir.join(format!("{version}.part"));
        let _ = std::fs::remove_dir_all(&part);
        std::fs::create_dir_all(&part).map_err(|e| disk(&e))?;
        let result = self.download(&part, files, fetch, progress, cancel).and_then(|()| {
            let path = dir.join(version);
            // Installing the active version again (a repair) is refused: it would replace files in use.
            if self.state().active.get(dest.key()).is_some_and(|v| v == version) {
                return Err(Failure::Failed);
            }
            let _ = std::fs::remove_dir_all(&path);
            std::fs::rename(&part, &path).map_err(|e| disk(&e))?;
            Ok(Staged { dest, version: version.to_owned(), path })
        });
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&part);
        }
        result
    }

    fn download(
        &self,
        part: &Path,
        files: &[ModuleFile],
        fetch: &dyn Fetch,
        progress: &mut dyn FnMut(u64, Option<u64>),
        cancel: &AtomicBool,
    ) -> Result<(), Failure> {
        let total: u64 = files.iter().map(|f| f.size).sum();
        let mut received = 0u64;
        let mut hashes = BTreeMap::new();
        progress(0, Some(total));
        for f in files {
            let gz_path = part.join(format!("{}.gz", f.name));
            let mut reader = fetch.open(&f.url, f.size)?;
            let mut out = std::fs::File::create(&gz_path).map_err(|e| disk(&e))?;
            let mut hash = Sha256::new();
            let mut got = 0u64;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err(Failure::Cancelled);
                }
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => return Err(Failure::Offline),
                };
                got += n as u64;
                if got > f.size {
                    return Err(Failure::Verify);
                }
                hash.update(&buf[..n]);
                out.write_all(&buf[..n]).map_err(|e| disk(&e))?;
                received += n as u64;
                progress(received, Some(total));
            }
            if cancel.load(Ordering::SeqCst) {
                return Err(Failure::Cancelled);
            }
            out.sync_all().map_err(|e| disk(&e))?;
            drop(out);
            if got != f.size || !hex(&hash.finalize()).eq_ignore_ascii_case(&f.sha256) {
                return Err(Failure::Verify);
            }
            // Only now, with the .gz checked, is it decompressed.
            let plain = part.join(&f.name);
            let mut decoder = flate2::read::GzDecoder::new(std::fs::File::open(&gz_path).map_err(|e| disk(&e))?);
            let mut file = std::fs::File::create(&plain).map_err(|e| disk(&e))?;
            let mut hash = Sha256::new();
            loop {
                let n = decoder.read(&mut buf).map_err(|_| Failure::Verify)?;
                if n == 0 {
                    break;
                }
                hash.update(&buf[..n]);
                file.write_all(&buf[..n]).map_err(|e| disk(&e))?;
            }
            file.sync_all().map_err(|e| disk(&e))?;
            #[cfg(unix)]
            if f.executable {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755)).map_err(|e| disk(&e))?;
            }
            let _ = std::fs::remove_file(&gz_path);
            hashes.insert(f.name.clone(), hex(&hash.finalize()));
        }
        std::fs::write(part.join(FILES), serde_json::to_vec(&hashes).unwrap_or_default()).map_err(|e| disk(&e))
    }

    /// Makes `staged` the active version; the one active before stays on disk as the previous.
    pub fn activate(&self, staged: &Staged) -> HostResult<()> {
        let key = staged.dest.key();
        let mut dropped = None;
        self.change(|s| {
            if let Some(old) = s.active.insert(key.to_owned(), staged.version.clone()).filter(|old| *old != staged.version) {
                // Only one previous is kept: an older one still waiting goes now.
                dropped = s.previous.insert(key.to_owned(), old).filter(|p| *p != staged.version);
            }
        })?;
        if let Some(old) = dropped {
            let _ = std::fs::remove_dir_all(self.dir(staged.dest).join(old));
        }
        Ok(())
    }

    /// Goes back to the previous version after `staged` failed its test image, and deletes `staged`.
    pub fn roll_back(&self, staged: &Staged) -> HostResult<()> {
        let key = staged.dest.key();
        self.change(|s| {
            if s.active.get(key) == Some(&staged.version) {
                match s.previous.remove(key) {
                    Some(previous) => s.active.insert(key.to_owned(), previous),
                    None => s.active.remove(key),
                };
            }
        })?;
        std::fs::remove_dir_all(&staged.path).map_err(|e| HostError::io(&e, "remove", &staged.version))
    }

    /// Deletes the previous version of `dest`.
    pub fn forget_previous(&self, dest: Dest) -> HostResult<()> {
        let mut gone = None;
        self.change(|s| gone = s.previous.remove(dest.key()))?;
        if let Some(old) = gone {
            std::fs::remove_dir_all(self.dir(dest).join(&old)).map_err(|e| HostError::io(&e, "remove", &old))?;
        }
        Ok(())
    }

    /// Deletes a model, and the runtime with the last one.
    pub fn remove(&self, id: ModelId) -> HostResult<()> {
        let mut last = false;
        self.change(|s| {
            s.active.remove(id.as_str());
            s.previous.remove(id.as_str());
            last = !s.active.contains_key("fast") && !s.active.contains_key("second");
            if last {
                s.active.remove("runtime");
                s.previous.remove("runtime");
            }
        })?;
        let remove = |dir: PathBuf| match std::fs::remove_dir_all(&dir) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(HostError::io(&e, "remove", id.as_str())),
            _ => Ok(()),
        };
        remove(self.dir(Dest::Model(id)))?;
        if last {
            remove(self.dir(Dest::Runtime))?;
            let _ = std::fs::remove_dir(self.root.join("models"));
        }
        Ok(())
    }

    /// Hashes every file of `dest`'s active version again against `files.json`.
    pub fn verify(&self, dest: Dest) -> HostResult<()> {
        let changed = || HostError::new("OCR_FAILED", "The OCR files changed on disk. Remove OCR and download it again.");
        let dir = self.active(dest).ok_or_else(|| HostError::new("OCR_NOT_INSTALLED", "OCR isn't downloaded yet"))?;
        let hashes: BTreeMap<String, String> = std::fs::read(dir.join(FILES)).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or_else(changed)?;
        for (name, want) in hashes {
            plain_name(&name).map_err(|_| changed())?;
            let mut file = std::fs::File::open(dir.join(&name)).map_err(|_| changed())?;
            let mut hash = Sha256::new();
            std::io::copy(&mut file, &mut hash).map_err(|_| changed())?;
            if hex(&hash.finalize()) != want {
                return Err(changed());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::collections::HashMap;

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut e = GzEncoder::new(Vec::new(), Compression::default());
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    /// Serves `.gz` bodies by URL; `cut` ends a body early, `cancel_after` sets the flag after that many reads.
    #[derive(Default)]
    struct FakeFetch {
        bodies: HashMap<String, Vec<u8>>,
        cut: Option<String>,
        offline: bool,
        opened: Mutex<Vec<String>>,
    }

    impl Fetch for FakeFetch {
        fn open(&self, url: &str, _max: u64) -> Result<Box<dyn Read + Send>, Failure> {
            self.opened.lock().unwrap().push(url.to_owned());
            if self.offline {
                return Err(Failure::Offline);
            }
            let mut body = self.bodies.get(url).cloned().ok_or(Failure::Failed)?;
            if self.cut.as_deref() == Some(url) {
                body.truncate(body.len() / 2);
            }
            Ok(Box::new(std::io::Cursor::new(body)))
        }
    }

    /// Files named `names`, each with its own text, listed with the right size and hash.
    fn files(fetch: &mut FakeFetch, version: &str, names: &[&str]) -> Vec<ModuleFile> {
        names
            .iter()
            .map(|n| {
                let url = format!("https://download.thothnotes.com/modules/models/fast/{version}/{n}.gz");
                let body = gz(format!("{n} of {version}").as_bytes());
                let file = ModuleFile { name: (*n).into(), url: url.clone(), size: body.len() as u64, sha256: sha(&body), targets: None, executable: false };
                fetch.bodies.insert(url, body);
                file
            })
            .collect()
    }

    fn no_progress() -> impl FnMut(u64, Option<u64>) {
        |_, _| {}
    }

    fn parts(root: &Path) -> Vec<PathBuf> {
        fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
            for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "part") {
                    out.push(p.clone());
                }
                if p.is_dir() {
                    walk(&p, out);
                }
            }
        }
        let mut out = Vec::new();
        walk(root, &mut out);
        out
    }

    const FAST: Dest = Dest::Model(ModelId::Fast);

    fn installed(store: &Store, fetch: &FakeFetch, version: &str, files: &[ModuleFile]) -> Staged {
        let staged = store.install(FAST, version, files, fetch, &mut no_progress(), &AtomicBool::new(false)).unwrap();
        store.activate(&staged).unwrap();
        staged
    }

    #[test]
    fn installs_checks_and_activates() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf());
        let mut fetch = FakeFetch::default();
        let list = files(&mut fetch, "v1", &["det.onnx", "rec.onnx"]);
        let mut seen = Vec::new();
        let staged = store.install(FAST, "v1", &list, &fetch, &mut |r, t| seen.push((r, t)), &AtomicBool::new(false)).unwrap();
        let total: u64 = list.iter().map(|f| f.size).sum();
        assert_eq!(seen.last(), Some(&(total, Some(total))));
        store.activate(&staged).unwrap();
        let active = store.active(FAST).unwrap();
        assert_eq!(std::fs::read_to_string(active.join("det.onnx")).unwrap(), "det.onnx of v1");
        assert_eq!(store.installed().fast.as_deref(), Some("v1"));
        assert!(store.installed().bytes > 0);
        store.verify(FAST).unwrap();
    }

    #[test]
    fn a_hash_mismatch_keeps_the_installed_version_and_leaves_no_part_folder() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf());
        let mut fetch = FakeFetch::default();
        let v1 = files(&mut fetch, "v1", &["det.onnx"]);
        installed(&store, &fetch, "v1", &v1);
        let mut v2 = files(&mut fetch, "v2", &["det.onnx", "rec.onnx"]);
        v2[1].sha256 = "0".repeat(64);
        let err = store.install(FAST, "v2", &v2, &fetch, &mut no_progress(), &AtomicBool::new(false)).unwrap_err();
        assert_eq!(err, Failure::Verify);
        assert_eq!(store.installed().fast.as_deref(), Some("v1"));
        assert!(parts(dir.path()).is_empty());
        assert!(!dir.path().join("models/fast/v2").exists());
        // A download cut short is a verify failure too, never a half file.
        let mut fetch = FakeFetch { cut: Some(v2[0].url.clone()), ..fetch };
        v2 = files(&mut fetch, "v2", &["det.onnx", "rec.onnx"]);
        assert!(store.install(FAST, "v2", &v2, &fetch, &mut no_progress(), &AtomicBool::new(false)).is_err());
        assert!(parts(dir.path()).is_empty());
        store.verify(FAST).unwrap();
    }

    #[test]
    fn a_cancelled_download_leaves_no_part_folder() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf());
        let mut fetch = FakeFetch::default();
        let list = files(&mut fetch, "v1", &["det.onnx", "rec.onnx"]);
        let cancel = AtomicBool::new(false);
        let err = store.install(FAST, "v1", &list, &fetch, &mut |_, _| cancel.store(true, Ordering::SeqCst), &cancel).unwrap_err();
        assert_eq!(err, Failure::Cancelled);
        assert!(parts(dir.path()).is_empty());
        assert_eq!(store.installed().fast, None);
    }

    #[test]
    fn activate_keeps_the_previous_until_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf());
        let mut fetch = FakeFetch::default();
        let v1 = files(&mut fetch, "v1", &["det.onnx"]);
        installed(&store, &fetch, "v1", &v1);
        let v2 = files(&mut fetch, "v2", &["det.onnx"]);
        installed(&store, &fetch, "v2", &v2);
        assert_eq!(store.installed().fast.as_deref(), Some("v2"));
        assert!(dir.path().join("models/fast/v1").is_dir());
        store.forget_previous(FAST).unwrap();
        assert!(!dir.path().join("models/fast/v1").exists());
        assert!(dir.path().join("models/fast/v2").is_dir());
    }

    #[test]
    fn a_failed_test_rolls_back_to_the_previous() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf());
        let mut fetch = FakeFetch::default();
        let v1 = files(&mut fetch, "v1", &["det.onnx"]);
        installed(&store, &fetch, "v1", &v1);
        let v2 = files(&mut fetch, "v2", &["det.onnx"]);
        let staged = installed(&store, &fetch, "v2", &v2);
        store.roll_back(&staged).unwrap();
        assert_eq!(store.installed().fast.as_deref(), Some("v1"));
        assert!(!dir.path().join("models/fast/v2").exists());
        store.verify(FAST).unwrap();
    }

    #[test]
    fn remove_deletes_only_that_model_and_the_runtime_with_the_last() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf());
        let mut fetch = FakeFetch::default();
        let list = files(&mut fetch, "v1", &["det.onnx"]);
        for dest in [Dest::Runtime, FAST, Dest::Model(ModelId::Second)] {
            let s = store.install(dest, "v1", &list, &fetch, &mut no_progress(), &AtomicBool::new(false)).unwrap();
            store.activate(&s).unwrap();
        }
        store.remove(ModelId::Fast).unwrap();
        let i = store.installed();
        assert_eq!((i.runtime.as_deref(), i.fast.as_deref(), i.second.as_deref()), (Some("v1"), None, Some("v1")));
        assert!(!dir.path().join("models/fast").exists());
        store.remove(ModelId::Second).unwrap();
        assert_eq!(store.installed(), Installed::default());
        assert!(!dir.path().join("runtime").exists());
    }

    #[test]
    fn stale_part_folders_are_removed_on_start() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("models/fast/v3.part")).unwrap();
        std::fs::write(dir.path().join("models/fast/v3.part/det.onnx.gz"), b"half").unwrap();
        std::fs::create_dir_all(dir.path().join("runtime/0.1.0.part")).unwrap();
        let _store = Store::open(dir.path().to_path_buf());
        assert!(parts(dir.path()).is_empty());
    }

    #[test]
    fn verify_fails_after_a_file_is_changed() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf());
        let mut fetch = FakeFetch::default();
        let list = files(&mut fetch, "v1", &["det.onnx"]);
        installed(&store, &fetch, "v1", &list);
        std::fs::write(store.active(FAST).unwrap().join("det.onnx"), b"changed").unwrap();
        assert!(store.verify(FAST).is_err());
        std::fs::remove_file(store.active(FAST).unwrap().join("det.onnx")).unwrap();
        assert!(store.verify(FAST).is_err());
    }

    #[test]
    fn offline_start_uses_what_is_installed() {
        let dir = tempfile::tempdir().unwrap();
        let mut fetch = FakeFetch::default();
        let list = files(&mut fetch, "v1", &["det.onnx"]);
        {
            let store = Store::open(dir.path().to_path_buf());
            installed(&store, &fetch, "v1", &list);
            store.set_auto_update(true).unwrap();
            store.set_serial(7).unwrap();
        }
        let store = Store::open(dir.path().to_path_buf());
        let offline = FakeFetch { offline: true, ..FakeFetch::default() };
        assert_eq!(store.install(FAST, "v2", &list, &offline, &mut no_progress(), &AtomicBool::new(false)), Err(Failure::Offline));
        assert_eq!(store.installed().fast.as_deref(), Some("v1"));
        assert!(store.auto_update());
        assert_eq!(store.serial(), 7);
        store.verify(FAST).unwrap();
    }

    #[test]
    fn refuses_an_unsafe_version_or_name() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf());
        let mut fetch = FakeFetch::default();
        let mut list = files(&mut fetch, "v1", &["det.onnx"]);
        assert!(store.install(FAST, "../x", &list, &fetch, &mut no_progress(), &AtomicBool::new(false)).is_err());
        list[0].name = "../evil".into();
        assert!(store.install(FAST, "v1", &list, &fetch, &mut no_progress(), &AtomicBool::new(false)).is_err());
        assert!(!dir.path().join("models/evil").exists());
    }
}
