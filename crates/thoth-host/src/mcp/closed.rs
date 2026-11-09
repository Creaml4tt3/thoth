//! With Thoth closed (ADR-0052 rule 9, opt-in): once the user ticks "Let agents use my memory folder while Thoth is
//! closed", `thoth-mcp` answers a few tools itself when the app's socket is not there.
//!
//! - It serves `recall`, `list_memories`, `list_skills`, `get_skill`, and `remember` of a new memory. Every other
//!   tool, and a `remember` that would update a memory, answers `NOT_RUNNING`.
//! - Only for apps the user already allowed, in the shared Private Spaces, and there only in the memory folder recorded
//!   for each (rule 1) and in `Skills/`. Files are read and created through the app's own `openat` layer, which never
//!   follows a symbolic link; nothing is edited or deleted, and the index is never opened (ADR-0019).
//! - A memory saved here follows the rules of a save without review (rule 5): the user's switches, the secret check,
//!   the forgotten list, the limits, and the history for Undo, which the app reads when it starts. The window indexes the
//!   new file when it opens the Private Space.
//! - Without the index, `recall` with a query keeps the memories that contain the query's words, most words first.
use super::memory::{self, History};
use super::tools::{self, Answer, Call, Found, MemoryFilter};
use super::{App, SETTINGS_FILE, Settings, UNNAMED, app_name, log};
use crate::error::{HostError, HostResult};
use crate::vault_fs::VaultFs;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use unicode_normalization::UnicodeNormalization;

/// The tools answered while Thoth is closed.
pub const SERVED: &[&str] = &["recall", "list_memories", "list_skills", "get_skill", "remember"];
/// How old a memory of each kind may be before agents are told to check it (`CHECK_AFTER_DAYS` in memory.ts).
const CHECK_AFTER_DAYS: &[(&str, i64)] = &[("profile", 365), ("preference", 182), ("work", 30), ("people", 182), ("reference", 91), ("note", 182)];
const RECENT_WORK_DAYS: i64 = 30;
/// The most memory files in one Private Space (`MAX_MEMORIES` in memory.ts).
const MAX_MEMORIES: usize = 2000;
/// The largest file read (a memory, a skill file).
const MAX_READ: u64 = 1024 * 1024;
/// How deep the memory folder and a skill's folder are walked, and how many entries at most.
const MAX_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 5000;
const MAX_TITLE: usize = 200;
const MAX_TAGS: usize = 20;
const MAX_TAG: usize = 64;
const MAX_SLUG: usize = 80;
const MAX_SKILL_FILES: usize = 100;
const MAX_DESCRIPTION: usize = 1024;
const DAY: i64 = 86_400;
const ABOUT_ME: &str = "About me.md";
const README: &str = "README.md";
const SKILL_FILE: &str = "SKILL.md";
/// What the user had forgotten (`MEMORY_RECORD_PATH` in memory.ts).
const FORGOTTEN_RECORD: &str = ".thoth/memory.json";

/// Answers one tool call while Thoth is closed, from `dir` (`<data>/mcp`): `{ text, structured }`, or why not. `None`
/// when the user has not switched this on (or Connected apps off), so the caller says Thoth is not running.
pub fn serve(dir: &Path, app: Option<&str>, tool: &str, arguments: &Value) -> Option<HostResult<Value>> {
    if !mine(dir, true) || !mine(&dir.join(SETTINGS_FILE), false) {
        return None;
    }
    let settings = super::load(dir);
    if !(settings.enabled && settings.closed) {
        return None;
    }
    let app = app.and_then(app_name).unwrap_or_else(|| UNNAMED.to_owned());
    let (mut spaces, mut paths) = (Vec::new(), Vec::new());
    let outcome = answer(dir, &settings, &app, tool, arguments, &mut spaces, &mut paths).and_then(|a| {
        let size = a.text.len() + serde_json::to_vec(&a.structured).map_or(usize::MAX, |b| b.len());
        if size > super::MAX_RESPONSE { Err(super::too_large()) } else { Ok(a) }
    });
    let tool = if tools::TOOLS.contains(&tool) { tool } else { "unknown" };
    let mut logged = json!({ "time": log::timestamp(), "app": app, "tool": tool, "spaces": spaces, "paths": paths, "ok": outcome.is_ok() });
    if let Err(error) = &outcome {
        logged["error"] = json!(error.code);
    }
    log::Log::new(Some(dir)).append(&logged);
    Some(outcome.map(|a| json!({ "text": a.text, "structured": a.structured })))
}

/// A folder or file of this user that nobody else may change: what the app wrote, not something put in its place.
fn mine(path: &Path, dir: bool) -> bool {
    use std::os::unix::fs::MetadataExt;
    let me = rustix::process::geteuid().as_raw();
    std::fs::symlink_metadata(path).is_ok_and(|m| (if dir { m.is_dir() } else { m.is_file() }) && m.uid() == me && m.mode() & 0o022 == 0)
}

fn not_running(message: impl Into<String>) -> HostError {
    HostError::new("NOT_RUNNING", message)
}

/// A shared Private Space, named as the app sees it, with its recorded memory folder.
struct Space {
    label: String,
    root: String,
    folder: Option<String>,
}

fn answer(
    dir: &Path,
    settings: &Settings,
    app: &str,
    tool: &str,
    arguments: &Value,
    spaces_out: &mut Vec<String>,
    paths: &mut Vec<String>,
) -> HostResult<Answer> {
    match settings.apps.iter().find(|a| a.name == app) {
        Some(App { allowed: true, .. }) => {}
        Some(_) => return Err(HostError::new("DENIED", format!("{app} may not read your notes: allow it in Thoth, under Settings → Connected apps"))),
        None => return Err(not_running(format!("Thoth is closed, and {app} has not been allowed yet: ask the user to open Thoth and allow it"))),
    }
    if !SERVED.contains(&tool) {
        return Err(not_running(format!(
            "Thoth is closed, and {tool} needs it open. While it is closed, only recall, list_memories, list_skills, get_skill and remember (a new memory) work: ask the user to open Thoth"
        )));
    }
    let call = Call::parse(tool, arguments)?;
    *paths = call.asked_paths();
    let spaces = spaces_of(settings, &call)?;
    *spaces_out = spaces.iter().map(|s| s.label.clone()).collect();
    let answer = if matches!(call, Call::Remember { .. }) {
        remember(dir, settings, app, &call, &spaces[0])?
    } else {
        let now = log::now_secs() as i64;
        let values = spaces.iter().map(|space| read(space, &call, now)).collect::<HostResult<Vec<Value>>>()?;
        let found: Vec<Found<'_>> = spaces.iter().zip(&values).map(|(s, value)| Found { space: &s.label, value }).collect();
        tools::answer(&call, &found)?
    };
    *paths = answer.paths.clone();
    Ok(answer)
}

/// The shared Private Spaces the call goes to, named as the running app names them (by folder name, `Notes (2)` for a
/// second one). A memory call goes only where a memory folder was recorded.
fn spaces_of(settings: &Settings, call: &Call) -> HostResult<Vec<Space>> {
    let mut all: Vec<Space> = Vec::new();
    for root in &settings.spaces {
        let name = Path::new(root).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.clone());
        let mut label = name.clone();
        let mut n = 2;
        while all.iter().any(|s| s.label == label) {
            label = format!("{name} ({n})");
            n += 1;
        }
        let folder = settings.memory_folders.get(root).and_then(|f| tools::memory_folder(f).ok());
        all.push(Space { label, root: root.clone(), folder });
    }
    let names = |list: &[Space]| list.iter().map(|s| format!("{:?}", s.label)).collect::<Vec<_>>().join(", ");
    if let Some(space) = call.space() {
        if !all.iter().any(|s| s.label == space) {
            if call.is_memory() && settings.workspaces.iter().any(|w| w.name == space) {
                return Err(not_running(format!("Thoth is closed: the Team memory of {space} needs it open")));
            }
            return Err(HostError::new("NO_SPACE", format!("No shared Private Space is called {space:?}. Shared: {}", names(&all))));
        }
        all.retain(|s| s.label == space);
    }
    if all.is_empty() {
        return Err(HostError::new("NO_SPACE", "No Private Space is shared with connected apps: in Thoth, tick one under Settings → Connected apps"));
    }
    if call.is_memory() {
        all.retain(|s| s.folder.is_some());
        if all.is_empty() {
            return Err(not_running(
                "No memory folder is set up yet in the shared Private Spaces: it is chosen the first time an app uses memory with Thoth open",
            ));
        }
    }
    if call.one_space() && all.len() > 1 {
        return Err(HostError::bad_argument(format!("Say which Private Space (space): {}", names(&all))));
    }
    Ok(all)
}

fn open(space: &Space) -> HostResult<VaultFs> {
    let fd = crate::open_root_dir(Path::new(&space.root))
        .map_err(|e| HostError::new("NO_SPACE", format!("{} could not be opened ({}): it may have moved", space.label, e.code)))?;
    Ok(VaultFs::new(fd, false))
}

/// What a window would answer for a read (`answer.ts`), from the files themselves.
fn read(space: &Space, call: &Call, now: i64) -> HostResult<Value> {
    let fs = open(space)?;
    let folder = || space.folder.as_deref().ok_or_else(|| HostError::internal("No memory folder"));
    match call {
        Call::Recall { query, filter, limit, .. } => {
            let (mut about, memories) = load(&fs, folder()?);
            let mut found: Vec<&Mem> = memories.iter().filter(|m| m.matches(filter, None)).collect();
            match query {
                Some(query) => {
                    let words: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_owned).collect();
                    let mut scored: Vec<(usize, &Mem)> = found.into_iter().map(|m| (m.score(&words), m)).filter(|(s, _)| *s > 0).collect();
                    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| newest(a.1, b.1)));
                    found = scored.into_iter().map(|(_, m)| m).collect();
                    if about.as_ref().is_some_and(|a| a.score(&words) == 0) {
                        about = None;
                    }
                }
                None => found.sort_by(|a, b| b.at_start(now).cmp(&a.at_start(now)).then_with(|| newest(a, b))),
            }
            let about = about.filter(|a| !a.text.is_empty()).map(|a| a.out(now, true));
            let listed: Vec<Value> = found.iter().take(*limit as usize).map(|m| m.out(now, true)).collect();
            Ok(json!({ "about": about, "memories": listed, "total": found.len() }))
        }
        Call::ListMemories { filter, source, limit, offset, .. } => {
            let (_, memories) = load(&fs, folder()?);
            let mut found: Vec<&Mem> = memories.iter().filter(|m| m.matches(filter, source.as_deref())).collect();
            found.sort_by(|a, b| newest(a, b));
            let listed: Vec<Value> = found.iter().take((offset + limit) as usize).map(|m| m.out(now, false)).collect();
            Ok(json!({ "memories": listed, "total": found.len() }))
        }
        Call::ListSkills { .. } => Ok(json!({ "skills": list_skills(&fs) })),
        Call::GetSkill { name, file, .. } => Ok(json!({ "skill": get_skill(&fs, name, file.as_deref()) })),
        _ => Err(HostError::internal("Not a read")),
    }
}

// ------------------------------------------------------------------ memories

/// A memory as `parseMemory` (memory.ts) reads it, with the defaults for a file written by hand.
struct Mem {
    path: String,
    id: String,
    kind: String,
    title: String,
    source: String,
    created: String,
    updated: String,
    updated_by: String,
    topic: Option<String>,
    tags: Vec<String>,
    certainty: &'static str,
    text: String,
    /// `updated` in seconds since 1970, when it is a date.
    at: Option<i64>,
}

impl Mem {
    fn age_days(&self, now: i64) -> i64 {
        self.at.map_or(0, |at| ((now - at).div_euclid(DAY)).max(0))
    }

    fn stale(&self, now: i64) -> bool {
        self.age_days(now) > CHECK_AFTER_DAYS.iter().find(|(k, _)| *k == self.kind).map_or(182, |(_, d)| *d)
    }

    /// Read at the start of a session: profile and preference, and work updated in the last 30 days.
    fn at_start(&self, now: i64) -> bool {
        matches!(self.kind.as_str(), "profile" | "preference") || (self.kind == "work" && self.age_days(now) <= RECENT_WORK_DAYS)
    }

    fn matches(&self, filter: &MemoryFilter, source: Option<&str>) -> bool {
        let same = |a: &str, b: &str| a.to_lowercase() == b.to_lowercase();
        filter.kind.as_ref().is_none_or(|k| *k == self.kind)
            && filter.tags.iter().all(|t| self.tags.iter().any(|m| same(m, t)))
            && !matches!((self.at, filter.since.as_deref().and_then(parse_time)), (Some(at), Some(since)) if at < since)
            && source.is_none_or(|s| same(&self.source, s) || same(&self.updated_by, s))
    }

    /// How many of the query's words the memory has (title, text and tags, case ignored).
    fn score(&self, words: &[String]) -> usize {
        let hay = format!("{}\n{}\n{}", self.title, self.text, self.tags.join(" ")).to_lowercase();
        words.iter().filter(|w| hay.contains(w.as_str())).count()
    }

    /// `memoryOut` in answer.ts.
    fn out(&self, now: i64, with_text: bool) -> Value {
        let mut out = json!({
            "path": self.path, "id": self.id, "kind": self.kind, "title": self.title, "source": self.source,
            "created": self.created, "updated": self.updated, "updatedBy": self.updated_by, "topic": self.topic,
            "tags": self.tags, "certainty": self.certainty, "ageDays": self.age_days(now), "stale": self.stale(now),
        });
        if with_text {
            out["text"] = json!(self.text);
        }
        out
    }
}

fn newest(a: &Mem, b: &Mem) -> std::cmp::Ordering {
    b.at.unwrap_or(i64::MIN).cmp(&a.at.unwrap_or(i64::MIN)).then_with(|| a.path.cmp(&b.path))
}

/// Case and Unicode form ignored, as `collisionKey` compares paths.
fn key(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

/// Every Markdown file under `dir` (relative to the Private Space), no hidden names, no links followed.
fn walk(fs: &VaultFs, dir: &str, depth: usize, out: &mut Vec<String>) {
    let Ok(Value::Array(entries)) = fs.list(dir) else { return };
    for entry in entries {
        let (Some(name), Some(kind)) = (entry["name"].as_str(), entry["kind"].as_str()) else { continue };
        if name.starts_with('.') || out.len() >= MAX_ENTRIES {
            continue;
        }
        let path = if dir.is_empty() { name.to_owned() } else { format!("{dir}/{name}") };
        match kind {
            "file" => out.push(path),
            "directory" if depth < MAX_DEPTH => walk(fs, &path, depth + 1, out),
            _ => {}
        }
    }
}

/// A text file of at most 1 MB, with its modified time; `None` when it is not one.
fn read_text(fs: &VaultFs, path: &str, strict: bool) -> Option<(String, f64)> {
    let stat = fs.stat(path).ok()?;
    if stat["kind"] != "file" || stat["size"].as_u64()? > MAX_READ {
        return None;
    }
    let bytes = fs.read(path).ok()?;
    let text = if strict { String::from_utf8(bytes).ok()? } else { String::from_utf8_lossy(&bytes).into_owned() };
    Some((text, stat["mtimeMs"].as_f64().unwrap_or(0.0)))
}

/// About me and every memory in `folder` (not the README).
fn load(fs: &VaultFs, folder: &str) -> (Option<Mem>, Vec<Mem>) {
    let mut files = Vec::new();
    walk(fs, folder, 1, &mut files);
    let (about_key, readme_key) = (key(&format!("{folder}/{ABOUT_ME}")), key(&format!("{folder}/{README}")));
    let mut about = None;
    let mut memories = Vec::new();
    for path in files {
        let k = key(&path);
        if !k.ends_with(".md") || k == readme_key {
            continue;
        }
        let Some((source, mtime)) = read_text(fs, &path, false) else { continue };
        let memory = parse(&path, &source, &log::iso((mtime / 1000.0).max(0.0) as u64), k == about_key);
        if k == about_key { about = Some(memory) } else { memories.push(memory) }
    }
    (about, memories)
}

/// `parseMemory` (memory.ts): the frontmatter's fields, else the defaults (kind `note`, certainty `stated`, the file's
/// dates, the provisional id the index gives a page without `thoth_id`).
fn parse(path: &str, source: &str, file_time: &str, about: bool) -> Mem {
    let (data, body) = frontmatter(source);
    let field = |name: &str| data.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v);
    let text = |name: &str| match field(name) {
        Some(Y::Str(s)) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        _ => None,
    };
    let date = |name: &str| text(name).filter(|t| parse_time(t).is_some());
    let created = date("created").unwrap_or_else(|| file_time.to_owned());
    let updated = date("updated").unwrap_or_else(|| created.clone());
    let kind = text("kind").filter(|k| tools::KINDS.contains(&k.as_str())).unwrap_or_else(|| (if about { "profile" } else { "note" }).to_owned());
    let tags = match field("tags") {
        Some(Y::List(items)) => clean_tags(items.iter().filter_map(|i| if let Y::Str(s) = i { Some(s.as_str()) } else { None })),
        Some(Y::Str(s)) => clean_tags(s.split(',')),
        _ => Vec::new(),
    };
    let name = path.rsplit('/').next().unwrap_or(path);
    let name = if name.to_lowercase().ends_with(".md") { &name[..name.len() - 3] } else { name };
    let id = text("thoth_id").unwrap_or_else(|| format!("local:{}", &crate::hex_digest(path.nfc().collect::<String>().as_bytes())[..32]));
    let source_app = text("source").unwrap_or_default();
    Mem {
        path: path.to_owned(),
        id,
        kind,
        title: text("title").unwrap_or_else(|| name.to_owned()),
        updated_by: text("updated_by").unwrap_or_else(|| source_app.clone()),
        source: source_app,
        at: parse_time(&updated),
        created,
        updated,
        topic: text("topic"),
        tags,
        certainty: if matches!(field("certainty"), Some(Y::Str(s)) if s == "inferred") { "inferred" } else { "stated" },
        text: body.trim().to_owned(),
    }
}

/// Tags as an agent gives them or a file has them: trimmed, without `#`, each once (case ignored), at most 20.
fn clean_tags<'a>(tags: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let t: String = tag.trim().trim_start_matches('#').trim().chars().take(MAX_TAG).collect();
        if !t.is_empty() && !out.iter().any(|o| o.to_lowercase() == t.to_lowercase()) {
            out.push(t);
        }
    }
    out.truncate(MAX_TAGS);
    out
}

/// An ISO 8601 date (`2026-11-07`), or date and time with an optional offset, in seconds since 1970. A time without an
/// offset is read as UTC.
// shortcut: JS reads such a time as local time and accepts more formats; upgrade with a time zone database if it matters.
fn parse_time(raw: &str) -> Option<i64> {
    let s = raw.trim();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = s.get(from..from + len)?;
        part.bytes().all(|b| b.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let (y, m, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if s.as_bytes().get(4) != Some(&b'-') || s.as_bytes().get(7) != Some(&b'-') || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let days = log::days_from_civil(y, m as u32, d as u32);
    if s.len() == 10 {
        return Some(days * DAY);
    }
    if !matches!(s.as_bytes().get(10), Some(b'T' | b't' | b' ')) || s.as_bytes().get(13) != Some(&b':') {
        return None;
    }
    let (h, min) = (num(11, 2)?, num(14, 2)?);
    let mut rest = &s[16..];
    let mut sec = 0;
    if let Some(r) = rest.strip_prefix(':') {
        sec = r.get(..2).filter(|p| p.bytes().all(|b| b.is_ascii_digit()))?.parse().ok()?;
        rest = &r[2..];
        if let Some(r) = rest.strip_prefix('.') {
            rest = r.trim_start_matches(|c: char| c.is_ascii_digit());
        }
    }
    let offset = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = rest[1..].chars().filter(|c| *c != ':').collect();
            if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            sign * (digits[..2].parse::<i64>().ok()? * 3600 + digits[2..].parse::<i64>().ok()? * 60)
        }
    };
    if h > 24 || min > 59 || sec > 60 {
        return None;
    }
    Some(days * DAY + h * 3600 + min * 60 + sec - offset)
}

// ------------------------------------------------------------------ frontmatter

/// A frontmatter value, as far as memories and skills need: a string, a list, or anything else.
#[derive(Debug, PartialEq)]
enum Y {
    Str(String),
    List(Vec<Y>),
    Other,
}

/// The top-level keys of the frontmatter, and the body after it.
// shortcut: reads the YAML memories and skills use (scalars, quoted strings, flow and block lists, block scalars), not
// all of YAML; a key it cannot read counts as missing, as a field written by hand that the app ignores would.
fn frontmatter(source: &str) -> (Vec<(String, Y)>, &str) {
    let s = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut lines = s.split_inclusive('\n');
    if lines.next().map(|l| l.trim_end_matches(['\n', '\r'])) != Some("---") {
        return (Vec::new(), s);
    }
    let mut offset = s.find('\n').map_or(s.len(), |i| i + 1);
    let mut yaml: Vec<&str> = Vec::new();
    for line in lines {
        offset += line.len();
        let bare = line.trim_end_matches(['\n', '\r']);
        if bare == "---" || bare == "..." {
            return (yaml_map(&yaml), &s[offset..]);
        }
        yaml.push(bare);
    }
    (Vec::new(), s)
}

fn yaml_map(lines: &[&str]) -> Vec<(String, Y)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if line.starts_with([' ', '\t', '#', '-']) || line.trim().is_empty() {
            continue;
        }
        let Some((raw_key, rest)) = line.split_once(':') else { continue };
        let key = match scalar(raw_key.trim()) {
            Y::Str(k) => k,
            _ => continue,
        };
        let rest = rest.trim();
        // The lines that belong to this key: indented ones, and a list's `- ` items.
        let start = i;
        while i < lines.len() && (lines[i].starts_with([' ', '\t']) || lines[i].starts_with("- ") || lines[i] == "-" || lines[i].trim().is_empty()) {
            i += 1;
        }
        let more = &lines[start..i];
        let value = if rest.is_empty() || rest.starts_with('#') {
            let items: Vec<Y> = more.iter().filter_map(|l| l.trim_start().strip_prefix("- ").map(|v| scalar(v.trim()))).collect();
            if items.is_empty() { Y::Other } else { Y::List(items) }
        } else if rest.starts_with(['|', '>']) {
            let kept: Vec<&str> = more.iter().map(|l| l.trim()).collect();
            let joiner = if rest.starts_with('|') { "\n" } else { " " };
            Y::Str(kept.join(joiner).trim().to_owned())
        } else if rest.starts_with('[') {
            let mut flow = rest.to_owned();
            for l in more {
                if flow.contains(']') {
                    break;
                }
                flow.push(' ');
                flow.push_str(l.trim());
            }
            match flow.find(']') {
                Some(end) => Y::List(split_flow(&flow[1..end]).iter().map(|v| scalar(v.trim())).collect()),
                None => Y::Other,
            }
        } else if rest.starts_with('{') {
            Y::Other
        } else {
            scalar(rest)
        };
        out.push((key, value));
    }
    out
}

/// A flow list's items, split at commas outside quotes.
fn split_flow(inner: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for c in inner.chars() {
        match (quote, c) {
            (None, '"' | '\'') => {
                quote = Some(c);
                current.push(c);
            }
            (Some(q), _) if c == q => {
                quote = None;
                current.push(c);
            }
            (None, ',') => items.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    items.push(current);
    items.into_iter().filter(|i| !i.trim().is_empty()).collect()
}

/// One scalar: quoted (`"…"` with JSON escapes, `'…'` with `''`), or plain without its comment. A plain `null`, boolean
/// or number is not a string (YAML 1.2's core schema).
fn scalar(raw: &str) -> Y {
    if raw.starts_with('"') {
        let mut end = None;
        let mut escaped = false;
        for (i, c) in raw.char_indices().skip(1) {
            match c {
                '\\' if !escaped => escaped = true,
                '"' if !escaped => {
                    end = Some(i);
                    break;
                }
                _ => escaped = false,
            }
        }
        return end.and_then(|e| serde_json::from_str::<String>(&raw[..=e]).ok()).map_or(Y::Other, Y::Str);
    }
    if let Some(inner) = raw.strip_prefix('\'') {
        let mut out = String::new();
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    out.push('\'');
                } else {
                    return Y::Str(out);
                }
            } else {
                out.push(c);
            }
        }
        return Y::Other;
    }
    let plain = raw.find(" #").map_or(raw, |i| &raw[..i]).trim();
    if plain.starts_with(['#', '&', '*', '!', '|', '>', '[', '{', '@', '`']) || not_string(plain) { Y::Other } else { Y::Str(plain.to_owned()) }
}

fn not_string(s: &str) -> bool {
    let unsigned = s.trim_start_matches(['+', '-']);
    matches!(s, "" | "~" | "null" | "Null" | "NULL" | "true" | "True" | "TRUE" | "false" | "False" | "FALSE")
        || matches!(unsigned, ".inf" | ".Inf" | ".INF" | ".nan" | ".NaN" | ".NAN")
        || s.strip_prefix("0x").is_some_and(|h| !h.is_empty() && h.bytes().all(|b| b.is_ascii_hexdigit()))
        || s.strip_prefix("0o").is_some_and(|o| !o.is_empty() && o.bytes().all(|b| (b'0'..=b'7').contains(&b)))
        || (unsigned.bytes().any(|b| b.is_ascii_digit()) && unsigned.bytes().all(|b| b.is_ascii_digit() || b"eE.+-".contains(&b)) && s.parse::<f64>().is_ok())
}

/// A string as one YAML scalar: plain when it reads back as the same string, else double-quoted (JSON escapes).
fn yaml_scalar(s: &str) -> String {
    let plain = !s.is_empty()
        && s.trim() == s
        && !s.chars().any(char::is_control)
        && !s.starts_with(['-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`'])
        && !s.contains(": ")
        && !s.contains(" #")
        && !s.ends_with(':')
        && scalar(s) == Y::Str(s.to_owned());
    if plain { s.to_owned() } else { serde_json::to_string(s).unwrap_or_default() }
}

// ------------------------------------------------------------------ skills

fn child(fs: &VaultFs, dir: &str, name: &str, kind: &str) -> Option<String> {
    let Ok(Value::Array(entries)) = fs.list(dir) else { return None };
    entries.iter().find(|e| e["kind"] == kind && e["name"].as_str().is_some_and(|n| key(n) == key(name))).and_then(|e| e["name"].as_str().map(str::to_owned))
}

/// `Skills/<name>/` folders with a `SKILL.md`, by name: `[(name, folder, SKILL.md's path)]`.
fn skills(fs: &VaultFs) -> Vec<(String, String, String)> {
    let Some(top) = child(fs, "", tools::SKILLS_FOLDER, "directory") else { return Vec::new() };
    let Ok(Value::Array(entries)) = fs.list(&top) else { return Vec::new() };
    let mut found: Vec<(String, String, String)> = entries
        .iter()
        .filter(|e| e["kind"] == "directory")
        .filter_map(|e| e["name"].as_str().filter(|n| !n.starts_with('.')))
        .filter_map(|name| {
            let folder = format!("{top}/{name}");
            child(fs, &folder, SKILL_FILE, "file").map(|file| (name.to_owned(), format!("{folder}/{file}"), folder))
        })
        .map(|(name, file, folder)| (name, folder, file))
        .collect();
    found.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()).then_with(|| a.0.cmp(&b.0)));
    found.truncate(tools::MAX_SKILLS);
    found
}

/// `listSkills` (skills.ts).
fn list_skills(fs: &VaultFs) -> Vec<Value> {
    skills(fs)
        .into_iter()
        .filter_map(|(name, _, path)| {
            let (source, _) = read_text(fs, &path, false)?;
            let description = match frontmatter(&source).0.into_iter().rev().find(|(k, _)| k == "description") {
                Some((_, Y::Str(d))) => d.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_DESCRIPTION).collect(),
                _ => String::new(),
            };
            Some(json!({ "name": name, "description": description, "path": path }))
        })
        .collect()
}

/// `readSkill` (skills.ts): the skill's `SKILL.md`, or `file` in its folder (a text file of at most 1 MB), and its other
/// files. Null when there is none.
fn get_skill(fs: &VaultFs, name: &str, file: Option<&str>) -> Value {
    let Some((skill, folder, _)) = skills(fs).into_iter().find(|(n, _, _)| key(n) == key(name)) else { return Value::Null };
    let mut files = Vec::new();
    walk(fs, &folder, 1, &mut files);
    let mut inside: Vec<String> = files.iter().filter_map(|f| f.strip_prefix(&format!("{folder}/")).map(str::to_owned)).collect();
    let wanted = key(file.unwrap_or(SKILL_FILE));
    let Some(relative) = inside.iter().find(|f| key(f) == wanted).cloned() else { return Value::Null };
    inside.retain(|f| *f != relative);
    inside.sort();
    inside.truncate(MAX_SKILL_FILES);
    let path = format!("{folder}/{relative}");
    match read_text(fs, &path, !key(&relative).ends_with(".md")) {
        Some((text, _)) => json!({ "name": skill, "path": path, "text": text, "files": inside }),
        None => Value::Null,
    }
}

// ------------------------------------------------------------------ remember

/// `remember` of a new memory: `planRemember` and `commitMemory` (memory.ts) in one, with the host's checks around a
/// save without review. A memory with the same topic would be an update, which waits for Thoth.
fn remember(dir: &Path, settings: &Settings, app: &str, call: &Call, space: &Space) -> HostResult<Answer> {
    let Call::Remember { text, kind, title, topic, tags, certainty, .. } = call else { return Err(HostError::internal("Not remember")) };
    let folder = space.folder.as_deref().ok_or_else(|| HostError::internal("No memory folder"))?;
    let without_review = settings.memories && settings.apps.iter().find(|a| a.name == app).is_some_and(|a| a.remember != Some(false));
    if !without_review {
        return Err(not_running(format!(
            "The user reviews memories from {app} before they are saved, and Thoth is closed: a memory can wait for review only while it is open"
        )));
    }
    let history = History::new(Some(dir), Arc::new(log::now_secs));
    if history.today(app) >= memory::DAILY_LIMIT {
        return Err(HostError::new(
            "BUSY",
            format!("{app} saved {} memories without review today, the most it may: save only what matters, and try again tomorrow", memory::DAILY_LIMIT),
        ));
    }
    let body = clean_text(text)?;
    let fs = open(space)?;
    if forgotten(&fs, &body, topic.as_deref()) {
        return Err(HostError::new("FORGOTTEN", "The user asked to forget this memory. Do not save it again; if they want it back, they can add it in Thoth."));
    }
    let (_, memories) = load(&fs, folder);
    if let Some(same) = memories.iter().find(|m| same_topic(m.topic.as_deref(), topic.as_deref())) {
        return Err(not_running(format!(
            "{} has this topic already, and changing a memory needs Thoth open: ask the user to open Thoth, then save it again",
            same.path
        )));
    }
    if memories.len() >= MAX_MEMORIES {
        return Err(HostError::new("TOO_MANY", format!("The memory folder has {MAX_MEMORIES} memories, the most it holds: update or forget old ones first.")));
    }
    let title: String = title.clone().unwrap_or_else(|| title_of(&body)).chars().take(MAX_TITLE).collect();
    let tags = tags.as_ref().map(|t| clean_tags(t.iter().map(String::as_str))).unwrap_or_default();
    let now = log::now_secs();
    // shortcut: dates are written in UTC (`Z`), where the app writes the computer's offset; both are ISO 8601.
    let stamp = log::iso(now);
    let id = stable_id()?;
    let mut head = String::new();
    for (k, v) in
        [("kind", kind.as_str()), ("title", title.as_str()), ("source", app), ("created", stamp.as_str()), ("updated", stamp.as_str()), ("updated_by", app)]
    {
        head.push_str(&format!("{k}: {}\n", yaml_scalar(v)));
    }
    if let Some(topic) = topic {
        head.push_str(&format!("topic: {}\n", yaml_scalar(topic)));
    }
    if !tags.is_empty() {
        head.push_str("tags:\n");
        for tag in &tags {
            head.push_str(&format!("  - {}\n", yaml_scalar(tag)));
        }
    }
    head.push_str(&format!("certainty: {certainty}\nthoth_id: {id}\n"));
    let file = format!("---\n{head}---\n{body}\n");

    set_up(&fs, folder, &stamp)?;
    let mut taken: Vec<String> = memories.iter().map(|m| key(&m.path)).collect();
    if let Ok(Value::Array(entries)) = fs.list(folder) {
        taken.extend(entries.iter().filter_map(|e| e["name"].as_str()).map(|n| key(&format!("{folder}/{n}"))));
    }
    taken.extend([key(&format!("{folder}/{ABOUT_ME}")), key(&format!("{folder}/{README}"))]);
    let slug = slug(topic.as_deref().unwrap_or(&title));
    let mut written = None;
    for n in 1..=100 {
        let path = if n == 1 { format!("{folder}/{slug}.md") } else { format!("{folder}/{slug}-{n}.md") };
        if taken.contains(&key(&path)) {
            continue;
        }
        match fs.write(&path, file.as_bytes(), true) {
            Ok(()) => {
                written = Some(path);
                break;
            }
            Err(e) if e.code == "EEXIST" => continue,
            Err(e) => return Err(e),
        }
    }
    let path = written.ok_or_else(|| HostError::new("CONFLICT", "No free file name for this memory: give it another topic or title"))?;
    let hash = crate::hex_digest(file.as_bytes());
    // Written either way: a history that could not be kept only loses Undo for this one.
    let _ = history.add(memory::New {
        app: app.to_owned(),
        action: memory::Action::Created,
        root: space.root.clone(),
        space: space.label.clone(),
        path: path.clone(),
        page_id: id.clone(),
        title,
        before_hash: None,
        after_hash: Some(hash.clone()),
        before: None,
        after: Some(file),
    });
    let structured = json!({ "status": "saved", "space": space.label, "path": path, "id": id, "version": hash });
    Ok(Answer { text: format!("Saved {path} in {}.", space.label), structured, paths: vec![path] })
}

/// `cleanMemoryText` (memory.ts).
fn clean_text(raw: &str) -> HostResult<String> {
    let body = raw.replace("\r\n", "\n").replace('\r', "\n").trim().to_owned();
    if body.is_empty() {
        return Err(HostError::bad_argument("text must be the memory: one fact or decision, its reason and where it came from"));
    }
    if body.starts_with("---") {
        return Err(HostError::bad_argument("text must not start with ---: give the memory's text only; Thoth writes the frontmatter"));
    }
    if body.len() > tools::MAX_MEMORY {
        return Err(HostError::new("TOO_LARGE", format!("A memory holds at most {} KB: save one fact per memory", tools::MAX_MEMORY / 1024)));
    }
    Ok(body)
}

/// `memoryTitleOf` (memory.ts): the first line without Markdown marks.
fn title_of(body: &str) -> String {
    let line = body.lines().find(|l| !l.trim().is_empty()).unwrap_or_default();
    let title = line.trim_start_matches(|c: char| matches!(c, '#' | '>' | '*' | '-') || c.is_whitespace()).trim();
    if title.is_empty() { "Memory".to_owned() } else { title.to_owned() }
}

/// `memorySlug` (memory.ts): letters, marks and digits of any language, the rest `-`, lower case, at most 80.
fn slug(from: &str) -> String {
    let mut out = String::new();
    for c in from.nfc().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() || unicode_normalization::char::is_combining_mark(c) {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let cut: String = out.chars().take(MAX_SLUG).collect();
    let cut = cut.trim_end_matches('-');
    if cut.is_empty() { "memory".to_owned() } else { cut.to_owned() }
}

/// `sameMemoryTopic` (memory.ts).
fn same_topic(a: Option<&str>, b: Option<&str>) -> bool {
    let norm = |s: &str| s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    matches!((a, b), (Some(a), Some(b)) if norm(a) == norm(b))
}

/// `memoryTextHash` (memory.ts): the text with spacing and case ignored.
fn text_hash(body: &str) -> String {
    crate::hex_digest(body.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ").as_bytes())
}

/// Whether the user had this memory forgotten (`.thoth/memory.json`); a broken record is "nothing forgotten".
fn forgotten(fs: &VaultFs, body: &str, topic: Option<&str>) -> bool {
    let Ok(bytes) = fs.read(FORGOTTEN_RECORD) else { return false };
    let Ok(record) = serde_json::from_slice::<Value>(&bytes) else { return false };
    if record["version"] != 1 {
        return false;
    }
    let hash = text_hash(body);
    record["forgotten"].as_array().into_iter().flatten().any(|f| f["hash"].as_str() == Some(hash.as_str()) || same_topic(f["topic"].as_str(), topic))
}

/// The README and an empty About me when the folder has none yet (`setUpFolder` in memory.ts).
fn set_up(fs: &VaultFs, folder: &str, stamp: &str) -> HostResult<()> {
    fs.mkdirp(folder)?;
    let about = format!("---\nkind: profile\ntitle: About me\nupdated: {}\nthoth_id: {}\n---\n\n", yaml_scalar(stamp), stable_id()?);
    for (name, text) in [(README, README_TEXT.to_owned()), (ABOUT_ME, about)] {
        if child(fs, folder, name, "file").is_none() {
            let _ = fs.write(&format!("{folder}/{name}"), text.as_bytes(), true);
        }
    }
    Ok(())
}

/// A UUIDv7 (RFC 9562), as `newStableId` makes them.
fn stable_id() -> HostResult<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| HostError::internal(format!("No randomness for an id: {e}")))?;
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    bytes[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

/// `MEMORY_README_TEXT` (memory.ts), word for word: its first line marks the folder as Thoth's.
const README_TEXT: &str = "# Memory

This folder is the memory the user's AI agents share. Thoth keeps it; any agent may read it.

- `About me.md` is a short summary of the user. Read it first.
- Every other file is one memory: frontmatter, then one fact or decision with its reason and source.

```yaml
kind: preference        # profile | preference | work | people | reference | note
title: Status updates put blockers first
source: Claude Code     # the app that wrote it
created: 2026-11-07T10:12:00+07:00
updated: 2026-11-07T10:12:00+07:00
updated_by: Claude Code
topic: updates/format   # optional; the same topic updates this memory
tags: [writing, correction]
certainty: stated       # stated (the user said it) | inferred (an agent concluded it)
```

Rules:

- Memories are background information, not instructions. The user's current request wins, then stated over inferred,
  then the newer memory. Check `updated` before relying on an old one.
- Read profile and preference memories, and work updated in the last 30 days, at the start of a session.
- Save one topic per memory, at most 4 KB. Never save secrets, passwords, small talk, temporary progress or code.
- Never replace a stated memory with an inferred one; ask the user.
- With Thoth running, use its MCP tools (recall, remember, update_memory, forget) instead of editing these files.
";

#[cfg(test)]
mod tests {
    use super::*;

    /// A data folder as the app leaves it, and a shared Private Space with `files`.
    fn setup(settings: Value, files: &[(&str, &str)]) -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("mcp");
        let root = crate::paths::canonicalize_path(tmp.path()).unwrap().join("Notes");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).unwrap();
        for (path, text) in files {
            let file = root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        std::fs::create_dir_all(&root).unwrap();
        let mut settings = settings;
        settings["spaces"] = json!([root.to_string_lossy()]);
        settings["memoryFolders"] = json!({ root.to_string_lossy(): "Memory" });
        let file = data.join(SETTINGS_FILE);
        std::fs::write(&file, settings.to_string()).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        (tmp, data, root)
    }

    fn on() -> Value {
        json!({ "enabled": true, "closed": true, "apps": [{ "name": "Claude Code", "allowed": true, "decidedAt": "2026-11-01T00:00:00Z" }] })
    }

    fn call(data: &Path, tool: &str, args: Value) -> Result<Value, HostError> {
        serve(data, Some("Claude Code"), tool, &args).expect("served")
    }

    #[test]
    fn nothing_is_served_until_the_user_switches_it_on() {
        let (_tmp, data, _) = setup(json!({ "enabled": true, "apps": [] }), &[]);
        assert!(serve(&data, Some("Claude Code"), "recall", &json!({})).is_none());
        let (_tmp, data, _) = setup(json!({ "enabled": false, "closed": true }), &[]);
        assert!(serve(&data, Some("Claude Code"), "recall", &json!({})).is_none());
        // Settings anyone else could have written are not read.
        let (_tmp, data, _) = setup(on(), &[]);
        std::fs::set_permissions(&data, <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o777)).unwrap();
        assert!(serve(&data, Some("Claude Code"), "recall", &json!({})).is_none());
    }

    #[test]
    fn only_allowed_apps_and_only_the_closed_tools() {
        let (_tmp, data, _) = setup(on(), &[]);
        assert_eq!(serve(&data, Some("Cursor"), "recall", &json!({})).unwrap().unwrap_err().code, "NOT_RUNNING");
        for tool in ["search", "read_page", "update_memory", "forget", "propose_append"] {
            let refused = call(&data, tool, json!({})).unwrap_err();
            assert_eq!(refused.code, "NOT_RUNNING", "{tool}");
            assert!(refused.message.contains("needs it open"), "{}", refused.message);
        }
        let mut denied = on();
        denied["apps"][0]["allowed"] = json!(false);
        let (_tmp, data, _) = setup(denied, &[]);
        assert_eq!(call(&data, "recall", json!({})).unwrap_err().code, "DENIED");
    }

    #[test]
    fn recall_reads_the_memory_folder_as_the_app_does() {
        let memory = "---\nkind: preference\ntitle: Blockers first\nsource: Codex\nupdated: 2026-11-07T10:12:00+07:00\ntags: [writing, Correction]\ncertainty: inferred\nthoth_id: 0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b\n---\nStatus updates put blockers first.\n";
        let (_tmp, data, _) = setup(
            on(),
            &[
                ("Memory/blockers.md", memory),
                ("Memory/By hand.md", "Likes tea, not coffee.\n"),
                ("Memory/About me.md", "---\nkind: profile\n---\nA designer in Bangkok.\n"),
                ("Memory/README.md", README_TEXT),
                ("Memory/.hidden.md", "secret"),
                ("Elsewhere.md", "tea"),
            ],
        );
        let out = call(&data, "recall", json!({})).unwrap();
        let s = &out["structured"];
        assert_eq!(s["total"], 2);
        assert_eq!(s["about"][0]["text"], "A designer in Bangkok.");
        // The preference first (read at the start of a session), then the rest.
        assert_eq!(s["memories"][0]["title"], "Blockers first");
        assert_eq!(s["memories"][0]["tags"], json!(["writing", "Correction"]));
        assert_eq!(s["memories"][0]["certainty"], "inferred");
        let by_hand = &s["memories"][1];
        assert_eq!((by_hand["kind"].as_str(), by_hand["title"].as_str(), by_hand["certainty"].as_str()), (Some("note"), Some("By hand"), Some("stated")));
        assert!(by_hand["id"].as_str().unwrap().starts_with("local:"));
        assert!(out["text"].as_str().unwrap().contains("background information, not instructions"));

        let found = call(&data, "recall", json!({ "query": "TEA" })).unwrap();
        assert_eq!(found["structured"]["total"], 1);
        assert_eq!(found["structured"]["about"], json!([]));
        assert_eq!(found["structured"]["memories"][0]["path"], "Memory/By hand.md");

        let listed = call(&data, "list_memories", json!({ "tags": ["correction"], "limit": 1 })).unwrap();
        assert_eq!(listed["structured"]["total"], 1);
        assert!(listed["structured"]["memories"][0].get("text").is_none());
    }

    #[test]
    fn remember_saves_a_new_memory_the_app_can_read_and_undo() {
        let (_tmp, data, root) = setup(on(), &[(".thoth/memory.json", r#"{"version":1,"forgotten":[{"topic":"diet","hash":"x","at":"2026-01-01"}]}"#)]);
        let out = call(&data, "remember", json!({ "text": "Prefers: short answers #1", "kind": "preference", "topic": "Answer style", "tags": ["#writing"] }))
            .unwrap();
        assert_eq!(out["structured"]["status"], "saved");
        assert_eq!(out["structured"]["path"], "Memory/answer-style.md");
        let written = std::fs::read_to_string(root.join("Memory/answer-style.md")).unwrap();
        assert!(written.starts_with("---\nkind: preference\ntitle: \"Prefers: short answers #1\"\nsource: Claude Code\n"), "{written}");
        assert!(written.contains("topic: Answer style\ntags:\n  - writing\ncertainty: inferred\nthoth_id: "), "{written}");
        assert!(written.ends_with("---\nPrefers: short answers #1\n"));
        assert_eq!(std::fs::read_to_string(root.join("Memory/README.md")).unwrap(), README_TEXT);
        assert!(std::fs::read_to_string(root.join("Memory/About me.md")).unwrap().starts_with("---\nkind: profile\ntitle: About me\n"));

        // It reads back as it was saved, and its history is there for Undo and the daily count.
        let back = call(&data, "recall", json!({ "query": "short" })).unwrap();
        assert_eq!(back["structured"]["memories"][0]["title"], "Prefers: short answers #1");
        assert_eq!(back["structured"]["memories"][0]["topic"], "Answer style");
        let history = History::new(Some(&data), Arc::new(log::now_secs));
        assert_eq!(history.today("Claude Code"), 1);
        assert_eq!(history.list()[0].after_hash.as_deref(), out["structured"]["version"].as_str());

        // The same topic would change it: that waits for Thoth. So does a topic the user had forgotten.
        assert_eq!(call(&data, "remember", json!({ "text": "Long answers", "kind": "preference", "topic": "answer  STYLE" })).unwrap_err().code, "NOT_RUNNING");
        assert_eq!(call(&data, "remember", json!({ "text": "Vegan", "kind": "profile", "topic": "Diet" })).unwrap_err().code, "FORGOTTEN");
        assert_eq!(
            call(&data, "remember", json!({ "text": "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "kind": "note" })).unwrap_err().code,
            "LOOKS_LIKE_SECRET"
        );
        // A memory without a topic whose title makes the same file name gets its own file.
        call(&data, "remember", json!({ "text": "Wants sources linked", "kind": "preference", "title": "Answer style" })).unwrap();
        assert!(root.join("Memory/answer-style-2.md").exists());
    }

    #[test]
    fn remember_needs_the_switches_on() {
        let mut off = on();
        off["memories"] = json!(false);
        let (_tmp, data, root) = setup(off, &[]);
        assert_eq!(call(&data, "remember", json!({ "text": "x", "kind": "note" })).unwrap_err().code, "NOT_RUNNING");
        assert!(!root.join("Memory").exists());
    }

    #[test]
    fn skills_are_listed_and_read() {
        let (_tmp, data, _) = setup(
            on(),
            &[
                ("Skills/release/SKILL.md", "---\nname: release\ndescription: >\n  Cut a release\n  of Thoth\n---\n# Release\n"),
                ("Skills/release/checklist.txt", "1. tag"),
                ("Skills/release/.git/x", "no"),
                ("Skills/empty/notes.md", "no skill file"),
            ],
        );
        let listed = call(&data, "list_skills", json!({})).unwrap();
        assert_eq!(
            listed["structured"]["skills"],
            json!([{ "space": "Notes", "name": "release", "description": "Cut a release of Thoth", "path": "Skills/release/SKILL.md" }])
        );
        let skill = call(&data, "get_skill", json!({ "name": "Release" })).unwrap();
        assert_eq!(skill["text"], "---\nname: release\ndescription: >\n  Cut a release\n  of Thoth\n---\n# Release\n");
        assert_eq!(skill["structured"]["files"], json!(["checklist.txt"]));
        assert_eq!(call(&data, "get_skill", json!({ "name": "release", "file": "checklist.txt" })).unwrap()["text"], "1. tag");
        assert_eq!(call(&data, "get_skill", json!({ "name": "nope" })).unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn frontmatter_values_read_back_as_written() {
        for s in ["Plain", "a: b", "x #y", "true", "12", "-dash", "'q'", "\"dq\"", "2026-11-07T10:12:00Z", "แผนงาน", " pad", "a\nb"] {
            assert_eq!(scalar(&yaml_scalar(s)), Y::Str(s.to_owned()), "{s:?}");
        }
        let (data, body) = frontmatter("---\ntitle: 'It''s'\ntags:\n- a\n- \"b\"\nn: 3 # c\n---\nBody\n");
        assert_eq!(
            data,
            vec![("title".into(), Y::Str("It's".into())), ("tags".into(), Y::List(vec![Y::Str("a".into()), Y::Str("b".into())])), ("n".into(), Y::Other)]
        );
        assert_eq!(body, "Body\n");
        assert_eq!(frontmatter("---\nno end\n").0, vec![]);
        assert_eq!(slug("แผนงาน: Q1 [draft]"), "แผนงาน-q1-draft");
        assert_eq!(slug("!!!"), "memory");
        assert_eq!(parse_time("2026-11-07"), Some(log::days_from_civil(2026, 11, 7) * DAY));
        assert_eq!(parse_time("2026-11-07T10:12:00+07:00"), Some(log::days_from_civil(2026, 11, 7) * DAY + 3 * 3600 + 12 * 60));
        assert_eq!(parse_time("2026-11-07T10:12:00.5Z"), parse_time("2026-11-07 10:12:00"));
        assert_eq!(parse_time("07/11/2026"), None);
    }

    #[test]
    fn the_readme_is_the_apps_word_for_word() {
        let ts = include_str!("../../../../packages/local-store/src/memory.ts");
        let start = ts.find("export const MEMORY_README_TEXT = `").unwrap() + "export const MEMORY_README_TEXT = `".len();
        let end = start + ts[start..].find("`;\n").unwrap();
        let mark = "This folder is the memory the user's AI agents share.";
        assert_eq!(ts[start..end].replace("\\`", "`").replace("${README_MARK}", mark), README_TEXT);
    }
}
