//! "Use my skills in Claude Code and Codex" (ADR-0052 rule 7): each skill folder of a Private Space,
//! `<root>/Skills/<name>/` with its `SKILL.md`, linked as `~/.agents/skills/<name>` (Codex and others) and
//! `~/.claude/skills/<name>` (Claude Code, when `~/.claude` exists), so agents find the skills while Thoth is closed.
//!
//! A link is Thoth's when it is a symbolic link to a skill folder of the Private Space: only those are ever removed.
//! A file, a folder or another link with the same name is never replaced; that skill is reported as not linked.
use crate::error::{HostError, HostResult};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The Private Space's skills folder (`tools::SKILLS_FOLDER`).
const SKILLS: &str = super::tools::SKILLS_FOLDER;
/// The most skills linked from one Private Space.
const MAX_LINKED: usize = 200;

/// Where agents look for skills in the home folder: `~/.agents/skills` always (the shared place, made when missing),
/// `~/.claude/skills` only where Claude Code is set up.
fn targets(home: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![home.join(".agents").join("skills")];
    let claude = home.join(".claude");
    if claude.is_dir() {
        dirs.push(claude.join("skills"));
    }
    dirs
}

/// The skill folders of `root`: real folders (not links) under `Skills/` with a `SKILL.md` file, by name.
fn skills_of(root: &Path) -> Vec<(String, PathBuf)> {
    let Some(skills) = std::fs::read_dir(root).ok().into_iter().flatten().flatten().find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(SKILLS))
    else {
        return Vec::new();
    };
    let dir = skills.path();
    if !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
        return Vec::new();
    }
    let mut found: Vec<(String, PathBuf)> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_owned();
            let path = entry.path();
            let real_dir = std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
            let has_skill =
                std::fs::read_dir(&path).into_iter().flatten().flatten().any(|f| {
                    f.file_name().to_string_lossy().eq_ignore_ascii_case("SKILL.md") && std::fs::symlink_metadata(f.path()).is_ok_and(|m| m.is_file())
                });
            (!name.starts_with('.') && real_dir && has_skill).then_some((name, path))
        })
        .collect();
    found.sort();
    found.truncate(MAX_LINKED);
    found
}

/// Whether `link` is Thoth's link into this Private Space's skills folder.
fn ours(link: &Path, root: &Path) -> Option<PathBuf> {
    let meta = std::fs::symlink_metadata(link).ok()?;
    if !meta.file_type().is_symlink() {
        return None;
    }
    let target = std::fs::read_link(link).ok()?;
    let parent = target.parent()?;
    (parent.parent() == Some(root) && parent.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(SKILLS))).then_some(target)
}

/// Links `root`'s skills (`on`), or removes Thoth's links to them (off). Links to skills that are gone are removed
/// either way. Returns `{ linked: [name], skipped: [name], folders: [path] }`.
#[cfg(unix)]
pub fn sync(home: &Path, root: &Path, on: bool) -> HostResult<Value> {
    let skills = if on { skills_of(root) } else { Vec::new() };
    let mut linked = Vec::new();
    let mut skipped = Vec::new();
    let mut folders = Vec::new();
    for dir in targets(home) {
        // Thoth's links that no longer name a skill it links: removed.
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let link = entry.path();
            if let Some(target) = ours(&link, root)
                && !skills.iter().any(|(_, path)| *path == target)
            {
                let _ = std::fs::remove_file(&link);
            }
        }
        if skills.is_empty() {
            continue;
        }
        std::fs::create_dir_all(&dir).map_err(|e| HostError::internal(format!("Could not make {}: {e}", dir.display())))?;
        folders.push(dir.to_string_lossy().into_owned());
        for (name, path) in &skills {
            let link = dir.join(name);
            if ours(&link, root).is_some_and(|t| t == *path) {
                push_once(&mut linked, name);
                continue;
            }
            if std::fs::symlink_metadata(&link).is_ok() {
                push_once(&mut skipped, name);
                continue;
            }
            match std::os::unix::fs::symlink(path, &link) {
                Ok(()) => push_once(&mut linked, name),
                Err(_) => push_once(&mut skipped, name),
            }
        }
    }
    // A skill linked in one folder and taken by something else in the other is reported as both.
    linked.sort();
    skipped.sort();
    Ok(json!({ "linked": linked, "skipped": skipped, "folders": folders }))
}

#[cfg(not(unix))]
pub fn sync(_home: &Path, _root: &Path, _on: bool) -> HostResult<Value> {
    Err(HostError::new("UNAVAILABLE", "Linking skills is not available on this computer yet"))
}

fn push_once(list: &mut Vec<String>, name: &str) {
    if !list.iter().any(|n| n == name) {
        list.push(name.to_owned());
    }
}
