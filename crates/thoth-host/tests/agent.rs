//! Agent Hub host commands (ADR-0007) against the fake Claude Code CLI in `packages/agent-claude/test/fake-claude`
//! (a Node script: no model is ever called; on Windows through its `claude.cmd` launcher, which also checks how
//! arguments survive `cmd.exe`). Detection, the argument policy, the scoped working directory, the child's cwd and
//! environment, streaming, cancel (the whole process group, or Job Object on Windows), timeout, cleanup and sweep.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use thoth_host::{Browser, FileManager, Host, HostConfig, HostResult, MemorySecretStore, Picker};

struct NoPicker;
impl Picker for NoPicker {
    fn pick_vault(&self) -> Option<PathBuf> {
        None
    }
    fn pick_source(&self, _: bool) -> Option<PathBuf> {
        None
    }
}
struct NoBrowser;
impl Browser for NoBrowser {
    fn open(&self, _: &str) -> HostResult<()> {
        Ok(())
    }
}
struct NoFiles;
impl FileManager for NoFiles {
    fn reveal(&self, _: &Path, _: Option<&Path>) -> HostResult<()> {
        Ok(())
    }
}

fn fake_dir() -> PathBuf {
    canonical(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/agent-claude/test/fake-claude"))
}

/// The host's canonical form (on Windows without the `\\?\` prefix).
fn canonical(path: &Path) -> PathBuf {
    thoth_host::paths::canonicalize_path(path).unwrap()
}

/// The launcher the host finds in the fake CLI's folder.
#[cfg(not(windows))]
const FAKE_LAUNCHER: &str = "claude";
#[cfg(windows)]
const FAKE_LAUNCHER: &str = "claude.cmd";

fn argv(case: usize) -> Vec<String> {
    let text = include_str!("../../../packages/agent-claude/test/fixtures/argv.json");
    let value: Value = serde_json::from_str(text).unwrap();
    value["cases"][case]["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect()
}

struct Fixture {
    host: Host,
    data: tempfile::TempDir,
    vault: tempfile::TempDir,
}

fn fixture(search: Option<Vec<PathBuf>>, data_dir: bool) -> Fixture {
    let data = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let host = Host::new(HostConfig {
        data_dir: data_dir.then(|| data.path().to_owned()),
        allow_roots: vec![vault.path().to_owned()],
        picker: Arc::new(NoPicker),
        events: Arc::new(|_, _| {}),
        disable_hardlink: false,
        secrets: Arc::new(MemorySecretStore::default()),
        browser: Arc::new(NoBrowser),
        file_manager: Arc::new(NoFiles),
        agent_search_dirs: search,
        link_preview_loopback: false,
    });
    Fixture { host, data, vault }
}

fn call(host: &Host, command: &str, args: Value) -> Value {
    host.call(command, &args, None).unwrap_or_else(|e| panic!("{command}: {e}")).0
}

fn call_bytes(host: &Host, command: &str, args: Value, bytes: &[u8]) -> HostResult<Value> {
    host.call(command, &args, Some(bytes)).map(|r| r.0)
}

fn drain(host: &Host, run: &str) -> Vec<Value> {
    let mut events = Vec::new();
    let mut after = 0;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let batch = call(host, "agent.events", json!({ "run": run, "after": after, "waitMs": 2000 }));
        events.extend(batch["events"].as_array().unwrap().iter().cloned());
        after = batch["next"].as_u64().unwrap();
        if batch["done"] == json!(true) {
            return events;
        }
        assert!(Instant::now() < deadline, "the run did not finish");
    }
}

/// What the fake CLI recorded (it writes `fake-claude-record.json` next to its working directory, outside it).
fn record_path(work: &Path) -> PathBuf {
    work.parent().unwrap().join("fake-claude-record.json")
}

fn read_record(work: &Path) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(text) = std::fs::read_to_string(record_path(work))
            && let Ok(value) = serde_json::from_str::<Value>(&text)
        {
            return value;
        }
        assert!(Instant::now() < deadline, "the fake CLI wrote no record");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(windows)]
fn alive(pid: i64) -> bool {
    let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
}

#[cfg(not(windows))]
fn alive(pid: i64) -> bool {
    // `kill -0` without libc: a process is alive while `ps` lists it (zombies are reaped by launchd/init quickly).
    let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
    let stat = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    !stat.is_empty() && !stat.starts_with('Z')
}

fn wait_dead(pid: i64) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(pid) {
        assert!(Instant::now() < deadline, "process {pid} is still running");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Creates a run with one staged page and starts the fake CLI with `prompt`.
fn start(f: &Fixture, prompt: &str, timeout_ms: Option<u64>) -> (String, PathBuf) {
    let created = call(&f.host, "agent.run.create", json!({ "provider": "claude" }));
    let run = created["run"].as_str().unwrap().to_owned();
    let dir = PathBuf::from(created["dir"].as_str().unwrap());
    call(&f.host, "agent.fs.mkdirp", json!({ "run": run, "dir": "Notes" }));
    call_bytes(&f.host, "agent.fs.write", json!({ "run": run, "path": "Notes/Pets.md" }), b"# Pets\n\nI have a cat.\n").unwrap();
    let mut args = json!({ "run": run, "argv": argv(0) });
    if let Some(ms) = timeout_ms {
        args["timeoutMs"] = json!(ms);
    }
    call_bytes(&f.host, "agent.start", args, prompt.as_bytes()).unwrap();
    (run, dir)
}

#[test]
fn detects_a_missing_cli_and_names_the_folders_searched() {
    let empty = tempfile::tempdir().unwrap();
    let f = fixture(Some(vec![empty.path().to_owned()]), true);
    let probe = call(&f.host, "agent.detect", json!({ "provider": "claude" }));
    assert_eq!(probe["found"], json!(false));
    assert_eq!(probe["searched"], json!([empty.path().to_string_lossy()]));
    assert_eq!(f.host.call("agent.detect", &json!({ "provider": "sh" }), None).unwrap_err().code, "BAD_ARGUMENT");
}

#[test]
fn detects_a_present_cli_with_its_version_help_and_login() {
    let f = fixture(Some(vec![fake_dir()]), true);
    let probe = call(&f.host, "agent.detect", json!({ "provider": "claude" }));
    assert_eq!(probe["found"], json!(true));
    assert_eq!(probe["path"], json!(fake_dir().join(FAKE_LAUNCHER).to_string_lossy()));
    assert_eq!(probe["version"]["stdout"], json!("2.1.310 (Claude Code)\n"));
    assert_eq!(probe["version"]["code"], json!(0));
    assert!(probe["help"]["stdout"].as_str().unwrap().contains("--restricted"));
    assert!(probe["auth"]["stdout"].as_str().unwrap().contains("\"loggedIn\": true"));
}

#[test]
fn runs_in_the_private_working_directory_with_only_the_staged_files() {
    let f = fixture(Some(vec![fake_dir()]), true);
    // An open vault: no variable naming it may reach the agent.
    let vault_root = canonical(f.vault.path());
    call(&f.host, "vault.open", json!({ "root": vault_root.to_string_lossy() }));
    unsafe {
        std::env::set_var("THOTH_AGENT_TEST_SECRET", "do-not-pass");
        std::env::set_var("AGENT_TEST_NOTES_DIR", vault_root.join("Inbox"));
    }
    let (run, dir) = start(&f, "Tidy up.\n@replace Notes/Pets.md :: cat => dog\n@write Notes/New.md :: # New\\n\n", None);
    let events = drain(&f.host, &run);

    // Streamed: stdout lines in order, numbered, then the exit.
    let stdout: Vec<Value> = events.iter().filter(|e| e["kind"] == "stdout").map(|e| serde_json::from_str(e["line"].as_str().unwrap()).unwrap()).collect();
    assert_eq!(stdout.first().unwrap()["subtype"], json!("init"));
    assert_eq!(stdout.last().unwrap()["type"], json!("result"));
    assert!(events.iter().enumerate().all(|(i, e)| e["seq"] == json!(i)));
    let exit = events.last().unwrap();
    assert_eq!((exit["kind"].as_str(), exit["code"].as_i64(), exit["reason"].as_str()), (Some("exit"), Some(0), Some("exited")));

    // What the CLI saw: the working directory under the data folder, the exact policy argv, the prompt on stdin.
    let record = read_record(&dir);
    let data = canonical(f.data.path());
    assert_eq!(PathBuf::from(record["cwd"].as_str().unwrap()), dir);
    assert!(dir.starts_with(data.join("agent-runs")) && dir.ends_with("work"));
    assert_eq!(record["argv"], json!(argv(0)));
    assert_eq!(record["stdin"].as_str().unwrap(), "Tidy up.\n@replace Notes/Pets.md :: cat => dog\n@write Notes/New.md :: # New\\n\n");
    assert_eq!(record["files"], json!([{ "path": "Notes", "kind": "directory" }, { "path": "Notes/Pets.md", "kind": "file" }]));
    let env = record["env"].as_object().unwrap();
    assert_eq!(env.get("PWD"), Some(&json!(dir.to_string_lossy())));
    assert!(env.keys().all(|k| !k.to_ascii_uppercase().starts_with("THOTH_")), "{:?}", env.keys().collect::<Vec<_>>());
    let root = vault_root.to_string_lossy();
    assert!(env.values().all(|v| !v.as_str().unwrap_or_default().contains(root.as_ref())));
    assert!(record["argv"].as_array().unwrap().iter().all(|a| !a.as_str().unwrap().contains(root.as_ref())));

    // The private folder, and the agent's edits readable through the scoped API.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
    let read = |path: &str| f.host.call("agent.fs.read", &json!({ "run": run, "path": path }), None).unwrap().1.unwrap();
    assert_eq!(read("Notes/Pets.md"), b"# Pets\n\nI have a dog.\n");
    assert_eq!(read("Notes/New.md"), b"# New\n");
    // Filling is over once the CLI started.
    assert_eq!(call_bytes(&f.host, "agent.fs.write", json!({ "run": run, "path": "late.md" }), b"x").unwrap_err().code, "NOT_ALLOWED");

    call(&f.host, "agent.run.dispose", json!({ "run": run }));
    assert!(!dir.parent().unwrap().exists());
    assert_eq!(f.host.call("agent.events", &json!({ "run": run, "after": 0, "waitMs": 0 }), None).unwrap_err().code, "BAD_HANDLE");
}

#[test]
fn refuses_arguments_outside_the_policy_without_running_anything() {
    let f = fixture(Some(vec![fake_dir()]), true);
    let created = call(&f.host, "agent.run.create", json!({ "provider": "claude" }));
    let run = created["run"].as_str().unwrap();
    let work = PathBuf::from(created["dir"].as_str().unwrap());
    for extra in [vec!["--add-dir", "/"], vec!["--dangerously-skip-permissions"], vec!["do something"]] {
        let mut list = argv(0);
        list.extend(extra.iter().map(|s| (*s).to_owned()));
        let error = call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": list }), b"hi").unwrap_err();
        assert_eq!(error.code, "NOT_ALLOWED", "{extra:?}");
    }
    let mut tools = argv(0);
    let i = tools.iter().position(|a| a == "--tools").unwrap();
    tools[i + 1] = "Read,Bash".into();
    assert_eq!(call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": tools }), b"hi").unwrap_err().code, "NOT_ALLOWED");
    std::thread::sleep(Duration::from_millis(200));
    assert!(!record_path(&work).exists(), "the CLI must not have run");
    // The run can still start with the policy's arguments.
    call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": argv(1) }), b"hi").unwrap();
    assert_eq!(drain(&f.host, run).last().unwrap()["code"], json!(0));
}

#[test]
fn the_working_directory_api_is_scoped_and_never_follows_symlinks() {
    let f = fixture(Some(vec![fake_dir()]), true);
    let outside = f.vault.path().join("secret.md");
    std::fs::write(&outside, "secret").unwrap();
    let created = call(&f.host, "agent.run.create", json!({ "provider": "claude" }));
    let run = created["run"].as_str().unwrap();
    for bad in ["../x.md", "/etc/passwd", "a/../../x", ""] {
        let code = call_bytes(&f.host, "agent.fs.write", json!({ "run": run, "path": bad }), b"x").unwrap_err().code;
        assert!(code == "UNSAFE_PATH", "{bad}: {code}");
    }
    let prompt = format!("@symlink link.md -> {}\n@symlink dir -> {}\n", outside.display(), f.vault.path().display());
    call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": argv(0) }), prompt.as_bytes()).unwrap();
    drain(&f.host, run);
    let listed = call(&f.host, "agent.fs.list", json!({ "run": run, "dir": "" }));
    let mut kinds: Vec<(String, String)> =
        listed.as_array().unwrap().iter().map(|e| (e["name"].as_str().unwrap().into(), e["kind"].as_str().unwrap().into())).collect();
    kinds.sort();
    assert_eq!(kinds, vec![("dir".into(), "symlink".into()), ("link.md".into(), "symlink".into())]);
    assert!(f.host.call("agent.fs.read", &json!({ "run": run, "path": "link.md" }), None).is_err());
    assert!(f.host.call("agent.fs.read", &json!({ "run": run, "path": "dir/secret.md" }), None).is_err());
    assert!(f.host.call("agent.fs.list", &json!({ "run": run, "dir": "dir" }), None).is_err());
}

#[test]
fn cancel_kills_the_whole_process_group() {
    let f = fixture(Some(vec![fake_dir()]), true);
    let (run, work) = start(&f, "@hang\n", None);
    let deadline = Instant::now() + Duration::from_secs(20);
    let record = loop {
        let record = read_record(&work);
        if record["grandchild"].is_number() {
            break record;
        }
        assert!(Instant::now() < deadline, "no grandchild");
        std::thread::sleep(Duration::from_millis(20));
    };
    let (cli, grandchild) = (record["pid"].as_i64().unwrap(), record["grandchild"].as_i64().unwrap());
    assert!(alive(cli) && alive(grandchild));
    call(&f.host, "agent.cancel", json!({ "run": run }));
    let exit = drain(&f.host, &run).pop().unwrap();
    assert_eq!(exit["reason"], json!("cancelled"));
    // The fake CLI exits 143 on SIGTERM, as Claude Code does; Windows ends the Job Object at once.
    #[cfg(not(windows))]
    assert_eq!(exit["code"], json!(143));
    #[cfg(windows)]
    assert_eq!(exit["code"], json!(thoth_host::agent::kill_windows::TERMINATED_EXIT_CODE));
    wait_dead(cli);
    wait_dead(grandchild);
}

/// POSIX only: Windows has no SIGTERM to ignore, the Job Object is terminated at once.
#[test]
#[cfg(unix)]
fn a_cli_that_ignores_sigterm_is_killed_after_the_grace_period() {
    let f = fixture(Some(vec![fake_dir()]), true);
    let (run, work) = start(&f, "@ignore-term\n@hang\n", None);
    let deadline = Instant::now() + Duration::from_secs(20);
    while !read_record(&work)["grandchild"].is_number() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    let began = Instant::now();
    call(&f.host, "agent.cancel", json!({ "run": run }));
    let exit = drain(&f.host, &run).pop().unwrap();
    assert_eq!(exit["reason"], json!("cancelled"));
    assert_eq!(exit["signal"], json!(9));
    assert!(began.elapsed() >= Duration::from_secs(2), "SIGKILL only after the grace period");
}

#[test]
fn a_run_past_its_time_limit_is_stopped() {
    let f = fixture(Some(vec![fake_dir()]), true);
    let (run, _) = start(&f, "@hang\n", Some(1000));
    let exit = drain(&f.host, &run).pop().unwrap();
    assert_eq!(exit["reason"], json!("timeout"));
}

#[test]
fn sweep_deletes_only_folders_left_by_earlier_sessions_and_shutdown_deletes_the_rest() {
    let f = fixture(Some(vec![fake_dir()]), true);
    let runs = f.data.path().join("agent-runs");
    let created = call(&f.host, "agent.run.create", json!({ "provider": "claude" }));
    let live = PathBuf::from(created["dir"].as_str().unwrap());
    let stale = runs.join("run_0123456789abcdef0123456789abcdef");
    std::fs::create_dir_all(stale.join("work")).unwrap();
    std::fs::write(stale.join("work/page.md"), "left behind").unwrap();
    let other = runs.join("not-a-run");
    std::fs::create_dir_all(&other).unwrap();
    assert_eq!(call(&f.host, "agent.sweep", json!({})), json!({ "removed": 1 }));
    assert!(!stale.exists() && other.exists() && live.exists());
    f.host.shutdown();
    assert!(!live.parent().unwrap().exists());
}

#[test]
fn runs_need_the_app_data_folder() {
    let f = fixture(Some(vec![fake_dir()]), false);
    assert_eq!(f.host.call("agent.run.create", &json!({ "provider": "claude" }), None).unwrap_err().code, "NOT_ALLOWED");
    assert_eq!(call(&f.host, "agent.sweep", json!({})), json!({ "removed": 0 }));
}

fn with_budget(case: usize, budget: &str) -> Vec<String> {
    let mut list = argv(case);
    match list.iter().position(|a| a == "--max-budget-usd") {
        Some(i) => list[i + 1] = budget.to_owned(),
        None => list.extend(["--max-budget-usd".to_owned(), budget.to_owned()]),
    }
    list
}

#[test]
fn a_time_limit_must_be_between_one_second_and_twenty_four_hours() {
    let f = fixture(Some(vec![fake_dir()]), true);
    let created = call(&f.host, "agent.run.create", json!({ "provider": "claude" }));
    let run = created["run"].as_str().unwrap();
    let work = PathBuf::from(created["dir"].as_str().unwrap());
    // Refused, not clamped: nothing runs and the run can still be started with a good value.
    for ms in [json!(0), json!(999), json!(24 * 60 * 60 * 1000 + 1), json!(u64::MAX), json!(-5), json!(1.5), json!("30")] {
        let error = call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": argv(0), "timeoutMs": ms }), b"hi").unwrap_err();
        assert_eq!(error.code, "BAD_ARGUMENT", "{ms}");
    }
    std::thread::sleep(Duration::from_millis(200));
    assert!(!record_path(&work).exists(), "the CLI must not have run");
    // The Agent Hub's choices (5, 15, 30, 60 minutes) and the 24 hour maximum are accepted.
    call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": argv(0), "timeoutMs": 24 * 60 * 60 * 1000 }), b"hi").unwrap();
    assert_eq!(drain(&f.host, run).last().unwrap()["reason"], json!("exited"));
    for minutes in [5u64, 15, 30, 60] {
        let (run, _) = start(&f, "hi", Some(minutes * 60_000));
        assert_eq!(drain(&f.host, &run).last().unwrap()["code"], json!(0), "{minutes} minutes");
    }
}

#[test]
fn a_budget_must_be_positive_and_at_most_one_hundred_dollars() {
    let f = fixture(Some(vec![fake_dir()]), true);
    let created = call(&f.host, "agent.run.create", json!({ "provider": "claude" }));
    let run = created["run"].as_str().unwrap();
    let work = PathBuf::from(created["dir"].as_str().unwrap());
    for bad in ["0", "0.00", "-1", "100.01", "101", "1000", "1e2", "NaN", "0.001", "five"] {
        assert_eq!(call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": with_budget(0, bad) }), b"hi").unwrap_err().code, "NOT_ALLOWED", "{bad}");
    }
    std::thread::sleep(Duration::from_millis(200));
    assert!(!record_path(&work).exists(), "the CLI must not have run");
    // The Agent Hub's choices, and the maximum.
    for good in ["0.25", "0.5", "1", "2", "5", "100"] {
        let (run, work) = start_with(&f, with_budget(0, good), "hi");
        assert_eq!(drain(&f.host, &run).last().unwrap()["code"], json!(0), "{good}");
        let record = read_record(&work);
        let args = record["argv"].as_array().unwrap();
        assert_eq!(args[args.iter().position(|a| a == "--max-budget-usd").unwrap() + 1], json!(good));
    }
}

fn start_with(f: &Fixture, list: Vec<String>, prompt: &str) -> (String, PathBuf) {
    let created = call(&f.host, "agent.run.create", json!({ "provider": "claude" }));
    let run = created["run"].as_str().unwrap().to_owned();
    call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": list }), prompt.as_bytes()).unwrap();
    (run, PathBuf::from(created["dir"].as_str().unwrap()))
}

#[test]
fn a_budget_stop_is_reported_by_the_cli_itself() {
    let f = fixture(Some(vec![fake_dir()]), true);
    let (run, _) = start_with(&f, with_budget(0, "0.25"), "@budget\n");
    let events = drain(&f.host, &run);
    let result: Value = events
        .iter()
        .filter(|e| e["kind"] == "stdout")
        .map(|e| serde_json::from_str::<Value>(e["line"].as_str().unwrap()).unwrap())
        .find(|v| v["type"] == "result")
        .unwrap();
    assert_eq!(result["subtype"], json!("error_max_budget_usd"));
    assert_eq!(result["errors"], json!(["Reached maximum budget ($0.25)"]));
    assert_eq!(events.last().unwrap()["code"], json!(1));
}

#[cfg(unix)]
#[test]
fn reference_files_can_be_written_read_only() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(Some(vec![fake_dir()]), true);
    let created = call(&f.host, "agent.run.create", json!({ "provider": "claude" }));
    let run = created["run"].as_str().unwrap();
    let work = PathBuf::from(created["dir"].as_str().unwrap());
    call(&f.host, "agent.fs.mkdirp", json!({ "run": run, "dir": "workspace/Team" }));
    call_bytes(&f.host, "agent.fs.write", json!({ "run": run, "path": "workspace/Team/Spec.md", "readOnly": true }), b"# Spec\n").unwrap();
    call_bytes(&f.host, "agent.fs.write", json!({ "run": run, "path": "Mine.md" }), b"# Mine\n").unwrap();
    let mode = |p: &str| std::fs::metadata(work.join(p)).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode("workspace/Team/Spec.md") & 0o222, 0, "no write bit");
    assert_ne!(mode("Mine.md") & 0o200, 0);
    // Still readable through the API, and a second create is refused like any other.
    assert_eq!(f.host.call("agent.fs.read", &json!({ "run": run, "path": "workspace/Team/Spec.md" }), None).unwrap().1.unwrap(), b"# Spec\n");
    assert!(call_bytes(&f.host, "agent.fs.write", json!({ "run": run, "path": "workspace/Team/Spec.md", "readOnly": true }), b"x").is_err());
    assert_eq!(call_bytes(&f.host, "agent.fs.write", json!({ "run": run, "path": "x.md", "readOnly": "yes" }), b"x").unwrap_err().code, "BAD_ARGUMENT");
    // A read-only file does not stop the run folder from being deleted.
    call(&f.host, "agent.run.dispose", json!({ "run": run }));
    assert!(!work.exists());
}

// ------------------------------------------------------------------------------------------------- Codex

/// The fake Codex CLI (`packages/agent-codex/test/fake-codex`), on Windows through its `codex.cmd` launcher.
fn fake_codex_dir() -> PathBuf {
    canonical(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/agent-codex/test/fake-codex"))
}

#[cfg(not(windows))]
const FAKE_CODEX_LAUNCHER: &str = "codex";
#[cfg(windows)]
const FAKE_CODEX_LAUNCHER: &str = "codex.cmd";

fn codex_argv(case: usize) -> Vec<String> {
    let text = include_str!("../../../packages/agent-codex/test/fixtures/argv.json");
    let value: Value = serde_json::from_str(text).unwrap();
    value["cases"][case]["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect()
}

fn read_codex_record(work: &Path) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(text) = std::fs::read_to_string(work.parent().unwrap().join("fake-codex-record.json"))
            && let Ok(value) = serde_json::from_str::<Value>(&text)
        {
            return value;
        }
        assert!(Instant::now() < deadline, "the fake Codex wrote no record");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn start_codex(f: &Fixture, argv: Vec<String>, prompt: &str) -> (String, PathBuf) {
    let created = call(&f.host, "agent.run.create", json!({ "provider": "codex" }));
    let run = created["run"].as_str().unwrap().to_owned();
    let dir = PathBuf::from(created["dir"].as_str().unwrap());
    call(&f.host, "agent.fs.mkdirp", json!({ "run": run, "dir": "Notes" }));
    call_bytes(&f.host, "agent.fs.write", json!({ "run": run, "path": "Notes/Pets.md" }), b"# Pets\n\nI have a cat.\n").unwrap();
    call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": argv }), prompt.as_bytes()).unwrap();
    (run, dir)
}

#[test]
fn detects_codex_with_its_version_help_login_and_sandbox() {
    let f = fixture(Some(vec![fake_codex_dir()]), true);
    let probe = call(&f.host, "agent.detect", json!({ "provider": "codex" }));
    assert_eq!(probe["found"], json!(true));
    assert_eq!(probe["path"], json!(fake_codex_dir().join(FAKE_CODEX_LAUNCHER).to_string_lossy()));
    assert_eq!(probe["version"]["stdout"], json!("codex-cli 0.164.0\n"));
    assert!(probe["help"]["stdout"].as_str().unwrap().contains("--strict-config"), "exec --help");
    assert!(probe["auth"]["stderr"].as_str().unwrap().contains("Logged in using ChatGPT"));
    // The sandbox probe ran the CLI itself, by its path, inside `codex sandbox`.
    assert_eq!((probe["sandbox"]["code"].as_i64(), probe["sandbox"]["stdout"].as_str()), (Some(0), Some("codex-cli 0.164.0\n")));
    // Claude Code has no sandbox probe.
    let claude = fixture(Some(vec![fake_dir()]), true);
    assert!(call(&claude.host, "agent.detect", json!({ "provider": "claude" })).get("sandbox").is_none());
}

/// A link to the CLI (Homebrew's `bin`, `~/.local/bin`) is resolved: Codex runs by its real path.
#[cfg(unix)]
#[test]
fn codex_is_run_by_its_real_path() {
    let links = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(fake_codex_dir().join("codex"), links.path().join("codex")).unwrap();
    let f = fixture(Some(vec![links.path().to_owned()]), true);
    let probe = call(&f.host, "agent.detect", json!({ "provider": "codex" }));
    assert_eq!(probe["path"], json!(fake_codex_dir().join("codex").to_string_lossy()));
}

#[test]
fn runs_codex_with_exactly_the_policy_arguments_in_the_working_directory() {
    let f = fixture(Some(vec![fake_codex_dir()]), true);
    let vault_root = canonical(f.vault.path());
    call(&f.host, "vault.open", json!({ "root": vault_root.to_string_lossy() }));
    let (run, dir) = start_codex(&f, codex_argv(1), "Tidy up.\n@replace Notes/Pets.md :: cat => dog\n@run ls\n");
    let events = drain(&f.host, &run);
    let stdout: Vec<Value> = events.iter().filter(|e| e["kind"] == "stdout").map(|e| serde_json::from_str(e["line"].as_str().unwrap()).unwrap()).collect();
    assert_eq!(stdout.first().unwrap()["type"], json!("thread.started"));
    assert_eq!(stdout.last().unwrap()["type"], json!("turn.completed"));
    assert!(stdout.iter().any(|e| e["item"]["type"] == "file_change"));
    let exit = events.last().unwrap();
    assert_eq!((exit["code"].as_i64(), exit["reason"].as_str()), (Some(0), Some("exited")));

    let record = read_codex_record(&dir);
    assert_eq!(PathBuf::from(record["cwd"].as_str().unwrap()), dir);
    assert_eq!(record["argv"], json!(codex_argv(1)));
    assert_eq!(record["stdin"].as_str().unwrap(), "Tidy up.\n@replace Notes/Pets.md :: cat => dog\n@run ls\n");
    assert_eq!(record["files"], json!([{ "path": "Notes", "kind": "directory" }, { "path": "Notes/Pets.md", "kind": "file" }]));
    let env = record["env"].as_object().unwrap();
    assert!(env.keys().all(|k| !k.to_ascii_uppercase().starts_with("THOTH_")));
    let root = vault_root.to_string_lossy();
    assert!(env.values().all(|v| !v.as_str().unwrap_or_default().contains(root.as_ref())));
    let read = |path: &str| f.host.call("agent.fs.read", &json!({ "run": run, "path": path }), None).unwrap().1.unwrap();
    assert_eq!(read("Notes/Pets.md"), b"# Pets\n\nI have a dog.\n");
    call(&f.host, "agent.run.dispose", json!({ "run": run }));
    assert!(!dir.parent().unwrap().exists());
}

#[test]
fn refuses_codex_arguments_outside_the_policy_without_running_anything() {
    let f = fixture(Some(vec![fake_codex_dir(), fake_dir()]), true);
    let created = call(&f.host, "agent.run.create", json!({ "provider": "codex" }));
    let run = created["run"].as_str().unwrap();
    let work = PathBuf::from(created["dir"].as_str().unwrap());
    let extras: [&[&str]; 7] = [
        &["--sandbox", "danger-full-access"],
        &["--dangerously-bypass-approvals-and-sandbox"],
        &["-c", "permissions.thoth.network.enabled=true"],
        &["--add-dir", "/"],
        &["--search"],
        &["do something"],
        &["-m", "--add-dir"],
    ];
    for extra in extras {
        let mut list = codex_argv(0);
        list.extend(extra.iter().map(|s| (*s).to_owned()));
        assert_eq!(call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": list }), b"hi").unwrap_err().code, "NOT_ALLOWED", "{extra:?}");
    }
    // A sandbox setting changed in place, and another provider's list, are refused too.
    let mut changed = codex_argv(0);
    let i = changed.iter().position(|a| a == "approval_policy=never").unwrap();
    changed[i] = "approval_policy=on-request".into();
    assert_eq!(call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": changed }), b"hi").unwrap_err().code, "NOT_ALLOWED");
    assert_eq!(call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": argv(0) }), b"hi").unwrap_err().code, "NOT_ALLOWED");
    let claude = call(&f.host, "agent.run.create", json!({ "provider": "claude" }));
    assert_eq!(call_bytes(&f.host, "agent.start", json!({ "run": claude["run"], "argv": codex_argv(0) }), b"hi").unwrap_err().code, "NOT_ALLOWED");
    std::thread::sleep(Duration::from_millis(200));
    assert!(!work.parent().unwrap().join("fake-codex-record.json").exists(), "the CLI must not have run");
    // The run can still start with the policy's arguments.
    call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": codex_argv(0) }), b"hi").unwrap();
    assert_eq!(drain(&f.host, run).last().unwrap()["code"], json!(0));
}

#[test]
fn cancel_kills_codex_and_everything_it_started() {
    let f = fixture(Some(vec![fake_codex_dir()]), true);
    let (run, work) = start_codex(&f, codex_argv(0), "@hang\n");
    let deadline = Instant::now() + Duration::from_secs(20);
    let record = loop {
        let record = read_codex_record(&work);
        if record["grandchild"].is_number() {
            break record;
        }
        assert!(Instant::now() < deadline, "no grandchild");
        std::thread::sleep(Duration::from_millis(20));
    };
    let (cli, grandchild) = (record["pid"].as_i64().unwrap(), record["grandchild"].as_i64().unwrap());
    assert!(alive(cli) && alive(grandchild));
    call(&f.host, "agent.cancel", json!({ "run": run }));
    assert_eq!(drain(&f.host, &run).pop().unwrap()["reason"], json!("cancelled"));
    wait_dead(cli);
    wait_dead(grandchild);
}

#[test]
fn a_codex_run_past_its_time_limit_is_stopped() {
    let f = fixture(Some(vec![fake_codex_dir()]), true);
    let created = call(&f.host, "agent.run.create", json!({ "provider": "codex" }));
    let run = created["run"].as_str().unwrap();
    for ms in [json!(0), json!(24 * 60 * 60 * 1000 + 1)] {
        assert_eq!(
            call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": codex_argv(0), "timeoutMs": ms }), b"hi").unwrap_err().code,
            "BAD_ARGUMENT",
            "{ms}"
        );
    }
    call_bytes(&f.host, "agent.start", json!({ "run": run, "argv": codex_argv(0), "timeoutMs": 1000 }), b"@hang\n").unwrap();
    assert_eq!(drain(&f.host, run).pop().unwrap()["reason"], json!("timeout"));
}

const HISTORY_ID: &str = "019e0000-0000-7000-8000-0000000000aa";

#[test]
fn local_run_details_live_in_the_app_data_folder_only() {
    let f = fixture(Some(vec![fake_dir()]), true);
    let write = |name: &str, data: &[u8]| call_bytes(&f.host, "agent.history.write", json!({ "id": HISTORY_ID, "name": name }), data);
    write("review.json", b"{\"changes\":[]}").unwrap();
    write("transcript.jsonl", b"{\"type\":\"text\"}\n").unwrap();
    write("change-0001.bin", &[0, 1, 2, 255]).unwrap();
    assert_eq!(f.host.call("agent.history.read", &json!({ "id": HISTORY_ID, "name": "change-0001.bin" }), None).unwrap().1.unwrap(), vec![0, 1, 2, 255]);
    let listed = call(&f.host, "agent.history.list", json!({}));
    assert_eq!(listed[0]["id"], json!(HISTORY_ID));
    assert_eq!(
        listed[0]["files"],
        json!([{ "name": "change-0001.bin", "size": 4 }, { "name": "review.json", "size": 14 }, { "name": "transcript.jsonl", "size": 16 }])
    );
    assert!(listed[0]["modifiedMs"].as_u64().unwrap() > 1_600_000_000_000);
    assert!(f.data.path().join("agent-history").join(HISTORY_ID).join("review.json").is_file());
    // Never under a vault.
    assert!(std::fs::read_dir(f.vault.path()).unwrap().next().is_none());

    // Only a UUID and a flat name can be addressed.
    for (id, name) in [("../etc", "a.bin"), (HISTORY_ID, "../x"), (HISTORY_ID, "sub/x"), (HISTORY_ID, ".x"), ("run_0123456789abcdef0123456789abcdef", "a.bin")]
    {
        assert_eq!(call_bytes(&f.host, "agent.history.write", json!({ "id": id, "name": name }), b"x").unwrap_err().code, "BAD_ARGUMENT", "{id} {name}");
        assert_eq!(f.host.call("agent.history.read", &json!({ "id": id, "name": name }), None).unwrap_err().code, "BAD_ARGUMENT", "{id} {name}");
    }
    assert_eq!(f.host.call("agent.history.read", &json!({ "id": HISTORY_ID, "name": "missing.bin" }), None).unwrap_err().code, "ENOENT");
    assert_eq!(f.host.call("agent.history.write", &json!({ "id": HISTORY_ID, "name": "a.bin" }), None).unwrap_err().code, "BAD_ARGUMENT");

    // Run folders and the sweep of working directories are separate: a sweep never touches the details.
    call(&f.host, "agent.sweep", json!({}));
    assert_eq!(call(&f.host, "agent.history.list", json!({})).as_array().unwrap().len(), 1);
    call(&f.host, "agent.history.delete", json!({ "id": HISTORY_ID }));
    call(&f.host, "agent.history.delete", json!({ "id": HISTORY_ID }));
    assert_eq!(call(&f.host, "agent.history.list", json!({})), json!([]));
}

#[test]
fn local_run_details_need_the_app_data_folder() {
    let f = fixture(Some(vec![fake_dir()]), false);
    assert_eq!(call(&f.host, "agent.history.list", json!({})), json!([]));
    assert_eq!(call_bytes(&f.host, "agent.history.write", json!({ "id": HISTORY_ID, "name": "a.bin" }), b"x").unwrap_err().code, "NOT_ALLOWED");
}
