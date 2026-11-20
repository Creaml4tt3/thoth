//! Runs `thoth-ocr` (protocol 1) as a supervised child, one job at a time (ADR-0055, plan §4): its own process group
//! (a Job Object on Windows) as the agent CLIs are run, the request written from a thread, stdout read line by line,
//! stderr dropped. A job is killed after `idle` without a page finishing, on Cancel, on Remove and when the app quits.
use crate::agent::{Signal, own_group, signal_group};
use crate::error::{HostError, HostResult};
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

/// The protocol this app speaks (`thoth-ocr --version`).
pub const PROTOCOL: u32 = 1;
/// The longest wait for the next page.
pub const IDLE: Duration = Duration::from_secs(60);
pub const MAX_IMAGE_BYTES: usize = 20_000_000;
pub const MAX_PDF_BYTES: usize = 50_000_000;
pub const MAX_PDF_PAGES: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Image,
    Pdf,
}

/// What to run: the program, ONNX Runtime (none for the tract build), the model folder and its preset.
#[derive(Clone, Debug)]
pub struct Program {
    pub exe: PathBuf,
    pub ort: Option<PathBuf>,
    pub models: PathBuf,
    pub preset: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub text: String,
    /// `ocr` or `text` (a PDF page's own text).
    pub source: String,
}

pub struct Runner {
    idle: Duration,
    /// The running job's process group, `None` when idle.
    job: Mutex<Option<i32>>,
    /// Who started the running job (a window), so a Cancel from another window leaves it alone.
    owner: Mutex<Option<String>>,
    cancelled: AtomicBool,
}

impl Runner {
    pub fn new(idle: Duration) -> Runner {
        Runner { idle, job: Mutex::new(None), owner: Mutex::new(None), cancelled: AtomicBool::new(false) }
    }

    pub fn busy(&self) -> bool {
        locked(&self.job).is_some()
    }

    /// Runs one job: its pages, and a PDF's page count (more than the pages read past `MAX_PDF_PAGES`).
    /// `progress(page, pages)` after each page. `OCR_BUSY` while another runs.
    pub fn run(&self, program: &Program, kind: Kind, bytes: &[u8], progress: &mut dyn FnMut(usize, usize)) -> HostResult<(Vec<Page>, Option<usize>)> {
        self.run_as("", program, kind, bytes, progress)
    }

    /// `run`, started by `owner`: only `cancel_for(owner)` (or `cancel`) stops it.
    pub fn run_as(
        &self,
        owner: &str,
        program: &Program,
        kind: Kind,
        bytes: &[u8],
        progress: &mut dyn FnMut(usize, usize),
    ) -> HostResult<(Vec<Page>, Option<usize>)> {
        let limit = if kind == Kind::Image { MAX_IMAGE_BYTES } else { MAX_PDF_BYTES };
        if bytes.len() > limit {
            return Err(HostError::new("OCR_TOO_LARGE", "The file is too large to read"));
        }
        let mut job = locked(&self.job);
        if job.is_some() {
            return Err(HostError::new("OCR_BUSY", "Another text is being read"));
        }
        self.cancelled.store(false, Ordering::SeqCst);
        let mut command = Command::new(&program.exe);
        command.args([OsStr::new("serve"), OsStr::new("--models"), program.models.as_os_str(), OsStr::new("--preset"), OsStr::new(&program.preset)]);
        command.env_clear();
        if let Some(ort) = &program.ort {
            command.env("ORT_DYLIB_PATH", ort);
        }
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        own_group(&mut command);
        let failed = |e: std::io::Error| HostError::new("OCR_FAILED", format!("OCR could not start: {e}"));
        let mut child = command.spawn().map_err(failed)?;
        #[cfg(windows)]
        crate::agent::kill_windows::adopt(&mut child).map_err(failed)?;
        let group = i32::try_from(child.id()).ok();
        *job = group;
        *locked(&self.owner) = Some(owner.to_owned());
        drop(job);
        let result = self.supervise(&mut child, group, kind, bytes, progress);
        // Whatever is left of the job goes now: nothing keeps running or holds the pipes.
        if let Some(g) = group {
            signal_group(g, Signal::Kill);
        }
        let _ = child.kill();
        let _ = child.wait();
        *locked(&self.job) = None;
        *locked(&self.owner) = None;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(HostError::new("OCR_CANCELLED", "Reading was cancelled"));
        }
        result
    }

    fn supervise(
        &self,
        child: &mut Child,
        group: Option<i32>,
        kind: Kind,
        bytes: &[u8],
        progress: &mut dyn FnMut(usize, usize),
    ) -> HostResult<(Vec<Page>, Option<usize>)> {
        let failed = |m: &str| HostError::new("OCR_FAILED", m.to_owned());
        let header = match kind {
            Kind::Image => json!({ "op": "image", "len": bytes.len() }),
            Kind::Pdf => json!({ "op": "pdf", "len": bytes.len(), "maxPages": MAX_PDF_PAGES }),
        };
        let mut stdin = child.stdin.take().ok_or_else(|| failed("no stdin"))?;
        let mut request = format!("{header}\n").into_bytes();
        request.extend_from_slice(bytes);
        // From a thread: a program that stops reading must not block the host.
        std::thread::spawn(move || {
            let _ = stdin.write_all(&request);
        });
        let stdout = child.stdout.take().ok_or_else(|| failed("no stdout"))?;
        let (send, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if send.send(line).is_err() {
                    break;
                }
            }
        });
        let mut pages = Vec::new();
        loop {
            let line = match lines.recv_timeout(self.idle) {
                Ok(Ok(line)) => line,
                Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => return Err(failed("OCR stopped without an answer")),
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(g) = group {
                        signal_group(g, Signal::Kill);
                    }
                    return Err(HostError::new("OCR_TIMEOUT", "Reading took too long and was stopped"));
                }
            };
            let value: Value = serde_json::from_str(&line).map_err(|_| failed("OCR answered something it should not"))?;
            if value.get("done") == Some(&Value::Bool(true)) {
                return Ok((pages, value.get("total").and_then(Value::as_u64).map(|t| t as usize)));
            }
            if let Some(error) = value.get("error").and_then(Value::as_str) {
                return Err(match error {
                    "too-large" => HostError::new("OCR_TOO_LARGE", "The file is too large to read"),
                    "bad-image" | "bad-pdf" => HostError::new("OCR_BAD_FILE", "This file can't be read"),
                    _ => failed("OCR could not read this file"),
                });
            }
            let (Some(page), Some(total), Some(text), Some(source)) =
                (value["page"].as_u64(), value["pages"].as_u64(), value["text"].as_str(), value["source"].as_str())
            else {
                return Err(failed("OCR answered something it should not"));
            };
            pages.push(Page { text: text.to_owned(), source: source.to_owned() });
            progress(page as usize, total as usize);
        }
    }

    /// Kills the running job if `owner` started it (a window's Cancel). False: nothing of theirs was running.
    pub fn cancel_for(&self, owner: &str) -> bool {
        let job = locked(&self.job);
        if job.is_some() && locked(&self.owner).as_deref() == Some(owner) {
            drop(job);
            self.cancel();
            return true;
        }
        false
    }

    /// Kills the running job, if any (Cancel, Remove, quit). The job answers `OCR_CANCELLED`.
    pub fn cancel(&self) {
        let job = locked(&self.job);
        if let Some(g) = *job {
            self.cancelled.store(true, Ordering::SeqCst);
            signal_group(g, Signal::Kill);
        }
    }
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

    /// A program that reads the request and answers `script`'s lines (a shell body; `$1` is unused).
    fn fake(dir: &std::path::Path, body: &str) -> Program {
        use std::os::unix::fs::PermissionsExt;
        let exe = dir.join("thoth-ocr");
        std::fs::write(&exe, format!("#!/bin/sh\nhead -n 1 > /dev/null\n{body}\n")).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        Program { exe, ort: None, models: dir.to_path_buf(), preset: "openthai".into() }
    }

    const TWO_PAGES: &str = r#"echo '{"page":1,"pages":2,"source":"text","text":"one"}'
echo '{"page":2,"pages":2,"source":"ocr","text":"two"}'
echo '{"done":true,"total":70}'"#;

    #[test]
    fn reads_every_page_and_reports_progress() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(dir.path(), TWO_PAGES);
        let mut seen = Vec::new();
        let (pages, total) = Runner::new(IDLE).run(&p, Kind::Pdf, b"%PDF", &mut |i, n| seen.push((i, n))).unwrap();
        assert_eq!(total, Some(70));
        assert_eq!(pages, vec![Page { text: "one".into(), source: "text".into() }, Page { text: "two".into(), source: "ocr".into() }]);
        assert_eq!(seen, vec![(1, 2), (2, 2)]);
    }

    #[test]
    fn kills_the_child_after_60s_without_a_page() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(dir.path(), "sleep 30");
        let t = Instant::now();
        let err = Runner::new(Duration::from_millis(300)).run(&p, Kind::Image, b"x", &mut |_, _| {}).unwrap_err();
        assert_eq!(err.code, "OCR_TIMEOUT");
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn cancel_kills_the_child() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(dir.path(), "sleep 30");
        let runner = Arc::new(Runner::new(IDLE));
        let r = runner.clone();
        let job = std::thread::spawn(move || r.run(&p, Kind::Image, b"x", &mut |_, _| {}));
        while !runner.busy() {
            std::thread::sleep(Duration::from_millis(10));
        }
        let t = Instant::now();
        runner.cancel();
        assert_eq!(job.join().unwrap().unwrap_err().code, "OCR_CANCELLED");
        assert!(t.elapsed() < Duration::from_secs(5));
        assert!(!runner.busy());
    }

    #[test]
    fn maps_program_errors_to_codes() {
        let dir = tempfile::tempdir().unwrap();
        for (error, code) in [
            ("too-large", "OCR_TOO_LARGE"),
            ("bad-image", "OCR_BAD_FILE"),
            ("bad-pdf", "OCR_BAD_FILE"),
            ("failed", "OCR_FAILED"),
            ("bad-request", "OCR_FAILED"),
        ] {
            let p = fake(dir.path(), &format!("echo '{{\"error\":\"{error}\",\"message\":\"m\"}}'; exit 1"));
            assert_eq!(Runner::new(IDLE).run(&p, Kind::Image, b"x", &mut |_, _| {}).unwrap_err().code, code, "{error}");
        }
        // A crash with no answer, or output that is not the protocol, is a plain failure.
        for body in ["exit 3", "echo garbage", "kill -9 $$"] {
            let p = fake(dir.path(), body);
            assert_eq!(Runner::new(IDLE).run(&p, Kind::Image, b"x", &mut |_, _| {}).unwrap_err().code, "OCR_FAILED", "{body}");
        }
    }

    #[test]
    fn refuses_too_large_input_before_starting() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(dir.path(), &format!("touch {}/started; {TWO_PAGES}", dir.path().display()));
        let big = vec![0u8; MAX_IMAGE_BYTES + 1];
        assert_eq!(Runner::new(IDLE).run(&p, Kind::Image, &big, &mut |_, _| {}).unwrap_err().code, "OCR_TOO_LARGE");
        assert!(!dir.path().join("started").exists());
        assert!(Runner::new(IDLE).run(&p, Kind::Pdf, &big, &mut |_, _| {}).is_ok());
    }

    #[test]
    fn a_second_job_while_one_runs_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let slow = fake(dir.path(), "sleep 30");
        let runner = Arc::new(Runner::new(IDLE));
        let r = runner.clone();
        let p = slow.clone();
        let job = std::thread::spawn(move || r.run(&p, Kind::Image, b"x", &mut |_, _| {}));
        while !runner.busy() {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(runner.run(&slow, Kind::Image, b"x", &mut |_, _| {}).unwrap_err().code, "OCR_BUSY");
        runner.cancel();
        let _ = job.join();
    }

    #[test]
    fn cancel_from_another_owner_leaves_the_job_alone() {
        let dir = tempfile::tempdir().unwrap();
        let p = fake(dir.path(), "sleep 30");
        let runner = Arc::new(Runner::new(IDLE));
        let r = runner.clone();
        let job = std::thread::spawn(move || r.run_as("window-a", &p, Kind::Pdf, b"x", &mut |_, _| {}));
        while !runner.busy() {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!runner.cancel_for("window-b"));
        assert!(runner.busy());
        assert!(runner.cancel_for("window-a"));
        assert_eq!(job.join().unwrap().unwrap_err().code, "OCR_CANCELLED");
    }

    #[test]
    fn passes_the_model_folder_preset_and_library() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = fake(dir.path(), r#"printf '{"page":1,"pages":1,"source":"ocr","text":"%s|%s"}\n' "$*" "$ORT_DYLIB_PATH"; echo '{"done":true}'"#);
        p.ort = Some(dir.path().join("libonnxruntime.dylib"));
        let (pages, total) = Runner::new(IDLE).run(&p, Kind::Image, b"x", &mut |_, _| {}).unwrap();
        assert_eq!(total, None);
        assert_eq!(pages[0].text, format!("serve --models {} --preset openthai|{}", dir.path().display(), dir.path().join("libonnxruntime.dylib").display()));
    }
}
