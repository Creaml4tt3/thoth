//! Modules (ADR-0055, plan §5): large local features downloaded on demand. OCR is the first and only one.
//!
//! - `catalog`: what can be installed. The program files come from `runtime.json`, compiled into the app (code changes
//!   only with an app update); the models from the signed model list, with a compiled-in copy as the fallback.
//! - `store`: downloads, checks and switches the files under `<app-data>/modules/ocr/`.
//! - `runner`: runs `thoth-ocr` per job as a supervised child.
//!
//! `Modules` is what the `module.*` and `ocr.*` commands call. Nothing is downloaded unless the person clicks Download
//! (or turned on automatic model updates and a model is installed). Images and PDFs never leave the computer.
pub mod catalog;
pub mod runner;
pub mod store;

use crate::error::{HostError, HostResult};
use crate::install::Failure;
use crate::links::fetch::{Fetcher, Lookup, SystemLookup, Want};
use crate::updates::Version;
use catalog::{Catalog, ModelId, ModuleFile, for_target};
use runner::{Kind, Program, Runner};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use store::{Dest, Fetch, Store};

/// This build's target, as `runtime.json` and the model list name it.
pub const TARGET: &str = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    "aarch64-apple-darwin"
} else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
    "x86_64-apple-darwin"
} else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
    "x86_64-pc-windows-msvc"
} else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
    "x86_64-unknown-linux-gnu"
} else {
    "unsupported"
};

pub const PROGRESS_EVENT: &str = "module.progress";
pub const OCR_PROGRESS_EVENT: &str = "ocr.progress";
/// The longest a module download may take, all files together.
const DOWNLOAD_TIME: Duration = Duration::from_secs(30 * 60);
/// The signed list and its signature are small.
const MAX_LIST: usize = 256 * 1024;
const TEST_FILE: &str = "ocr-test.png";

/// The program files under the runtime folder.
const EXE: &str = if cfg!(windows) { "thoth-ocr.exe" } else { "thoth-ocr" };
const ORT: &str = if cfg!(windows) {
    "onnxruntime.dll"
} else if cfg!(target_os = "macos") {
    "libonnxruntime.dylib"
} else {
    "libonnxruntime.so"
};

type Sink = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// The real downloads: `links::fetch`'s fetcher, https only, public addresses, capped at the listed size.
pub struct HttpFetch {
    fetcher: Fetcher,
    user_agent: String,
}

impl HttpFetch {
    pub fn new(app: &str, lookup: Arc<dyn Lookup>, allow_loopback: bool) -> Self {
        Self { fetcher: Fetcher { lookup, allow_loopback }, user_agent: format!("Thoth/{app} (modules)") }
    }

    fn small(&self, url: &str) -> Option<Vec<u8>> {
        let want = Want { accept: "*/*", user_agent: &self.user_agent, https_only: true, max: MAX_LIST, stop_at_head: false, refuse_longer: true };
        self.fetcher.get(&url::Url::parse(url).ok()?, Instant::now() + crate::links::fetch::TIMEOUT, &want).ok().map(|f| f.body)
    }
}

impl Fetch for HttpFetch {
    fn open(&self, url: &str, max: u64) -> Result<Box<dyn std::io::Read + Send>, Failure> {
        let url = url::Url::parse(url).map_err(|_| Failure::Verify)?;
        let want = Want { accept: "*/*", user_agent: &self.user_agent, https_only: true, max: max as usize, stop_at_head: false, refuse_longer: true };
        self.fetcher.open(&url, Instant::now() + DOWNLOAD_TIME, &want).map(|(_, _, r)| r).map_err(|e| match e.code {
            "NOT_ALLOWED" => Failure::Verify,
            _ => Failure::Offline,
        })
    }
}

/// What a fetcher of the signed list gives: `models.json` and its `.sig`.
pub trait ListSource: Send + Sync {
    fn list(&self) -> Option<(Vec<u8>, String)>;
}

impl ListSource for HttpFetch {
    fn list(&self) -> Option<(Vec<u8>, String)> {
        let json = self.small(catalog::LIST_URL)?;
        let sig = String::from_utf8(self.small(&format!("{}.sig", catalog::LIST_URL))?).ok()?;
        Some((json, sig))
    }
}

/// Runs the list's test image through a newly installed model: true when every expected phrase is in the text.
type Tester = Arc<dyn Fn(&Program, &[u8], &[String]) -> bool + Send + Sync>;

pub struct ModuleOptions {
    /// `<app-data>/modules/ocr`; `None`: no data folder, OCR unavailable.
    pub root: Option<PathBuf>,
    pub app: String,
    pub fetch: Arc<dyn Fetch>,
    pub source: Arc<dyn ListSource>,
    pub catalog: Catalog,
    pub events: Option<Sink>,
    pub idle: Duration,
    /// How a new model is checked before it is switched in; the default runs the program.
    pub tester: Option<Tester>,
}

impl ModuleOptions {
    pub fn new(root: Option<PathBuf>, app: &str) -> Self {
        let http = Arc::new(HttpFetch::new(app, Arc::new(SystemLookup), false));
        Self { root, app: app.to_owned(), fetch: http.clone(), source: http, catalog: Catalog::compiled(), events: None, idle: runner::IDLE, tester: None }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Job {
    Idle,
    Downloading { model: ModelId, received: u64, total: Option<u64> },
    Checking { model: ModelId },
    Failed { model: ModelId, reason: &'static str },
}

pub struct Modules {
    store: Option<Store>,
    app: Option<Version>,
    fetch: Arc<dyn Fetch>,
    source: Arc<dyn ListSource>,
    catalog: Mutex<Catalog>,
    events: Sink,
    runner: Runner,
    tester: Tester,
    job: Mutex<Job>,
    cancel: AtomicBool,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn model_arg(args: &Value) -> HostResult<ModelId> {
    args.get("model").and_then(Value::as_str).and_then(ModelId::parse).ok_or_else(|| HostError::bad_argument("model must be \"fast\" or \"second\""))
}

/// The real test: the program reads the image, and every phrase must be in its text.
fn run_test(program: &Program, image: &[u8], expect: &[String]) -> bool {
    let runner = Runner::new(runner::IDLE);
    let Ok(pages) = runner.run(program, Kind::Image, image, &mut |_, _| {}) else { return false };
    let text: String = pages.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("\n");
    expect.iter().all(|e| text.contains(e.as_str()))
}

impl Modules {
    pub fn new(options: ModuleOptions) -> Arc<Self> {
        Arc::new(Self {
            store: options.root.map(Store::open),
            app: Version::parse(&options.app),
            fetch: options.fetch,
            source: options.source,
            catalog: Mutex::new(options.catalog),
            events: options.events.unwrap_or_else(|| Arc::new(|_, _| {})),
            runner: Runner::new(options.idle),
            tester: options.tester.unwrap_or_else(|| Arc::new(run_test)),
            job: Mutex::new(Job::Idle),
            cancel: AtomicBool::new(false),
        })
    }

    fn available(&self) -> bool {
        self.store.is_some() && self.app.is_some() && locked(&self.catalog).runtime_files().is_some()
    }

    fn store(&self) -> HostResult<&Store> {
        self.store.as_ref().filter(|_| self.available()).ok_or_else(|| HostError::not_allowed("OCR isn't available in this build"))
    }

    fn sizes(files: &[ModuleFile]) -> u64 {
        files.iter().map(|f| f.size).sum()
    }

    /// `module.status`.
    pub fn status(&self) -> Value {
        let job = match &*locked(&self.job) {
            Job::Idle => json!({ "state": "idle" }),
            Job::Downloading { model, received, total } => json!({ "state": "downloading", "model": model.as_str(), "received": received, "total": total }),
            Job::Checking { model } => json!({ "state": "checking", "model": model.as_str() }),
            Job::Failed { model, reason } => json!({ "state": "failed", "model": model.as_str(), "reason": reason }),
        };
        let (Some(store), Some(app), true) = (&self.store, &self.app, self.available()) else {
            return json!({ "available": false, "runtime": null, "models": [], "autoUpdate": false, "job": job });
        };
        let installed = store.installed();
        let catalog = locked(&self.catalog);
        let runtime_files = for_target(catalog.runtime_files().unwrap_or_default());
        let runtime_missing = installed.runtime.as_deref() != Some(catalog.runtime.version.as_str());
        let models: Vec<Value> = ModelId::ALL
            .iter()
            .map(|&id| {
                let have = match id {
                    ModelId::Fast => installed.fast.clone(),
                    ModelId::Second => installed.second.clone(),
                };
                let entry = catalog.model(id, app);
                let model_size = entry.map_or(0, |m| Self::sizes(&for_target(&m.files)));
                let update = entry.filter(|m| have.as_ref().is_some_and(|h| *h != m.version)).map(|m| m.version.clone());
                let size = have.as_ref().map_or(0, |_| store.model_bytes(id));
                // The download a click costs now: the model (or its update), plus the program if it is missing or old.
                let download = model_size + if runtime_missing { Self::sizes(&runtime_files) } else { 0 };
                json!({ "id": id.as_str(), "installed": have, "update": update, "downloadSize": download, "size": size })
            })
            .collect();
        json!({ "available": true, "runtime": installed.runtime, "models": models, "autoUpdate": store.auto_update(), "job": job })
    }

    fn set_job(&self, job: Job) {
        *locked(&self.job) = job;
        (self.events)(PROGRESS_EVENT, self.status());
    }

    /// Reads the signed list now (`module.status { refresh }`, and with the update check when a model is installed).
    /// A list that fails any check is ignored: the app keeps what it has.
    pub fn refresh(self: &Arc<Self>) {
        let Ok(store) = self.store() else { return };
        let Some((json, sig)) = self.source.list() else { return };
        let Ok(next) = Catalog::from_signed(&json, &sig, store.serial()) else { return };
        let _ = store.set_serial(next.list.serial);
        *locked(&self.catalog) = next;
        if store.auto_update() && matches!(*locked(&self.job), Job::Idle | Job::Failed { .. }) {
            let status = self.status();
            for m in status["models"].as_array().into_iter().flatten() {
                if !m["update"].is_null()
                    && let Some(id) = m["id"].as_str().and_then(ModelId::parse)
                {
                    let _ = self.install(id);
                    break;
                }
            }
        }
        (self.events)(PROGRESS_EVENT, self.status());
    }

    /// Whether the update check should read the signed list too: only when some model is installed.
    pub fn wants_list(&self) -> bool {
        self.store.as_ref().is_some_and(|s| {
            let i = s.installed();
            i.fast.is_some() || i.second.is_some()
        })
    }

    /// `module.install`: downloads the model (and the program, if it is missing or older) on a thread of its own.
    pub fn install(self: &Arc<Self>, id: ModelId) -> HostResult<Value> {
        self.store()?;
        let app = self.app.clone().ok_or_else(|| HostError::not_allowed("OCR isn't available in this build"))?;
        let (runtime, entry, test) = {
            let catalog = locked(&self.catalog);
            let entry = catalog.model(id, &app).cloned().ok_or_else(|| HostError::not_allowed("This model isn't available for this version of Thoth"))?;
            (catalog.runtime.clone(), entry, catalog.list.test.clone())
        };
        {
            let mut job = locked(&self.job);
            // One download at a time: a second click joins the one going.
            let going = matches!(*job, Job::Downloading { .. } | Job::Checking { .. });
            if !going {
                *job = Job::Downloading { model: id, received: 0, total: None };
            }
            drop(job);
            if going {
                return Ok(self.status());
            }
        }
        self.cancel.store(false, Ordering::SeqCst);
        (self.events)(PROGRESS_EVENT, self.status());
        let me = self.clone();
        std::thread::spawn(move || {
            let outcome = me.install_now(id, &runtime, &entry, &test);
            me.set_job(match outcome {
                Ok(()) => Job::Idle,
                Err(reason) => Job::Failed { model: id, reason },
            });
        });
        Ok(self.status())
    }

    fn install_now(&self, id: ModelId, runtime: &catalog::Runtime, entry: &catalog::ModelEntry, test: &catalog::TestImage) -> Result<(), &'static str> {
        let Some(store) = &self.store else { return Err("failed") };
        let runtime_files = for_target(runtime.targets.get(TARGET).map(Vec::as_slice).unwrap_or_default());
        let mut model_files = for_target(&entry.files);
        model_files.push(catalog::ModuleFile { name: TEST_FILE.into(), ..test.file.clone() });
        let need_runtime = store.installed().runtime.as_deref() != Some(runtime.version.as_str());
        let total = model_files.iter().chain(if need_runtime { runtime_files.as_slice() } else { &[] }).map(|f| f.size).sum::<u64>();
        let mut done = 0u64;
        let progress = |offset: u64| {
            move |received: u64, _: Option<u64>| {
                let mut job = locked(&self.job);
                if matches!(*job, Job::Downloading { .. }) {
                    *job = Job::Downloading { model: id, received: offset + received, total: Some(total) };
                    drop(job);
                    (self.events)(PROGRESS_EVENT, self.status());
                }
            }
        };
        let reason = |f: Failure| f.reason();
        let mut staged_runtime = None;
        if need_runtime {
            let staged = store.install(Dest::Runtime, &runtime.version, &runtime_files, self.fetch.as_ref(), &mut progress(0), &self.cancel).map_err(reason)?;
            done = Self::sizes(&runtime_files);
            staged_runtime = Some(staged);
        }
        let staged = match store.install(Dest::Model(id), &entry.version, &model_files, self.fetch.as_ref(), &mut progress(done), &self.cancel) {
            Ok(s) => s,
            Err(f) => {
                if let Some(r) = staged_runtime {
                    let _ = std::fs::remove_dir_all(&r.path);
                }
                return Err(reason(f));
            }
        };
        self.set_job(Job::Checking { model: id });
        if let Some(r) = &staged_runtime {
            store.activate(r).map_err(|_| "disk")?;
        }
        store.activate(&staged).map_err(|_| "disk")?;
        let passed = self
            .program(id, &entry.preset)
            .ok()
            .zip(std::fs::read(staged.path.join(TEST_FILE)).ok())
            .is_some_and(|(program, image)| (self.tester)(&program, &image, &test.expect));
        if !passed {
            let _ = store.roll_back(&staged);
            if let Some(r) = &staged_runtime {
                let _ = store.roll_back(r);
            }
            return Err("test");
        }
        let _ = store.forget_previous(Dest::Model(id));
        if staged_runtime.is_some() {
            let _ = store.forget_previous(Dest::Runtime);
        }
        Ok(())
    }

    fn program(&self, id: ModelId, preset: &str) -> HostResult<Program> {
        let store = self.store()?;
        let not_installed = || HostError::new("OCR_NOT_INSTALLED", "OCR isn't downloaded yet");
        let runtime = store.active(Dest::Runtime).ok_or_else(not_installed)?;
        let models = store.active(Dest::Model(id)).ok_or_else(not_installed)?;
        let ort = runtime.join(ORT);
        Ok(Program { exe: runtime.join(EXE), ort: ort.exists().then_some(ort), models, preset: preset.to_owned() })
    }

    /// `module.cancel`.
    pub fn cancel(&self) -> Value {
        if matches!(*locked(&self.job), Job::Downloading { .. }) {
            self.cancel.store(true, Ordering::SeqCst);
        }
        self.status()
    }

    /// `module.remove`: stops a running read first, then deletes the model (and the program with the last one).
    pub fn remove(&self, id: ModelId) -> HostResult<Value> {
        let store = self.store()?;
        if matches!(*locked(&self.job), Job::Downloading { model, .. } | Job::Checking { model } if model == id) {
            return Err(HostError::new("OCR_BUSY", "Wait for the download to finish or cancel it first"));
        }
        self.runner.cancel();
        store.remove(id)?;
        let status = self.status();
        (self.events)(PROGRESS_EVENT, status.clone());
        Ok(status)
    }

    /// `module.settings`.
    pub fn settings(&self, args: &Value) -> HostResult<Value> {
        let on = args.get("autoUpdate").and_then(Value::as_bool).ok_or_else(|| HostError::bad_argument("autoUpdate must be a boolean"))?;
        self.store()?.set_auto_update(on)?;
        Ok(self.status())
    }

    /// `ocr.read`: the text of an image or a PDF. `model`: `fast` if installed, else `second`.
    pub fn read(&self, args: &Value, bytes: &[u8]) -> HostResult<Value> {
        let kind = match args.get("kind").and_then(Value::as_str) {
            Some("image") => Kind::Image,
            Some("pdf") => Kind::Pdf,
            _ => return Err(HostError::bad_argument("kind must be \"image\" or \"pdf\"")),
        };
        let store = self.store()?;
        let installed = store.installed();
        let id = match args.get("model") {
            None | Some(Value::Null) => {
                if installed.fast.is_some() {
                    ModelId::Fast
                } else {
                    ModelId::Second
                }
            }
            Some(_) => model_arg(args)?,
        };
        let preset = {
            let catalog = locked(&self.catalog);
            let version = match id {
                ModelId::Fast => installed.fast.clone(),
                ModelId::Second => installed.second.clone(),
            }
            .ok_or_else(|| HostError::new("OCR_NOT_INSTALLED", "OCR isn't downloaded yet"))?;
            // The preset of the installed version, wherever the list now is; a model id always has the same preset.
            catalog
                .list
                .models
                .iter()
                .find(|m| m.id == id && m.version == version)
                .map_or_else(|| if id == ModelId::Fast { "openthai".to_owned() } else { "pp5".to_owned() }, |m| m.preset.clone())
        };
        // Every file again before each run: a changed program or model is never started.
        store.verify(Dest::Runtime)?;
        store.verify(Dest::Model(id))?;
        let program = self.program(id, &preset)?;
        let events = self.events.clone();
        let pages = self.runner.run(&program, kind, bytes, &mut |page, pages| events(OCR_PROGRESS_EVENT, json!({ "page": page, "pages": pages })))?;
        Ok(json!({ "model": id.as_str(), "pages": pages.iter().map(|p| json!({ "text": p.text, "source": p.source })).collect::<Vec<_>>() }))
    }

    /// `ocr.cancel`.
    pub fn cancel_read(&self) {
        self.runner.cancel();
    }

    /// The app quits: a running read is killed and a download stops.
    pub fn shutdown(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.runner.cancel();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use catalog::{List, ModelEntry, Runtime, TestImage};
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use sha2::{Digest, Sha256};
    use std::collections::{BTreeMap, HashMap};
    use std::io::Write;

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut e = GzEncoder::new(Vec::new(), Compression::default());
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    #[derive(Default)]
    struct Served(Mutex<HashMap<String, Vec<u8>>>);

    impl Fetch for Served {
        fn open(&self, url: &str, _max: u64) -> Result<Box<dyn std::io::Read + Send>, Failure> {
            let body = locked(&self.0).get(url).cloned().ok_or(Failure::Offline)?;
            Ok(Box::new(std::io::Cursor::new(body)))
        }
    }

    struct NoList;
    impl ListSource for NoList {
        fn list(&self) -> Option<(Vec<u8>, String)> {
            None
        }
    }

    /// A file served as `.gz` at a modules URL, listed with its real size and hash.
    fn serve(served: &Served, path: &str, name: &str, body: &[u8], executable: bool) -> ModuleFile {
        let url = format!("{}{path}/{name}.gz", catalog::BASE);
        let gz = gz(body);
        let sha256 = Sha256::digest(&gz).iter().map(|b| format!("{b:02x}")).collect();
        let file = ModuleFile { name: name.into(), url: url.clone(), size: gz.len() as u64, sha256, targets: None, executable };
        locked(&served.0).insert(url, gz);
        file
    }

    /// The program: a shell script that answers `text` for any image (and sleeps first when `SLOW` is in its folder).
    const PROGRAM: &str = r#"#!/bin/sh
head -n 1 > /dev/null
[ -f "$(dirname "$0")/SLOW" ] && sleep 30
echo '{"page":1,"pages":1,"source":"ocr","text":"Getting Started"}'
echo '{"done":true}'
"#;

    fn setup(dir: &std::path::Path, tester: Option<Tester>) -> (Arc<Modules>, Arc<Served>) {
        let served = Arc::new(Served::default());
        let runtime_files = vec![serve(&served, "ocr/0.1.0/t", EXE, PROGRAM.as_bytes(), true)];
        let runtime =
            Runtime { version: "0.1.0".into(), protocol: 1, onnxruntime: "1.28.0".into(), targets: BTreeMap::from([(TARGET.to_owned(), runtime_files)]) };
        let model = |id: ModelId, preset: &str| ModelEntry {
            id,
            version: "v1".into(),
            preset: preset.into(),
            min_app: "0.12.0".into(),
            protocol: 1,
            files: vec![serve(&served, &format!("models/{}/v1", id.as_str()), "det.onnx", b"weights", false)],
        };
        let test = TestImage { file: serve(&served, "test/1", TEST_FILE, b"png", false), expect: vec!["Getting Started".into()] };
        let list = List { serial: 1, models: vec![model(ModelId::Fast, "openthai"), model(ModelId::Second, "pp5")], test };
        let modules = Modules::new(ModuleOptions {
            root: Some(dir.to_path_buf()),
            app: "0.12.0".into(),
            fetch: served.clone(),
            source: Arc::new(NoList),
            catalog: Catalog { runtime, list },
            events: None,
            idle: Duration::from_secs(10),
            tester,
        });
        (modules, served)
    }

    fn wait_idle(m: &Modules) -> Value {
        for _ in 0..500 {
            let s = m.status();
            if !matches!(s["job"]["state"].as_str(), Some("downloading" | "checking")) {
                return s;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("the download did not finish");
    }

    #[test]
    fn not_available_without_runtime_files_for_this_target() {
        let m = Modules::new(ModuleOptions::new(None, "0.12.0"));
        assert_eq!(m.status()["available"], false);
        assert_eq!(m.install(ModelId::Fast).unwrap_err().code, "NOT_ALLOWED");
        assert_eq!(m.read(&json!({ "kind": "image" }), b"x").unwrap_err().code, "NOT_ALLOWED");
    }

    #[test]
    fn installs_the_program_and_a_model_then_reads() {
        let dir = tempfile::tempdir().unwrap();
        let (m, _) = setup(dir.path(), None);
        let before = m.status();
        assert_eq!(before["available"], true);
        assert!(before["models"][0]["downloadSize"].as_u64().unwrap() > 0);
        assert_eq!(m.read(&json!({ "kind": "image" }), b"x").unwrap_err().code, "OCR_NOT_INSTALLED");
        m.install(ModelId::Fast).unwrap();
        let after = wait_idle(&m);
        assert_eq!(after["job"]["state"], "idle", "{after}");
        assert_eq!(after["models"][0]["installed"], "v1");
        assert_eq!(after["runtime"], "0.1.0");
        let read = m.read(&json!({ "kind": "image" }), b"x").unwrap();
        assert_eq!(read, json!({ "model": "fast", "pages": [{ "text": "Getting Started", "source": "ocr" }] }));
    }

    #[test]
    fn a_failed_test_image_keeps_nothing_new() {
        let dir = tempfile::tempdir().unwrap();
        let (m, _) = setup(dir.path(), Some(Arc::new(|_: &Program, _: &[u8], _: &[String]| false)));
        m.install(ModelId::Fast).unwrap();
        let s = wait_idle(&m);
        assert_eq!(s["job"], json!({ "state": "failed", "model": "fast", "reason": "test" }));
        assert_eq!(s["models"][0]["installed"], Value::Null);
        assert_eq!(s["runtime"], Value::Null);
    }

    #[test]
    fn verifies_hashes_before_each_run() {
        let dir = tempfile::tempdir().unwrap();
        let (m, _) = setup(dir.path(), None);
        m.install(ModelId::Fast).unwrap();
        wait_idle(&m);
        let exe = m.store.as_ref().unwrap().active(Dest::Runtime).unwrap().join(EXE);
        std::fs::write(&exe, "#!/bin/sh\ntouch \"$(dirname \"$0\")/started\"\n").unwrap();
        assert_eq!(m.read(&json!({ "kind": "image" }), b"x").unwrap_err().code, "OCR_FAILED");
        assert!(!exe.with_file_name("started").exists());
    }

    #[test]
    fn remove_while_a_job_runs_kills_it_first() {
        let dir = tempfile::tempdir().unwrap();
        let (m, _) = setup(dir.path(), None);
        m.install(ModelId::Fast).unwrap();
        wait_idle(&m);
        let runtime = m.store.as_ref().unwrap().active(Dest::Runtime).unwrap();
        std::fs::write(runtime.join("SLOW"), "").unwrap();
        let reader = m.clone();
        let job = std::thread::spawn(move || reader.read(&json!({ "kind": "image" }), b"x"));
        while !m.runner.busy() {
            std::thread::sleep(Duration::from_millis(10));
        }
        let status = m.remove(ModelId::Fast).unwrap();
        assert_eq!(job.join().unwrap().unwrap_err().code, "OCR_CANCELLED");
        assert_eq!(status["models"][0]["installed"], Value::Null);
        assert!(!runtime.exists(), "the program goes with the last model");
    }

    #[test]
    fn quitting_kills_a_running_job() {
        let dir = tempfile::tempdir().unwrap();
        let (m, _) = setup(dir.path(), None);
        m.install(ModelId::Second).unwrap();
        wait_idle(&m);
        std::fs::write(m.store.as_ref().unwrap().active(Dest::Runtime).unwrap().join("SLOW"), "").unwrap();
        let reader = m.clone();
        let t = Instant::now();
        let job = std::thread::spawn(move || reader.read(&json!({ "kind": "image" }), b"x"));
        while !m.runner.busy() {
            std::thread::sleep(Duration::from_millis(10));
        }
        m.shutdown();
        assert_eq!(job.join().unwrap().unwrap_err().code, "OCR_CANCELLED");
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn checks_its_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let (m, _) = setup(dir.path(), None);
        assert_eq!(m.read(&json!({ "kind": "audio" }), b"x").unwrap_err().code, "BAD_ARGUMENT");
        assert_eq!(m.read(&json!({ "kind": "image", "model": "big" }), b"x").unwrap_err().code, "BAD_ARGUMENT");
        assert_eq!(m.settings(&json!({ "autoUpdate": "yes" })).unwrap_err().code, "BAD_ARGUMENT");
        assert_eq!(m.settings(&json!({ "autoUpdate": true })).unwrap()["autoUpdate"], true);
    }
}
