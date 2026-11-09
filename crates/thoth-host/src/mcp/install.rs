//! Setting up an app (ADR-0052 rule 10): the host adds `thoth-mcp` to the app's own MCP settings, so the user does not
//! paste anything.
//!
//! - Claude Code: `claude mcp add --scope user thoth -- <thoth-mcp> --socket <path>`.
//! - Codex and the ChatGPT desktop app: `[mcp_servers.thoth]` in `~/.codex/config.toml`.
//! - Claude Desktop: `mcpServers.thoth` in `claude_desktop_config.json`.
//! - Cursor: `mcpServers.thoth` in `~/.cursor/mcp.json` (what Cursor's install link writes after asking; written here
//!   directly, so Thoth never opens a `cursor://` link).
//!
//! An app that is not set up on this computer (its folder missing) is `UNAVAILABLE`. A `thoth` entry that is
//! already there is left alone (`EEXIST`, or `already` when it is exactly this one) unless the user asked to replace it. Every
//! file is backed up as `<name>.thoth.bak` before it is changed, and written whole with a rename; nothing else in it
//! changes.
//!
//! The instructions (`instructions`): a few lines in the agent's own instruction file, `~/.claude/CLAUDE.md` for Claude
//! Code and `~/.codex/AGENTS.md` for Codex, telling it to use Thoth's memory. Those files weigh more with the agent than
//! the server's instructions. The lines sit between two markers, so they are added once and replaced in place, and the
//! rest of the file is the user's and never changes. Claude Desktop and Cursor keep theirs in their own settings, so the
//! user copies the lines there.
use crate::error::{HostError, HostResult};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

pub const APPS: &[&str] = &["claude-code", "codex", "claude-desktop", "cursor"];
const NAME: &str = "thoth";
/// The largest settings file Thoth edits.
const MAX_FILE: u64 = 4 * 1024 * 1024;

/// The lines added to an agent's instruction file, and what the user copies for the others.
pub const INSTRUCTIONS: &str = "## Thoth
Thoth (the MCP server `thoth`) is my memory, shared by all my agents. At the start of a task that may depend on my preferences, the people I work with or past decisions, call `recall`. When I state a preference, correct you, or make a decision another agent would need, save it with `remember` in Thoth. Check `list_skills` for a skill that fits the task.";
const START: &str = "<!-- thoth:start (added by Thoth; edit or remove freely) -->";
const END: &str = "<!-- thoth:end -->";

/// What `thoth-mcp` is started with.
pub struct Setup {
    pub command: String,
    pub args: Vec<String>,
}

/// Adds the instructions to `app`'s instruction file. Returns `{ status: "added" | "already" | "replaced", file, backup? }`.
pub fn instruct(app: &str, home: &Path) -> HostResult<Value> {
    let path = match app {
        "claude-code" => app_dir(home, ".claude", "Claude Code")?.join("CLAUDE.md"),
        "codex" => app_dir(home, ".codex", "Codex")?.join("AGENTS.md"),
        "claude-desktop" | "cursor" => return Err(HostError::bad_argument("Copy the instructions into the app's own settings")),
        _ => return Err(HostError::bad_argument(format!("app must be one of {}", APPS.join(", ")))),
    };
    let text = read(&path)?.unwrap_or_default();
    let block = format!("{START}\n{INSTRUCTIONS}\n{END}\n");
    let (body, status) = match (text.find(START), text.find(END)) {
        (Some(start), Some(end)) if end > start => {
            let end = end + END.len();
            let end = if text[end..].starts_with('\n') { end + 1 } else { end };
            if text[start..end] == block {
                return Ok(json!({ "status": "already", "file": path }));
            }
            (format!("{}{block}{}", &text[..start], &text[end..]), "replaced")
        }
        (None, None) => {
            let kept = text.trim_end();
            (if kept.is_empty() { block } else { format!("{kept}\n\n{block}") }, "added")
        }
        // One marker without the other: the user edited it; leave the file to them.
        _ => return Err(HostError::new("EEXIST", format!("{} has Thoth's instructions in a form Thoth cannot update: copy them instead", path.display()))),
    };
    let backup = write(&path, (!text.is_empty()).then_some(text.as_str()), &body)?;
    Ok(json!({ "status": status, "file": path, "backup": backup }))
}

/// Runs the `claude` CLI with these arguments: `{ code, stdout, stderr, timedOut }`, or None when it is not installed.
pub type RunClaude<'a> = &'a dyn Fn(&[String]) -> Option<Value>;

/// Sets up `app`. Returns `{ status: "added" | "already" | "replaced", file?, backup? }`.
pub fn install(app: &str, replace: bool, setup: &Setup, home: &Path, claude: RunClaude<'_>) -> HostResult<Value> {
    match app {
        "claude-code" => claude_code(replace, setup, claude),
        "codex" => codex(replace, setup, &app_dir(home, ".codex", "Codex")?.join("config.toml")),
        "claude-desktop" => json_file(replace, setup, &claude_desktop_dir(home)?.join("claude_desktop_config.json")),
        "cursor" => json_file(replace, setup, &app_dir(home, ".cursor", "Cursor")?.join("mcp.json")),
        _ => Err(HostError::bad_argument(format!("app must be one of {}", APPS.join(", ")))),
    }
}

fn app_dir(home: &Path, dir: &str, name: &str) -> HostResult<PathBuf> {
    let path = home.join(dir);
    if !path.is_dir() {
        return Err(HostError::new("UNAVAILABLE", format!("{name} is not set up on this computer: open it once, then try again")));
    }
    Ok(path)
}

fn claude_desktop_dir(home: &Path) -> HostResult<PathBuf> {
    let path = if cfg!(target_os = "macos") { home.join("Library/Application Support/Claude") } else { home.join(".config/Claude") };
    if !path.is_dir() {
        return Err(HostError::new("UNAVAILABLE", "Claude Desktop is not set up on this computer: open it once, then try again"));
    }
    Ok(path)
}

fn claude_code(replace: bool, setup: &Setup, claude: RunClaude<'_>) -> HostResult<Value> {
    let mut add = vec!["mcp".into(), "add".into(), "--scope".into(), "user".into(), NAME.into(), "--".into(), setup.command.clone()];
    add.extend(setup.args.iter().cloned());
    let not_found = || HostError::new("UNAVAILABLE", "Thoth could not find Claude Code (the claude command): copy the command and run it yourself");
    let ran = claude(&add).ok_or_else(not_found)?;
    if ran["code"] == 0 {
        return Ok(json!({ "status": "added" }));
    }
    let said = format!("{} {}", ran["stdout"].as_str().unwrap_or_default(), ran["stderr"].as_str().unwrap_or_default());
    if !said.to_lowercase().contains("already exists") {
        return Err(HostError::new("INTERNAL", format!("Claude Code could not add Thoth: {}", said.trim().chars().take(300).collect::<String>())));
    }
    if !replace {
        return Err(exists("Claude Code"));
    }
    let removed = claude(&["mcp".into(), "remove".into(), "--scope".into(), "user".into(), NAME.into()]).ok_or_else(not_found)?;
    let again = claude(&add).ok_or_else(not_found)?;
    if removed["code"] != 0 || again["code"] != 0 {
        return Err(HostError::new("INTERNAL", "Claude Code could not replace its thoth server: copy the command and run it yourself"));
    }
    Ok(json!({ "status": "replaced" }))
}

fn exists(app: &str) -> HostError {
    HostError::new("EEXIST", format!("{app} already has a server called thoth"))
}

/// `mcpServers.thoth` in a JSON settings file (Claude Desktop, Cursor). Other keys keep their order.
fn json_file(replace: bool, setup: &Setup, path: &Path) -> HostResult<Value> {
    let ours = json!({ "command": setup.command, "args": setup.args });
    let text = read(path)?;
    let mut config: Map<String, Value> = match &text {
        None => Map::new(),
        Some(text) if text.trim().is_empty() => Map::new(),
        Some(text) => match serde_json::from_str(text) {
            Ok(Value::Object(map)) => map,
            _ => return Err(HostError::bad_argument(format!("{} is not a settings file Thoth can read: copy the setup instead", path.display()))),
        },
    };
    let servers = config.entry("mcpServers").or_insert_with(|| json!({}));
    let Some(servers) = servers.as_object_mut() else {
        return Err(HostError::bad_argument(format!("mcpServers in {} is not a list of servers: copy the setup instead", path.display())));
    };
    let status = match servers.get(NAME) {
        Some(existing) if *existing == ours => return Ok(json!({ "status": "already", "file": path })),
        Some(_) if !replace => return Err(exists(&path.display().to_string())),
        Some(_) => "replaced",
        None => "added",
    };
    servers.insert(NAME.into(), ours);
    let body = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| HostError::internal(e.to_string()))? + "\n";
    let backup = write(path, text.as_deref(), &body)?;
    Ok(json!({ "status": status, "file": path, "backup": backup }))
}

/// `[mcp_servers.thoth]` in Codex's `config.toml`, edited as text: the table (and its sub-tables) replaced or added at
/// the end, every other line as it was.
fn codex(replace: bool, setup: &Setup, path: &Path) -> HostResult<Value> {
    // A JSON string is a valid TOML basic string.
    let quote = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let args: Vec<String> = setup.args.iter().map(|a| quote(a)).collect();
    let block = format!("[mcp_servers.{NAME}]\ncommand = {}\nargs = [{}]\n", quote(&setup.command), args.join(", "));
    let text = read(path)?.unwrap_or_default();
    let header = |line: &str| {
        let t = line.trim();
        t.starts_with('[').then(|| t.trim_start_matches('[').trim_end_matches(']').split('#').next().unwrap_or_default().trim().replace(' ', ""))
    };
    let ours = |table: &str| table == format!("mcp_servers.{NAME}") || table.starts_with(&format!("mcp_servers.{NAME}."));
    // Written another way (a dotted key or an inline table): the user edits it.
    let unusual = text.lines().any(|l| {
        let t = l.trim().replace(' ', "");
        header(l).is_none()
            && (t.starts_with(&format!("mcp_servers.{NAME}=")) || t.starts_with(&format!("mcp_servers.{NAME}.")) || t.starts_with(&format!("{NAME}={{")))
    });
    let mut kept = String::new();
    let mut found = String::new();
    let mut inside = false;
    for line in text.split_inclusive('\n') {
        if let Some(table) = header(line) {
            inside = ours(&table);
        }
        if inside { found.push_str(line) } else { kept.push_str(line) }
    }
    if found.trim() == block.trim() && !unusual {
        return Ok(json!({ "status": "already", "file": path }));
    }
    if unusual || (!found.is_empty() && !replace) {
        return Err(exists(&path.display().to_string()));
    }
    let mut body = kept.trim_end().to_owned();
    if !body.is_empty() {
        body.push_str("\n\n");
    }
    body.push_str(&block);
    let backup = write(path, (!text.is_empty()).then_some(text.as_str()), &body)?;
    Ok(json!({ "status": if found.is_empty() { "added" } else { "replaced" }, "file": path, "backup": backup }))
}

fn read(path: &Path) -> HostResult<Option<String>> {
    match std::fs::symlink_metadata(path) {
        Err(_) => return Ok(None),
        Ok(meta) if !meta.is_file() && !meta.file_type().is_symlink() => return Err(HostError::bad_argument(format!("{} is not a file", path.display()))),
        Ok(_) => {}
    }
    let meta = std::fs::metadata(path).map_err(|e| HostError::io(&e, "stat", &path.to_string_lossy()))?;
    if meta.len() > MAX_FILE {
        return Err(HostError::bad_argument(format!("{} is too large for Thoth to edit: copy the setup instead", path.display())));
    }
    let bytes = std::fs::read(path).map_err(|e| HostError::io(&e, "read", &path.to_string_lossy()))?;
    String::from_utf8(bytes).map(Some).map_err(|_| HostError::bad_argument(format!("{} is not text Thoth can edit: copy the setup instead", path.display())))
}

/// Backs up `before` (when there was a file) and writes `body` whole: to a temporary file beside it, then renamed over
/// it (through a link, the file it names). Returns the backup's path.
fn write(path: &Path, before: Option<&str>, body: &str) -> HostResult<Option<PathBuf>> {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = path.parent().ok_or_else(|| HostError::internal("No folder"))?;
    let backup = match before {
        Some(before) => {
            let backup = dir.join(format!("{name}.thoth.bak"));
            std::fs::write(&backup, before).map_err(|e| HostError::io(&e, "write", &backup.to_string_lossy()))?;
            Some(backup)
        }
        None => None,
    };
    let temp = dir.join(format!(".{name}.thoth-{}", std::process::id()));
    std::fs::write(&temp, body).map_err(|e| HostError::io(&e, "write", &temp.to_string_lossy()))?;
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(&path) {
        let _ = std::fs::set_permissions(&temp, meta.permissions());
    }
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        HostError::io(&e, "rename", &path.to_string_lossy())
    })?;
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn setup() -> Setup {
        Setup { command: "/Applications/Thoth.app/Contents/MacOS/thoth-mcp".into(), args: vec!["--socket".into(), "/Users/a b/thoth.sock".into()] }
    }
    fn none(_: &[String]) -> Option<Value> {
        None
    }
    fn code(result: HostResult<Value>) -> &'static str {
        result.unwrap_err().code
    }

    #[test]
    fn codex_gets_its_table_once_and_keeps_every_other_line() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(code(install("codex", false, &setup(), home.path(), &none)), "UNAVAILABLE", "Codex not set up");
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        let file = home.path().join(".codex/config.toml");
        let mine = "model = \"gpt-6\"\n\n[mcp_servers.other]\ncommand = \"x\"\n";
        std::fs::write(&file, mine).unwrap();
        let added = install("codex", false, &setup(), home.path(), &none).unwrap();
        assert_eq!(added["status"], "added");
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            text,
            format!(
                "{}\n\n[mcp_servers.thoth]\ncommand = \"/Applications/Thoth.app/Contents/MacOS/thoth-mcp\"\nargs = [\"--socket\", \"/Users/a b/thoth.sock\"]\n",
                mine.trim_end()
            )
        );
        assert_eq!(std::fs::read_to_string(home.path().join(".codex/config.toml.thoth.bak")).unwrap(), mine);
        assert_eq!(install("codex", false, &setup(), home.path(), &none).unwrap()["status"], "already");

        // Another thoth table (an older setup) stays unless the user replaces it; its sub-tables go with it.
        std::fs::write(&file, format!("{mine}\n[mcp_servers.thoth]\ncommand = \"old\"\n\n[mcp_servers.thoth.env]\nA = \"1\"\n\n[profiles.x]\nmodel = \"y\"\n"))
            .unwrap();
        assert_eq!(code(install("codex", false, &setup(), home.path(), &none)), "EEXIST");
        assert_eq!(install("codex", true, &setup(), home.path(), &none).unwrap()["status"], "replaced");
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(
            !text.contains("old") && !text.contains("thoth.env") && text.contains("[profiles.x]\nmodel = \"y\"") && text.contains("[mcp_servers.other]"),
            "{text}"
        );
        // Written as a dotted key: left to the user.
        std::fs::write(&file, "mcp_servers.thoth.command = \"old\"\n").unwrap();
        assert_eq!(code(install("codex", true, &setup(), home.path(), &none)), "EEXIST");
    }

    #[test]
    fn json_settings_get_mcp_servers_thoth_and_keep_the_rest_in_order() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".cursor")).unwrap();
        let file = home.path().join(".cursor/mcp.json");
        // No file yet: made, nothing to back up.
        let added = install("cursor", false, &setup(), home.path(), &none).unwrap();
        assert_eq!((added["status"].clone(), added["backup"].clone()), (json!("added"), Value::Null));
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(written, json!({ "mcpServers": { "thoth": { "command": setup().command, "args": setup().args } } }));

        std::fs::write(&file, r#"{"zeta":1,"mcpServers":{"other":{"command":"x"},"thoth":{"command":"old"}},"alpha":2}"#).unwrap();
        assert_eq!(code(install("cursor", false, &setup(), home.path(), &none)), "EEXIST");
        assert_eq!(install("cursor", true, &setup(), home.path(), &none).unwrap()["status"], "replaced");
        let text = std::fs::read_to_string(&file).unwrap();
        let keys: Vec<String> = serde_json::from_str::<Map<String, Value>>(&text).unwrap().keys().cloned().collect();
        assert_eq!(keys, ["zeta", "mcpServers", "alpha"]);
        assert!(text.contains("\"other\""));
        assert_eq!(install("cursor", false, &setup(), home.path(), &none).unwrap()["status"], "already");

        std::fs::write(&file, "{ not json").unwrap();
        assert_eq!(code(install("cursor", true, &setup(), home.path(), &none)), "BAD_ARGUMENT");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json", "never written over");
        assert_eq!(code(install("claude-desktop", false, &setup(), home.path(), &none)), "UNAVAILABLE");
        assert_eq!(code(install("vscode", false, &setup(), home.path(), &none)), "BAD_ARGUMENT");
    }

    #[test]
    fn claude_code_is_set_up_with_its_own_command() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(code(install("claude-code", false, &setup(), home.path(), &none)), "UNAVAILABLE");
        let calls = RefCell::new(Vec::<Vec<String>>::new());
        let there = RefCell::new(false);
        let claude = |args: &[String]| {
            calls.borrow_mut().push(args.to_vec());
            let ok = |o: bool| {
                Some(json!({ "code": if o { 0 } else { 1 }, "stdout": "", "stderr": if o { "" } else { "MCP server thoth already exists in user config" } }))
            };
            match args[1].as_str() {
                "add" if *there.borrow() => ok(false),
                "add" => {
                    *there.borrow_mut() = true;
                    ok(true)
                }
                _ => {
                    *there.borrow_mut() = false;
                    ok(true)
                }
            }
        };
        assert_eq!(install("claude-code", false, &setup(), home.path(), &claude).unwrap()["status"], "added");
        assert_eq!(
            calls.borrow()[0],
            ["mcp", "add", "--scope", "user", "thoth", "--", "/Applications/Thoth.app/Contents/MacOS/thoth-mcp", "--socket", "/Users/a b/thoth.sock"]
        );
        assert_eq!(code(install("claude-code", false, &setup(), home.path(), &claude)), "EEXIST");
        assert_eq!(install("claude-code", true, &setup(), home.path(), &claude).unwrap()["status"], "replaced");
        assert_eq!(calls.borrow().iter().filter(|c| c[1] == "remove").count(), 1);
    }

    #[test]
    fn instructions_go_in_once_between_markers_and_keep_the_users_lines() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(code(instruct("claude-code", home.path())), "UNAVAILABLE");
        std::fs::create_dir(home.path().join(".claude")).unwrap();
        let file = home.path().join(".claude/CLAUDE.md");
        std::fs::write(&file, "# Mine\n\nUse tabs.\n").unwrap();
        let done = instruct("claude-code", home.path()).unwrap();
        assert_eq!(done["status"], "added");
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("# Mine\n\nUse tabs.\n\n<!-- thoth:start"), "{text}");
        assert!(text.contains("call `recall`") && text.ends_with("<!-- thoth:end -->\n"));
        assert_eq!(std::fs::read_to_string(home.path().join(".claude/CLAUDE.md.thoth.bak")).unwrap(), "# Mine\n\nUse tabs.\n");
        assert_eq!(instruct("claude-code", home.path()).unwrap()["status"], "already");

        // An older version of the lines is replaced where it is; what the user added after it stays.
        let old = text.replace("call `recall`", "call recall") + "\nMore of mine.\n";
        std::fs::write(&file, &old).unwrap();
        assert_eq!(instruct("claude-code", home.path()).unwrap()["status"], "replaced");
        let now = std::fs::read_to_string(&file).unwrap();
        assert_eq!(now, text.clone() + "\nMore of mine.\n");

        // A marker the user broke: left alone.
        std::fs::write(&file, "<!-- thoth:start (added by Thoth; edit or remove freely) -->\nhalf\n").unwrap();
        assert_eq!(code(instruct("claude-code", home.path())), "EEXIST");
    }

    #[test]
    fn codex_gets_agents_md_and_the_others_are_copied() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        assert_eq!(instruct("codex", home.path()).unwrap()["status"], "added");
        let text = std::fs::read_to_string(home.path().join(".codex/AGENTS.md")).unwrap();
        assert!(text.starts_with("<!-- thoth:start") && text.contains(INSTRUCTIONS));
        assert!(!home.path().join(".codex/AGENTS.md.thoth.bak").exists());
        assert_eq!(code(instruct("cursor", home.path())), "BAD_ARGUMENT");
    }
}
