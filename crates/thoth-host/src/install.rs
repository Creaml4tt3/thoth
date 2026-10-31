//! In-app updates (ADR-0034): when the person clicks Update, the host downloads the new version that `latest.json`
//! names, checks its signature against the public key built into the app, installs it where the platform installs in
//! place (macOS, the AppImage), and waits for the person to restart. Nothing is downloaded before that click.
//!
//! The work is the `Installer`'s: the desktop shell's is the Tauri updater plugin's Rust API (the webview gets no
//! plugin permission, ADR-0008); this module keeps one update at a time for the whole app (every window sees the same
//! one), its progress (sent as `update.progress` events) and the rules for restarting.
use crate::error::{HostError, HostResult};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// The event the host sends while an update downloads and when it ends (the state, as `update.status` gives it).
pub const PROGRESS_EVENT: &str = "update.progress";

/// Why an update did not install. Each is told apart in the popup; each keeps the Download button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// The download or the check could not reach the server.
    Offline,
    /// The signature is missing, wrong, or not from the key built into the app; or the file was not where it must be.
    Verify,
    /// There was no room on the disk for it.
    Disk,
    /// The person cancelled it.
    Cancelled,
    /// Anything else (the installer could not run, the archive was not one).
    Failed,
}

impl Failure {
    pub fn reason(self) -> &'static str {
        match self {
            Self::Offline => "offline",
            Self::Verify => "verify",
            Self::Disk => "disk",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

/// What a finished download is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fetched {
    /// The version downloaded (the one `latest.json` names now).
    pub version: String,
    /// True when it is already in place and only a restart is needed (macOS, the AppImage). False when the installer
    /// runs at restart (Windows: it closes the app to replace it).
    pub installed: bool,
}

/// What does the downloading and installing. Blocking: the host runs `fetch` on a thread of its own.
pub trait Installer: Send + Sync {
    /// Whether this copy of the app can replace itself: a bundle the updater can update, not a .deb install, not a
    /// build run from the source tree.
    fn supported(&self) -> bool;
    /// Finds the update, downloads it (`progress(received, total)`), checks the signature and, where the platform
    /// installs in place, installs it. Returns `Failure::Cancelled` soon after `cancel` is set.
    fn fetch(&self, progress: &mut dyn FnMut(u64, Option<u64>), cancel: &AtomicBool) -> Result<Fetched, Failure>;
    /// Starts the restart into the new version. The windows write their edits first (the shell asks them, as for Quit).
    fn restart(&self) -> HostResult<()>;
}

/// The installer of a copy that cannot update itself: the notice only.
pub struct NoInstaller;

impl Installer for NoInstaller {
    fn supported(&self) -> bool {
        false
    }
    fn fetch(&self, _: &mut dyn FnMut(u64, Option<u64>), _: &AtomicBool) -> Result<Fetched, Failure> {
        Err(Failure::Failed)
    }
    fn restart(&self) -> HostResult<()> {
        Err(HostError::not_allowed("This copy of Thoth cannot update itself"))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Downloading { received: u64, total: Option<u64> },
    Ready(Fetched),
    Failed(Failure),
    Restarting,
}

impl Phase {
    fn to_json(&self) -> Value {
        match self {
            Self::Idle => json!({ "phase": "idle" }),
            Self::Downloading { received, total } => match total {
                Some(total) => json!({ "phase": "downloading", "received": received, "total": total }),
                None => json!({ "phase": "downloading", "received": received }),
            },
            Self::Ready(f) => json!({ "phase": "ready", "version": f.version, "installed": f.installed }),
            Self::Failed(why) => json!({ "phase": "failed", "reason": why.reason() }),
            Self::Restarting => json!({ "phase": "restarting" }),
        }
    }
}

type Sink = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// The one update of the running app.
pub(crate) struct InApp {
    installer: Arc<dyn Installer>,
    phase: Mutex<Phase>,
    cancel: AtomicBool,
    events: Sink,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl InApp {
    pub(crate) fn new(installer: Arc<dyn Installer>, events: Option<Sink>) -> Arc<Self> {
        Arc::new(Self { installer, phase: Mutex::new(Phase::Idle), cancel: AtomicBool::new(false), events: events.unwrap_or_else(|| Arc::new(|_, _| {})) })
    }

    pub(crate) fn supported(&self) -> bool {
        self.installer.supported()
    }

    pub(crate) fn status(&self) -> Value {
        locked(&self.phase).to_json()
    }

    fn set(&self, phase: Phase) {
        let value = phase.to_json();
        *locked(&self.phase) = phase;
        (self.events)(PROGRESS_EVENT, value);
    }

    /// Starts the download, unless one is going or done: then its state, so a second window joins it.
    pub(crate) fn start(self: &Arc<Self>) -> Value {
        let mut phase = locked(&self.phase);
        if matches!(*phase, Phase::Downloading { .. } | Phase::Ready(_) | Phase::Restarting) {
            return phase.to_json();
        }
        *phase = Phase::Downloading { received: 0, total: None };
        let started = phase.to_json();
        drop(phase);
        self.cancel.store(false, Ordering::SeqCst);
        (self.events)(PROGRESS_EVENT, started.clone());
        let me = self.clone();
        std::thread::spawn(move || {
            // One event per whole percent (or per 256 KB when the size is not known): enough for a progress bar,
            // never one per chunk.
            let mut shown: Option<u64> = None;
            let mut progress = |received: u64, total: Option<u64>| {
                let step = total.filter(|t| *t > 0).map_or(received / (256 * 1024), |t| received.saturating_mul(100) / t);
                if shown == Some(step) {
                    return;
                }
                shown = Some(step);
                let mut phase = locked(&me.phase);
                if matches!(*phase, Phase::Downloading { .. }) {
                    *phase = Phase::Downloading { received, total };
                    let value = phase.to_json();
                    drop(phase);
                    (me.events)(PROGRESS_EVENT, value);
                }
            };
            let outcome = me.installer.fetch(&mut progress, &me.cancel);
            let cancelled = me.cancel.load(Ordering::SeqCst);
            me.set(match outcome {
                // A cancel that came too late to stop it still counts: the person said no.
                Ok(fetched) if !cancelled || fetched.installed => Phase::Ready(fetched),
                Ok(_) => Phase::Failed(Failure::Cancelled),
                Err(failure) => Phase::Failed(failure),
            });
        });
        started
    }

    pub(crate) fn cancel(&self) -> Value {
        let phase = locked(&self.phase);
        if matches!(*phase, Phase::Downloading { .. }) {
            self.cancel.store(true, Ordering::SeqCst);
        }
        phase.to_json()
    }

    /// Restarts into the ready update. `running`: the assistant runs going now; unless `even_if_running`, the answer is
    /// `busy` and nothing happens, so the person can choose.
    pub(crate) fn restart(&self, even_if_running: bool, running: usize) -> HostResult<Value> {
        let mut phase = locked(&self.phase);
        if !matches!(*phase, Phase::Ready(_)) {
            return Err(HostError::not_allowed("No update is ready to restart into"));
        }
        if running > 0 && !even_if_running {
            return Ok(json!({ "state": "busy", "runs": running }));
        }
        let ready = std::mem::replace(&mut *phase, Phase::Restarting);
        drop(phase);
        if let Err(error) = self.installer.restart() {
            *locked(&self.phase) = ready;
            return Err(error);
        }
        (self.events)(PROGRESS_EVENT, Phase::Restarting.to_json());
        Ok(json!({ "state": "restarting" }))
    }
}

// ------------------------------------------------------------------------------------------------ for tests

/// A scripted installer for tests and the stdio harness's `--update-installer`: it reports `chunks` as progress
/// (`(received, total)`, one per `step`), honours cancel between them, then gives `outcome`. Restarting counts, and
/// calls `on_restart` (the harness tells the test).
pub struct ScriptedInstaller {
    supported: bool,
    outcome: Mutex<Result<Fetched, Failure>>,
    pub chunks: Mutex<Vec<(u64, Option<u64>)>>,
    step: Duration,
    fetches: AtomicUsize,
    restarts: AtomicUsize,
    /// Set when a fetch stopped because of a cancel.
    pub saw_cancel: AtomicBool,
    on_restart: Option<Box<dyn Fn() + Send + Sync>>,
}

impl ScriptedInstaller {
    pub fn new(outcome: Result<Fetched, Failure>) -> Self {
        Self {
            supported: true,
            outcome: Mutex::new(outcome),
            chunks: Mutex::new(Vec::new()),
            step: Duration::ZERO,
            fetches: AtomicUsize::new(0),
            restarts: AtomicUsize::new(0),
            saw_cancel: AtomicBool::new(false),
            on_restart: None,
        }
    }

    pub fn unsupported() -> Self {
        Self { supported: false, ..Self::new(Err(Failure::Failed)) }
    }

    #[must_use]
    pub fn chunks(self, chunks: &[(u64, Option<u64>)]) -> Self {
        *locked(&self.chunks) = chunks.to_vec();
        self
    }

    #[must_use]
    pub fn step(mut self, step: Duration) -> Self {
        self.step = step;
        self
    }

    #[must_use]
    pub fn on_restart(mut self, f: impl Fn() + Send + Sync + 'static) -> Self {
        self.on_restart = Some(Box::new(f));
        self
    }

    pub fn fetches(&self) -> usize {
        self.fetches.load(Ordering::SeqCst)
    }

    pub fn restarts(&self) -> usize {
        self.restarts.load(Ordering::SeqCst)
    }
}

impl Installer for ScriptedInstaller {
    fn supported(&self) -> bool {
        self.supported
    }

    fn fetch(&self, progress: &mut dyn FnMut(u64, Option<u64>), cancel: &AtomicBool) -> Result<Fetched, Failure> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        let chunks = locked(&self.chunks).clone();
        for (received, total) in chunks {
            if cancel.load(Ordering::SeqCst) {
                self.saw_cancel.store(true, Ordering::SeqCst);
                return Err(Failure::Cancelled);
            }
            progress(received, total);
            std::thread::sleep(self.step);
        }
        locked(&self.outcome).clone()
    }

    fn restart(&self) -> HostResult<()> {
        self.restarts.fetch_add(1, Ordering::SeqCst);
        if let Some(f) = &self.on_restart {
            f();
        }
        Ok(())
    }
}
