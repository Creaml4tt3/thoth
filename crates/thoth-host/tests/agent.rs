//! Agent Hub host commands (ADR-0007) against the fake Claude Code CLI in `packages/agent-claude/test/fake-claude`
//! (a Node script: no model is ever called). Detection, the argument policy, the scoped working directory, the
//! child's cwd and environment, streaming, cancel (the whole process group), timeout, cleanup and sweep.
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
    fn reveal(&self, _: &Path) -> HostResult<()> {
        Ok(())
    }
}

fn fake_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/agent-claude/test/fake-claude").canonicalize().unwrap()
}

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
        if let Ok(text) = std::fs::read_to_string(record_path(work)) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                return value;
            }
        }
        assert!(Instant::now() < deadline, "the fake CLI wrote no record");
        std::thread::sleep(Duration::from_millis(20));
    }
}

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
    assert_eq!(probe["path"], json!(fake_dir().join("claude").to_string_lossy()));
    assert_eq!(probe["version"]["stdout"], json!("2.1.310 (Claude Code)\n"));
    assert_eq!(probe["version"]["code"], json!(0));
    assert!(probe["help"]["stdout"].as_str().unwrap().contains("--restricted"));
    assert!(probe["auth"]["stdout"].as_str().unwrap().contains("\"loggedIn\": true"));
}

#[test]
fn runs_in_the_private_working_directory_with_only_the_staged_files() {
    let f = fixture(Some(vec![fake_dir()]), true);
    // An open vault: no variable naming it may reach the agent.
    let vault_root = f.vault.path().canonicalize().unwrap();
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
    let data = f.data.path().canonicalize().unwrap();
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
    let mut kinds: Vec<(String, String)> = listed.as_array().unwrap().iter().map(|e| (e["name"].as_str().unwrap().into(), e["kind"].as_str().unwrap().into())).collect();
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
    assert_eq!(exit["code"], json!(143));
    wait_dead(cli);
    wait_dead(grandchild);
}

#[test]
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
