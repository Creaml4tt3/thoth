//! Agent Hub, host side (ADR-0007). The host runs the user's own AI CLI (Claude Code or Codex) in a scoped working
//! directory and streams its output; it never reads, copies or passes provider credentials.
//!
//! The webview is untrusted (ADR-0008), so this is not a general process API:
//!
//! - Only a known provider's binary runs, found by the host (`PATH` plus the usual install folders). The webview
//!   never names a program or a path.
//! - Every argument list is checked against the provider's policy (`claude::validate`, `codex::validate`) before anything runs. The
//!   prompt goes to the child's stdin, never on the command line.
//! - The working directory is a fresh `0700` folder under the app data directory
//!   (`<data>/agent-runs/<run>/work`), named by an unguessable handle. The webview fills it before the start through
//!   `agent.fs.*` (scoped like `VaultFs`: relative paths, no symlinks) and reads it back for review. Nothing in a
//!   vault is touched here: changes reach the vault only through the webview's compare-and-swap writes after review.
//! - The child inherits the user's environment minus `THOTH_*` variables and any variable that names an open vault;
//!   `PWD` is the working directory. It runs in its own process group: cancel, timeout and shutdown signal the whole
//!   group (SIGTERM, then SIGKILL after a grace period), and stragglers are killed once the CLI exits.
//! - Output is pulled (`agent.events`, a bounded long poll), so no event is lost before the webview listens. Lines
//!   and totals are capped; a run that prints too much is stopped.
//! - Run folders are deleted on dispose and shutdown, and `agent.sweep` deletes any left by a crash.
//!
//! - A run's time limit and spending limit are validated, not clamped (`limits.rs`, `claude.rs`).
//! - Local-only run details (transcripts, proposed files) live in `<data>/agent-history/<run id>/` (`history.rs`),
//!   never in a vault.
//!
//! Thoth adds no OS-level sandbox of its own in this phase: the CLI runs with the user's permissions. The
//! restrictions are the CLI's own, which the policies make mandatory: Claude Code's tool restrictions
//! (`--restricted`, `--tools`; no shell at all), and Codex's own OS sandbox (Seatbelt, bubblewrap/Landlock, the
//! Windows sandbox) under Thoth's permission profile, which its commands and file edits run in (`codex.rs`). Codex is
//! not run where its sandbox probe fails.
pub mod claude;
pub mod codex;
// Windows: install folders and launchers (detect_windows), Job Objects instead of process groups (kill_windows).
#[cfg(windows)]
mod detect_windows;
pub mod history;
#[cfg(windows)]
pub mod kill_windows;
pub mod limits;

use crate::error::{HostError, HostResult};
use crate::handles;
use crate::vault_fs::VaultFs;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const RUNS_DIR: &str = "agent-runs";
const WORK_DIR: &str = "work";
/// Runs that exist at once (created, running or finished but not disposed).
const MAX_RUNS: usize = 16;
/// Runs whose CLI is running at once.
const MAX_ACTIVE: usize = 2;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const MAX_STDOUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_STDERR_LINES: usize = 2000;
const MAX_STDIN_BYTES: usize = 1024 * 1024;
const MAX_BATCH_EVENTS: usize = 500;
const MAX_WAIT_MS: u64 = 10_000;
const KILL_GRACE: Duration = Duration::from_secs(3);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const PROBE_MAX_OUTPUT: usize = 256 * 1024;

/// A CLI the Agent Hub knows (ADR-0007 rule 1): Claude Code, then Codex.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn parse(id: &str) -> HostResult<Self> {
        match id {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            _ => Err(HostError::bad_argument(format!("Unknown agent provider {id:?}"))),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    fn binary_names(self) -> &'static [&'static str] {
        match self {
            #[cfg(windows)]
            Self::Claude => &["claude.exe", "claude.cmd"],
            #[cfg(not(windows))]
            Self::Claude => &["claude"],
            #[cfg(windows)]
            Self::Codex => &["codex.exe", "codex.cmd"],
            #[cfg(not(windows))]
            Self::Codex => &["codex"],
        }
    }

    /// Codex is run by its real path, symlinks resolved: its sandbox lets the binary run itself again (for its file
    /// edits) only under the path it was started as, and a link in a folder the sandbox cannot read (Homebrew's
    /// `bin`, `~/.local/bin`) breaks that.
    fn canonical(self) -> bool {
        matches!(self, Self::Codex)
    }

    /// Fixed probe commands: version, help (for the flags this version knows), the CLI's own login status and, for a
    /// CLI that runs commands in its own sandbox, whether that sandbox starts here (`bin` is the binary found).
    fn probes(self, bin: &Path) -> Vec<(&'static str, Vec<OsString>)> {
        let fixed = |list: &[&str]| list.iter().map(OsString::from).collect::<Vec<_>>();
        match self {
            Self::Claude => vec![("version", fixed(&["--version"])), ("help", fixed(&["--help"])), ("auth", fixed(&["auth", "status", "--json"]))],
            Self::Codex => vec![
                ("version", fixed(&["--version"])),
                ("help", fixed(&["exec", "--help"])),
                ("auth", fixed(&["login", "status"])),
                ("sandbox", codex::sandbox_probe(bin)),
            ],
        }
    }

    fn validate(self, argv: &[String]) -> HostResult<()> {
        match self {
            Self::Claude => claude::validate(argv),
            Self::Codex => codex::validate(argv),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Created,
    Running,
    Done,
}

struct RunState {
    phase: Phase,
    events: Vec<Value>,
    stdout_bytes: usize,
    stderr_lines: usize,
    pgid: Option<i32>,
    /// Why the host is stopping the run (`cancelled`, `timeout`, `output_limit`); `None` while it runs on its own.
    stop: Option<&'static str>,
}

struct Run {
    /// Who created it (a window of the desktop app, ADR-0019): `Agents::release` ends the runs of a window that closed.
    owner: String,
    provider: Provider,
    dir: PathBuf,
    work: PathBuf,
    fs: VaultFs,
    state: Mutex<RunState>,
    changed: Condvar,
}

impl Run {
    fn lock(&self) -> MutexGuard<'_, RunState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn push(&self, state: &mut RunState, mut event: Value) {
        event["seq"] = json!(state.events.len());
        state.events.push(event);
        self.changed.notify_all();
    }
}

pub struct Agents {
    data_dir: Option<PathBuf>,
    /// Test hook (stdio harness `--agent-search-dir`): search only these folders for agent binaries.
    search_dirs: Option<Vec<PathBuf>>,
    runs: Mutex<HashMap<String, Arc<Run>>>,
}

impl Agents {
    pub fn new(data_dir: Option<PathBuf>, search_dirs: Option<Vec<PathBuf>>) -> Self {
        Self { data_dir, search_dirs, runs: Mutex::new(HashMap::new()) }
    }

    fn runs(&self) -> MutexGuard<'_, HashMap<String, Arc<Run>>> {
        self.runs.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn run(&self, handle: &str) -> HostResult<Arc<Run>> {
        self.runs().get(handle).cloned().ok_or_else(|| HostError::bad_handle("agent run"))
    }

    // ---------------------------------------------------------------- detection

    /// The folders searched for a provider's binary, in order: `PATH`, then the usual install locations (a desktop
    /// app started from the Dock or Finder gets a minimal `PATH`).
    pub fn search_dirs(&self) -> Vec<PathBuf> {
        if let Some(dirs) = &self.search_dirs {
            return dirs.clone();
        }
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path).filter(|p| p.is_absolute()));
        }
        #[cfg(windows)]
        dirs.extend(detect_windows::install_dirs());
        #[cfg(not(windows))]
        {
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
            if let Some(home) = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_absolute()) {
                for rel in [".claude/local", ".local/bin", ".npm-global/bin"] {
                    dirs.push(home.join(rel));
                }
            }
            if let Some(prefix) = std::env::var_os("NPM_CONFIG_PREFIX").map(PathBuf::from).filter(|p| p.is_absolute()) {
                dirs.push(prefix.join("bin"));
            }
            // Codex's standalone installer uses `~/.local/bin` (above) unless `CODEX_INSTALL_DIR` names another folder.
            if let Some(dir) = std::env::var_os("CODEX_INSTALL_DIR").map(PathBuf::from).filter(|p| p.is_absolute()) {
                dirs.push(dir);
            }
        }
        let mut unique = Vec::new();
        for dir in dirs {
            if !unique.contains(&dir) {
                unique.push(dir);
            }
        }
        unique
    }

    fn resolve(&self, provider: Provider) -> (Option<PathBuf>, Vec<PathBuf>) {
        let dirs = self.search_dirs();
        for dir in &dirs {
            for name in provider.binary_names() {
                let candidate = dir.join(name);
                if is_executable(&candidate) {
                    // An npm launcher for a native binary runs that binary directly, without cmd.exe.
                    #[cfg(windows)]
                    let candidate = detect_windows::direct_target(candidate);
                    let candidate = if provider.canonical() { crate::paths::canonicalize_path(&candidate).unwrap_or(candidate) } else { candidate };
                    return (Some(candidate), dirs);
                }
            }
        }
        (None, dirs)
    }

    /// Finds the binary and runs its fixed probes. Parsing (version, flags, login) is the adapter's job.
    pub fn detect(&self, provider: &str, exclude: &[PathBuf]) -> HostResult<Value> {
        let provider = Provider::parse(provider)?;
        let (found, searched) = self.resolve(provider);
        let searched: Vec<String> = searched.iter().map(|d| d.to_string_lossy().into_owned()).collect();
        let Some(bin) = found else { return Ok(json!({ "found": false, "searched": searched })) };
        let cwd = std::env::temp_dir();
        let env = child_env(&bin, &cwd, exclude);
        let mut reply = json!({ "found": true, "path": bin.to_string_lossy(), "searched": searched });
        for (key, args) in provider.probes(&bin) {
            reply[key] = probe(&bin, &args, &cwd, &env);
        }
        Ok(reply)
    }

    // --------------------------------------------------------------------- runs

    fn runs_dir(&self) -> HostResult<PathBuf> {
        let data = self.data_dir.as_ref().ok_or_else(|| HostError::not_allowed("Agent runs need the app data folder"))?;
        let dir = data.join(RUNS_DIR);
        std::fs::create_dir_all(&dir).map_err(|e| HostError::io(&e, "mkdir", &dir.to_string_lossy()))?;
        let meta = std::fs::symlink_metadata(&dir).map_err(|e| HostError::io(&e, "lstat", &dir.to_string_lossy()))?;
        if !meta.is_dir() {
            return Err(HostError::unsafe_path(&dir.to_string_lossy(), "agent runs folder is not a directory"));
        }
        set_private(&dir)?;
        Ok(dir)
    }

    /// Creates an empty private working directory for one run.
    pub fn create(&self, provider: &str) -> HostResult<Value> {
        self.create_for("", provider)
    }

    /// `create`, for `owner` (a window): the run ends when that window closes (`release`).
    pub fn create_for(&self, owner: &str, provider: &str) -> HostResult<Value> {
        let provider = Provider::parse(provider)?;
        if self.runs().len() >= MAX_RUNS {
            return Err(HostError::not_allowed("Too many agent runs are open"));
        }
        let handle = handles::new_handle("run")?;
        let dir = self.runs_dir()?.join(&handle);
        std::fs::create_dir(&dir).map_err(|e| HostError::io(&e, "mkdir", &dir.to_string_lossy()))?;
        set_private(&dir)?;
        let work = dir.join(WORK_DIR);
        std::fs::create_dir(&work).map_err(|e| HostError::io(&e, "mkdir", &work.to_string_lossy()))?;
        // Plain form on Windows (`C:\...`, not `\\?\C:\...`): the CLI's working directory, which cmd.exe needs.
        let work = crate::paths::canonicalize_path(&work).map_err(|e| HostError::io(&e, "open", &work.to_string_lossy()))?;
        let fd = crate::open_root_dir(&work)?;
        let run = Arc::new(Run {
            owner: owner.to_owned(),
            provider,
            dir,
            work: work.clone(),
            fs: VaultFs::new(fd, false),
            state: Mutex::new(RunState { phase: Phase::Created, events: Vec::new(), stdout_bytes: 0, stderr_lines: 0, pgid: None, stop: None }),
            changed: Condvar::new(),
        });
        self.runs().insert(handle.clone(), run);
        Ok(json!({ "run": handle, "dir": work.to_string_lossy() }))
    }

    /// The run, for filling its working directory: refused once the CLI has started.
    fn writable(&self, handle: &str) -> HostResult<Arc<Run>> {
        let run = self.run(handle)?;
        if run.lock().phase != Phase::Created {
            return Err(HostError::not_allowed("The working directory can only be filled before the agent starts"));
        }
        Ok(run)
    }

    // The working directory as a scoped file system (the `VaultFs` rules: relative paths, symlinks never followed).

    pub fn stat(&self, handle: &str, path: &str) -> HostResult<Value> {
        self.run(handle)?.fs.stat(path)
    }

    pub fn read(&self, handle: &str, path: &str) -> HostResult<Vec<u8>> {
        self.run(handle)?.fs.read(path)
    }

    pub fn list(&self, handle: &str, dir: &str) -> HostResult<Value> {
        self.run(handle)?.fs.list(dir)
    }

    pub fn mkdirp(&self, handle: &str, dir: &str) -> HostResult<()> {
        self.writable(handle)?.fs.mkdirp(dir)
    }

    /// Exclusive create: staging never replaces a file. `read_only` takes the write permission away afterwards (the
    /// reference copies of workspace pages, which the agent may read but whose changes are never applied).
    pub fn write(&self, handle: &str, path: &str, data: &[u8], read_only: bool) -> HostResult<()> {
        let run = self.writable(handle)?;
        run.fs.write(path, data, true)?;
        if read_only {
            let file = run.work.join(path);
            if !Path::new(path).components().all(|c| matches!(c, std::path::Component::Normal(_))) {
                return Err(HostError::unsafe_path(path, "not a plain relative path"));
            }
            let mut permissions = std::fs::metadata(&file).map_err(|e| HostError::io(&e, "stat", &file.to_string_lossy()))?.permissions();
            permissions.set_readonly(true);
            std::fs::set_permissions(&file, permissions).map_err(|e| HostError::io(&e, "chmod", &file.to_string_lossy()))?;
        }
        Ok(())
    }

    /// Starts the provider's CLI in the run's working directory with `argv` (checked against the policy) and
    /// `stdin` as its standard input.
    pub fn start(&self, handle: &str, argv: &[String], stdin: &[u8], timeout_ms: Option<u64>, exclude: &[PathBuf]) -> HostResult<()> {
        let run = self.run(handle)?;
        run.provider.validate(argv)?;
        if stdin.len() > MAX_STDIN_BYTES {
            return Err(HostError::bad_argument("The task is too long"));
        }
        let timeout = limits::validate_timeout(timeout_ms)?;
        let active = self.runs().values().filter(|r| r.lock().phase == Phase::Running).count();
        if active >= MAX_ACTIVE {
            return Err(HostError::not_allowed("Another agent run is still going"));
        }
        let (bin, _) = self.resolve(run.provider);
        let bin = bin.ok_or_else(|| HostError::new("AGENT_UNAVAILABLE", format!("The {} CLI was not found", run.provider.id())))?;

        let mut state = run.lock();
        if state.phase != Phase::Created {
            return Err(HostError::not_allowed("This agent run has already started"));
        }
        let mut command = Command::new(&bin);
        command.args(argv).current_dir(&run.work).env_clear().envs(child_env(&bin, &run.work, exclude));
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        own_group(&mut command);
        let mut child = command.spawn().map_err(|e| HostError::new("AGENT_UNAVAILABLE", format!("Could not start the {} CLI: {e}", run.provider.id())))?;
        #[cfg(windows)]
        kill_windows::adopt(&mut child).map_err(|e| HostError::new("AGENT_UNAVAILABLE", format!("Could not start the {} CLI: {e}", run.provider.id())))?;
        state.phase = Phase::Running;
        state.pgid = i32::try_from(child.id()).ok();
        drop(state);

        let input = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let prompt = stdin.to_vec();
        std::thread::spawn(move || {
            if let Some(mut input) = input {
                let _ = input.write_all(&prompt);
            }
        });
        let out_reader = stdout.map(|out| {
            let run = run.clone();
            std::thread::spawn(move || read_lines(out, |line, truncated| on_stdout(&run, line, truncated)))
        });
        let err_reader = stderr.map(|err| {
            let run = run.clone();
            std::thread::spawn(move || read_lines(err, |line, truncated| on_stderr(&run, line, truncated)))
        });
        {
            let run = run.clone();
            std::thread::spawn(move || wait_for_exit(&run, child, out_reader, err_reader));
        }
        {
            let run = run.clone();
            std::thread::spawn(move || watchdog(&run, timeout));
        }
        Ok(())
    }

    /// How many runs are going now (an update's restart asks the person first, ADR-0034).
    pub fn running(&self) -> usize {
        self.runs().values().filter(|r| r.lock().phase == Phase::Running).count()
    }

    /// Events after `after` (their `seq`), waiting up to `wait_ms` for one. `done` once the exit event was read.
    pub fn events(&self, handle: &str, after: u64, wait_ms: u64) -> HostResult<Value> {
        let run = self.run(handle)?;
        let after = usize::try_from(after).map_err(|_| HostError::bad_argument("after is too large"))?;
        let deadline = Instant::now() + Duration::from_millis(wait_ms.min(MAX_WAIT_MS));
        let mut state = run.lock();
        while state.events.len() <= after && state.phase != Phase::Done {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            state = run.changed.wait_timeout(state, deadline - now).unwrap_or_else(|p| p.into_inner()).0;
        }
        let start = after.min(state.events.len());
        let end = (start + MAX_BATCH_EVENTS).min(state.events.len());
        let events = state.events[start..end].to_vec();
        let done = state.phase == Phase::Done && end == state.events.len();
        Ok(json!({ "events": events, "next": end, "done": done }))
    }

    /// Stops a run: SIGTERM to its process group, SIGKILL after a grace period. A run that never started ends at once.
    pub fn cancel(&self, handle: &str) -> HostResult<()> {
        let run = self.run(handle)?;
        stop(&run, "cancelled");
        Ok(())
    }

    /// Stops the run if needed and deletes its folder. Idempotent.
    pub fn dispose(&self, handle: &str) -> HostResult<()> {
        let Some(run) = self.runs().remove(handle) else { return Ok(()) };
        stop(&run, "cancelled");
        wait_done(&run, KILL_GRACE + Duration::from_secs(2));
        remove_run_dir(&run.dir)
    }

    /// Deletes run folders that no open run owns (left by a crash or a forced quit). Returns how many.
    pub fn sweep(&self) -> HostResult<usize> {
        let Some(data) = &self.data_dir else { return Ok(0) };
        let dir = data.join(RUNS_DIR);
        let Ok(meta) = std::fs::symlink_metadata(&dir) else { return Ok(0) };
        if !meta.is_dir() {
            return Ok(0);
        }
        let live: Vec<String> = self.runs().keys().cloned().collect();
        let mut removed = 0;
        for entry in std::fs::read_dir(&dir).map_err(|e| HostError::io(&e, "scandir", &dir.to_string_lossy()))?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_run_name(&name) || live.contains(&name) {
                continue;
            }
            remove_run_dir(&entry.path())?;
            removed += 1;
        }
        Ok(removed)
    }

    /// Kills every run's process group and deletes every run folder (app exit).
    pub fn shutdown(&self) {
        let runs: Vec<Arc<Run>> = self.runs().drain().map(|(_, r)| r).collect();
        Self::end_all(runs);
    }

    /// Ends the runs `owner` created, as `shutdown` ends all of them: a window that closes takes its runs with it, as
    /// quitting the app always did (ADR-0019). Returns how many.
    pub fn release(&self, owner: &str) -> usize {
        let runs = self.detach(owner);
        let count = runs.0.len();
        runs.end();
        count
    }

    /// The first, quick half of `release`: `owner`'s run handles stop working at once. `DetachedRuns::end` then stops
    /// the processes and deletes the folders, which may take seconds (it waits for each process to exit).
    pub fn detach(&self, owner: &str) -> DetachedRuns {
        let mut all = self.runs();
        let mine: Vec<String> = all.iter().filter(|(_, r)| r.owner == owner).map(|(h, _)| h.clone()).collect();
        DetachedRuns(mine.iter().filter_map(|h| all.remove(h)).collect())
    }

    fn end_all(runs: Vec<Arc<Run>>) {
        for run in &runs {
            stop(run, "cancelled");
            kill_group(&run.lock(), Signal::Kill);
        }
        for run in runs {
            wait_done(&run, Duration::from_secs(2));
            let _ = remove_run_dir(&run.dir);
        }
    }
}

/// Runs taken out of `Agents` by `detach`, still to be ended.
#[must_use = "the runs go on until `end` is called"]
pub struct DetachedRuns(Vec<Arc<Run>>);

impl DetachedRuns {
    /// Cancels the runs, kills their process groups and deletes their folders (blocks while they exit).
    pub fn end(self) {
        Agents::end_all(self.0);
    }
}

// --------------------------------------------------------------------------- process

#[derive(Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

#[cfg(unix)]
fn own_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn own_group(command: &mut Command) {
    kill_windows::prepare(command);
}

#[cfg(not(any(unix, windows)))]
fn own_group(_command: &mut Command) {}

#[cfg(unix)]
fn signal_group(pgid: i32, signal: Signal) {
    let Some(pid) = rustix::process::Pid::from_raw(pgid) else { return };
    let signal = match signal {
        Signal::Term => rustix::process::Signal::TERM,
        Signal::Kill => rustix::process::Signal::KILL,
    };
    let _ = rustix::process::kill_process_group(pid, signal);
}

/// Windows: the run's Job Object, by the CLI's process id (`kill_windows`).
#[cfg(windows)]
fn signal_group(pgid: i32, signal: Signal) {
    kill_windows::signal(pgid, matches!(signal, Signal::Kill));
}

#[cfg(not(any(unix, windows)))]
fn signal_group(_pgid: i32, _signal: Signal) {}

fn kill_group(state: &RunState, signal: Signal) {
    if let Some(pgid) = state.pgid {
        signal_group(pgid, signal);
    }
}

fn stop(run: &Arc<Run>, reason: &'static str) {
    let mut state = run.lock();
    match state.phase {
        Phase::Done => {}
        Phase::Created => {
            state.phase = Phase::Done;
            run.push(&mut state, json!({ "kind": "exit", "code": null, "signal": null, "reason": reason }));
        }
        Phase::Running => {
            state.stop.get_or_insert(reason);
            kill_group(&state, Signal::Term);
            drop(state);
            let run = run.clone();
            std::thread::spawn(move || {
                if !wait_done(&run, KILL_GRACE) {
                    kill_group(&run.lock(), Signal::Kill);
                }
            });
        }
    }
}

/// True when the run finished within `timeout`.
fn wait_done(run: &Run, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let mut state = run.lock();
    while state.phase != Phase::Done {
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        state = run.changed.wait_timeout(state, deadline - now).unwrap_or_else(|p| p.into_inner()).0;
    }
    true
}

fn watchdog(run: &Arc<Run>, timeout: Duration) {
    if !wait_done(run, timeout) {
        stop(run, "timeout");
    }
}

fn wait_for_exit(run: &Arc<Run>, mut child: Child, out: Option<std::thread::JoinHandle<()>>, err: Option<std::thread::JoinHandle<()>>) {
    let status = child.wait();
    // Whatever the CLI left running in its group (and that would keep the pipes open) goes with it.
    kill_group(&run.lock(), Signal::Kill);
    for reader in [out, err].into_iter().flatten() {
        let _ = reader.join();
    }
    let mut state = run.lock();
    let (code, signal) = match &status {
        Ok(s) => (s.code(), exit_signal(s)),
        Err(_) => (None, None),
    };
    let reason = state.stop.unwrap_or("exited");
    state.phase = Phase::Done;
    run.push(&mut state, json!({ "kind": "exit", "code": code, "signal": signal, "reason": reason }));
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

fn on_stdout(run: &Arc<Run>, line: String, truncated: bool) {
    let mut state = run.lock();
    state.stdout_bytes += line.len() + 1;
    if state.stdout_bytes > MAX_STDOUT_BYTES {
        if state.stop.is_none() {
            drop(state);
            stop(run, "output_limit");
        }
        return;
    }
    let mut event = json!({ "kind": "stdout", "line": line });
    if truncated {
        event["truncated"] = json!(true);
    }
    run.push(&mut state, event);
}

fn on_stderr(run: &Arc<Run>, line: String, truncated: bool) {
    let mut state = run.lock();
    if state.stderr_lines >= MAX_STDERR_LINES {
        return;
    }
    state.stderr_lines += 1;
    let mut event = json!({ "kind": "stderr", "line": line });
    if truncated {
        event["truncated"] = json!(true);
    }
    run.push(&mut state, event);
}

/// Splits a stream into lines (UTF-8, lossy). A line longer than the cap is cut and the rest of it skipped.
fn read_lines(stream: impl Read, mut emit: impl FnMut(String, bool)) {
    let mut reader = BufReader::with_capacity(64 * 1024, stream);
    let mut line: Vec<u8> = Vec::new();
    let mut truncated = false;
    loop {
        let buf = match reader.fill_buf() {
            Ok([]) => break,
            Ok(buf) => buf,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let (chunk, newline) = match buf.iter().position(|b| *b == b'\n') {
            Some(i) => (&buf[..i], Some(i + 1)),
            None => (buf, None),
        };
        let room = MAX_LINE_BYTES.saturating_sub(line.len());
        if chunk.len() > room {
            truncated = true;
        }
        line.extend_from_slice(&chunk[..chunk.len().min(room)]);
        let used = newline.unwrap_or(buf.len());
        reader.consume(used);
        if newline.is_some() {
            let text = String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(&line)).into_owned();
            emit(text, truncated);
            line.clear();
            truncated = false;
        }
    }
    if !line.is_empty() {
        emit(String::from_utf8_lossy(&line).into_owned(), truncated);
    }
}

/// Runs one probe with a deadline and bounded output.
fn probe(bin: &Path, args: &[OsString], cwd: &Path, env: &[(OsString, OsString)]) -> Value {
    let mut command = Command::new(bin);
    command.args(args).current_dir(cwd).env_clear().envs(env.iter().cloned()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    own_group(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return json!({ "code": null, "stdout": "", "stderr": format!("Could not run it: {e}"), "timedOut": false }),
    };
    #[cfg(windows)]
    if let Err(e) = kill_windows::adopt(&mut child) {
        return json!({ "code": null, "stdout": "", "stderr": format!("Could not run it: {e}"), "timedOut": false });
    }
    let pgid = i32::try_from(child.id()).ok();
    let capture = |stream: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(mut stream) = stream {
                let mut buf = [0u8; 8192];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let room = PROBE_MAX_OUTPUT.saturating_sub(out.len());
                    out.extend_from_slice(&buf[..n.min(room)]);
                }
            }
            String::from_utf8_lossy(&out).into_owned()
        })
    };
    let stdout = capture(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let stderr = capture(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                timed_out = true;
                if let Some(pgid) = pgid {
                    signal_group(pgid, Signal::Kill);
                }
                let _ = child.kill();
                break child.wait().ok();
            }
            Err(_) => break None,
        }
    };
    if let Some(pgid) = pgid {
        signal_group(pgid, Signal::Kill);
    }
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    json!({ "code": status.and_then(|s| s.code()), "stdout": stdout, "stderr": stderr, "timedOut": timed_out })
}

/// The child's environment: the user's, minus Thoth's own variables and anything naming an open vault, with the
/// binary's folder on `PATH` (so a CLI that needs a sibling runtime finds it) and `PWD` set to its working directory.
pub fn child_env(bin: &Path, cwd: &Path, exclude: &[PathBuf]) -> Vec<(OsString, OsString)> {
    let excluded: Vec<String> = exclude.iter().map(|p| p.to_string_lossy().into_owned()).filter(|p| p.len() > 1).collect();
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    for (key, value) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if name.starts_with("THOTH_") || name == "PWD" || name == "OLDPWD" {
            continue;
        }
        let text = value.to_string_lossy();
        if excluded.iter().any(|root| text.contains(root.as_str())) {
            continue;
        }
        env.push((key, value));
    }
    let bin_dir = bin.parent().map(Path::to_path_buf);
    if let Some(dir) = bin_dir {
        // Windows names it `Path`; variable names are case-insensitive there.
        #[cfg(windows)]
        let current = env.iter().position(|(k, _)| k.eq_ignore_ascii_case("PATH"));
        #[cfg(not(windows))]
        let current = env.iter().position(|(k, _)| k == "PATH");
        let mut paths: Vec<PathBuf> = current.map(|i| std::env::split_paths(&env[i].1).collect()).unwrap_or_default();
        if !paths.contains(&dir) {
            paths.insert(0, dir);
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            match current {
                Some(i) => env[i].1 = joined,
                None => env.push(("PATH".into(), joined)),
            }
        }
    }
    env.push(("PWD".into(), cwd.as_os_str().to_owned()));
    env
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        detect_windows::launchable(path)
    }
    #[cfg(not(any(unix, windows)))]
    true
}

fn set_private(dir: &Path) -> HostResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| HostError::io(&e, "chmod", &dir.to_string_lossy()))?;
    }
    // Windows has no mode bits: the folder is under %APPDATA% and inherits its ACL (the user, SYSTEM, Administrators).
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// `run_` plus 32 lowercase hex digits: the only names the host creates (and so the only ones it deletes).
fn is_run_name(name: &str) -> bool {
    name.strip_prefix("run_").is_some_and(|hex| hex.len() == 32 && hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
}

/// `remove_dir_all` does not follow symlinks (it unlinks them), so a link the agent made cannot redirect it.
fn remove_run_dir(dir: &Path) -> HostResult<()> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(HostError::io(&e, "rm", &dir.to_string_lossy())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_and_caps_them() {
        let mut lines = Vec::new();
        let long = "x".repeat(MAX_LINE_BYTES + 10);
        let input = format!("one\r\ntwo\n{long}\nthree");
        read_lines(input.as_bytes(), |line, truncated| lines.push((line.len(), truncated)));
        assert_eq!(lines, vec![(3, false), (3, false), (MAX_LINE_BYTES, true), (5, false)]);
    }

    #[test]
    fn run_names_are_only_host_handles() {
        assert!(is_run_name("run_0123456789abcdef0123456789abcdef"));
        for bad in ["run_", "run_0123", "vault_0123456789abcdef0123456789abcdef", "run_0123456789ABCDEF0123456789abcdef", "notes"] {
            assert!(!is_run_name(bad), "{bad}");
        }
    }

    #[test]
    fn child_env_drops_thoth_variables_and_vault_paths() {
        // SAFETY: tests in this module do not read these variables concurrently.
        unsafe {
            std::env::set_var("THOTH_SECRET_FOR_TEST", "x");
            std::env::set_var("NOTES_FOR_TEST", "/Users/someone/Vault/sub");
        }
        let env = child_env(Path::new("/opt/bin/claude"), Path::new("/data/run/work"), &[PathBuf::from("/Users/someone/Vault")]);
        // Windows variable names are case-insensitive (`Path`).
        let get = |k: &str| env.iter().find(|(key, _)| key.eq_ignore_ascii_case(k)).map(|(_, v)| v.to_string_lossy().into_owned());
        assert_eq!(get("THOTH_SECRET_FOR_TEST"), None);
        assert_eq!(get("NOTES_FOR_TEST"), None);
        assert_eq!(get("PWD").as_deref(), Some("/data/run/work"));
        assert!(get("PATH").unwrap().starts_with("/opt/bin"));
        assert_eq!(env.iter().filter(|(k, _)| k == "PWD").count(), 1);
    }
}
