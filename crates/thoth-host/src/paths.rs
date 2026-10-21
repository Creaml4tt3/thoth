//! Path rules. Vault paths follow `checkRelativePath`/`normalizeVaultPath` in
//! `packages/domain/src/paths.ts`, made stricter: empty and `.` segments are
//! refused instead of collapsed, and segments are re-checked after NFC
//! normalization. Source paths are names exactly as listed on disk.
use crate::error::{HostError, HostResult};
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

/// Longest path argument accepted, in bytes (PATH_MAX on macOS and Linux is 1024/4096).
pub const MAX_PATH_BYTES: usize = 4096;

/// Splits a vault-relative POSIX path into NFC segments. `allow_root` lets `""` mean the vault root.
pub fn vault_segments(raw: &str, allow_root: bool) -> HostResult<Vec<String>> {
    if raw.is_empty() {
        return if allow_root { Ok(Vec::new()) } else { Err(HostError::unsafe_path(raw, "empty path")) };
    }
    if raw.len() > MAX_PATH_BYTES {
        return Err(HostError::bad_argument("Path is too long"));
    }
    if let Some(reason) = check_relative(raw) {
        return Err(HostError::unsafe_path(raw, reason));
    }
    let normalized: String = raw.nfc().collect();
    let mut segments = Vec::new();
    for segment in normalized.split('/') {
        match segment {
            "" => return Err(HostError::unsafe_path(raw, "empty path segment")),
            "." => return Err(HostError::unsafe_path(raw, "current directory segment")),
            ".." => return Err(HostError::unsafe_path(raw, "parent directory segment")),
            s => segments.push(s.to_owned()),
        }
    }
    Ok(segments)
}

/// Mirrors `checkRelativePath` from `@thoth/domain`.
fn check_relative(raw: &str) -> Option<&'static str> {
    if raw.contains('\0') {
        return Some("NUL byte");
    }
    if raw.contains('\\') {
        return Some("backslash separator");
    }
    if raw.starts_with('/') {
        return Some("absolute path");
    }
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Some("drive letter");
    }
    if raw.split('/').any(|s| s == "..") {
        return Some("parent directory segment");
    }
    None
}

/// Source-relative path as listed by `source.list` (not normalized: names may be NFD on disk).
pub fn source_segments(raw: &str) -> HostResult<Vec<String>> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    if raw.len() > MAX_PATH_BYTES {
        return Err(HostError::bad_argument("Path is too long"));
    }
    let mut segments = Vec::new();
    for segment in raw.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains('\0') {
            return Err(HostError::unsafe_path(raw, "unsafe source path segment"));
        }
        segments.push(segment.to_owned());
    }
    Ok(segments)
}

/// True when the vault-relative path is inside Thoth's metadata directory (case-insensitive, like `isReservedPath`).
pub fn is_reserved_first_segment(segment: &str) -> bool {
    segment.nfc().collect::<String>().to_lowercase() == ".thoth"
}

/// Roots a vault (or import folder) may never be: the filesystem root, the
/// home directory and its ancestors, the host's own data directory and its
/// ancestors (a vault there could rewrite the recent list), and system trees.
pub fn check_root_policy(root: &Path, home: Option<&Path>, data_dir: Option<&Path>) -> HostResult<()> {
    let refuse = |why: &str| Err(HostError::not_allowed(format!("{} cannot be opened: {why}", root.display())));
    if !root.is_absolute() || root.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return refuse("not a canonical absolute path");
    }
    if root.parent().is_none() {
        return refuse("filesystem root");
    }
    if let Some(home) = home {
        if home.starts_with(root) {
            return refuse("home directory or one of its ancestors");
        }
        // ~/Library is app data, except the cloud-sync folders users keep documents in.
        let library = home.join("Library");
        let synced = [library.join("Mobile Documents"), library.join("CloudStorage")];
        if root.starts_with(&library) && !synced.iter().any(|s| root.starts_with(s) && root != s.as_path()) {
            return refuse("inside ~/Library");
        }
    }
    if let Some(data) = data_dir
        && (data.starts_with(root) || root.starts_with(data))
    {
        return refuse("overlaps Thoth's own data directory");
    }
    const SYSTEM_TREES: &[&str] = &[
        "/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/dev", "/cores", "/private/etc", "/proc", "/sys", "/boot",
        "/run", "/snap",
    ];
    const SYSTEM_DIRS: &[&str] = &[
        "/private", "/private/var", "/var", "/private/tmp", "/tmp", "/Users", "/Volumes", "/home", "/opt", "/mnt", "/media", "/root", "/srv",
    ];
    if SYSTEM_TREES.iter().any(|t| root.starts_with(t)) || SYSTEM_DIRS.iter().any(|d| root == Path::new(d)) {
        return refuse("system directory");
    }
    Ok(())
}

/// Canonicalizes a user-supplied absolute path (resolving symlinks, as when the user picked it).
pub fn canonical(raw: &str) -> HostResult<PathBuf> {
    if raw.is_empty() || raw.len() > MAX_PATH_BYTES || raw.contains('\0') {
        return Err(HostError::bad_argument("Invalid location"));
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(HostError::bad_argument("Location must be an absolute path"));
    }
    std::fs::canonicalize(path).map_err(|e| HostError::io(&e, "open", raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_paths_follow_domain_rules() {
        assert_eq!(vault_segments("a/b.md", false).unwrap(), vec!["a", "b.md"]);
        assert!(vault_segments("", true).unwrap().is_empty());
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a\\b", "C:x", "a\0b", "a//b", "./a", "a/", ".."] {
            assert_eq!(vault_segments(bad, false).unwrap_err().code, "UNSAFE_PATH", "{bad:?}");
        }
        // NFD input is normalized to NFC.
        assert_eq!(vault_segments("cafe\u{301}.md", false).unwrap(), vec!["caf\u{e9}.md"]);
    }

    #[test]
    fn root_policy_refuses_dangerous_roots() {
        let home = Path::new("/Users/alice");
        let data = Path::new("/Users/alice/Library/Application Support/app.thoth.desktop");
        for bad in ["/", "/Users", "/Users/alice", "/System/Library", "/usr/local", "/private/var", "/Users/alice/Library/Mail"] {
            assert!(check_root_policy(Path::new(bad), Some(home), Some(data)).is_err(), "{bad}");
        }
        assert!(check_root_policy(Path::new("/Users/alice/Notes"), Some(home), Some(data)).is_ok());
        assert!(check_root_policy(Path::new("/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/Notes"), Some(home), Some(data)).is_ok());
        assert!(check_root_policy(Path::new("/Users/alice/Library/CloudStorage"), Some(home), Some(data)).is_err());
        assert!(check_root_policy(Path::new("/private/var/folders/x/T/vault"), Some(home), Some(data)).is_ok());
        assert!(check_root_policy(Path::new("/srv/x"), None, Some(Path::new("/srv/x/data"))).is_err());
    }
}
