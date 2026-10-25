//! Vault watcher (ADR-0001 §4): a trigger for `vault.reconcile()`, never the
//! source of truth. notify-debouncer-full at ~200 ms on the vault root, with no
//! file-id cache (that cache walks the tree following symlinks) and symlink
//! following off. Paths are vault-relative POSIX, NFC, with `.thoth/` dropped.
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, NoCache, new_debouncer_opt};
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;

use crate::error::{HostError, HostResult};
use crate::paths::is_reserved_first_segment;

pub const DEBOUNCE: Duration = Duration::from_millis(200);
/// More changed paths than this in one batch become a plain rescan.
const MAX_PATHS: usize = 10_000;

/// Receives `(paths, rescan)` for one vault.
pub type ChangeSink = Arc<dyn Fn(Vec<String>, bool) + Send + Sync>;

pub struct Watcher {
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

impl Watcher {
    pub fn start(root: &Path, sink: ChangeSink) -> HostResult<Self> {
        // ReadDirectoryChangesW reports paths under the path it was given; a long root needs the `\\?\` form.
        #[cfg(windows)]
        let root = &crate::win::paths::for_win32(root);
        let root_buf = root.to_path_buf();
        let handler = move |result: DebounceEventResult| {
            let (paths, rescan) = match result {
                Ok(events) => collect(&root_buf, events.iter().flat_map(|e| e.event.paths.iter().map(move |p| (p, e.event.need_rescan())))),
                Err(_) => (Vec::new(), true),
            };
            if rescan || !paths.is_empty() {
                sink(paths, rescan);
            }
        };
        let config = notify::Config::default().with_follow_symlinks(false);
        let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(DEBOUNCE, None, handler, NoCache, config)
            .map_err(|e| HostError::internal(format!("Could not start the watcher: {e}")))?;
        debouncer.watch(root, RecursiveMode::Recursive).map_err(|e| HostError::internal(format!("Could not watch the vault: {e}")))?;
        Ok(Self { _debouncer: debouncer })
    }
}

fn collect<'a>(root: &Path, events: impl Iterator<Item = (&'a PathBuf, bool)>) -> (Vec<String>, bool) {
    let mut rescan = false;
    let mut paths = BTreeSet::new();
    for (path, need_rescan) in events {
        rescan |= need_rescan;
        match relative(root, path) {
            // The root itself changed (moved, deleted, or a coalesced event): reconcile everything.
            Some(rel) if rel.is_empty() => rescan = true,
            Some(rel) => {
                let first = rel.split('/').next().unwrap_or_default();
                if !is_reserved_first_segment(first) {
                    paths.insert(rel);
                }
            }
            None => {}
        }
    }
    if paths.len() > MAX_PATHS {
        return (Vec::new(), true);
    }
    (paths.into_iter().collect(), rescan)
}

/// Vault-relative POSIX path, or None when `path` is outside `root`.
fn relative(root: &Path, path: &Path) -> Option<String> {
    let rest = path.strip_prefix(root).ok()?;
    let mut segments = Vec::new();
    for component in rest.components() {
        match component {
            Component::Normal(s) => segments.push(s.to_string_lossy().nfc().collect::<String>()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_relative_paths_without_thoth() {
        let root = Path::new("/v");
        let events = [PathBuf::from("/v/a.md"), PathBuf::from("/v/.thoth/index.sqlite"), PathBuf::from("/v/.THOTH/x"), PathBuf::from("/other/b.md"), PathBuf::from("/v/d/cafe\u{301}.md")];
        let (paths, rescan) = collect(root, events.iter().map(|p| (p, false)));
        assert_eq!(paths, vec!["a.md".to_owned(), "d/caf\u{e9}.md".to_owned()]);
        assert!(!rescan);
        let root_event = [PathBuf::from("/v")];
        assert!(collect(root, root_event.iter().map(|p| (p, false))).1);
    }
}
