//! Root paths on Windows: the canonical form the host shows and compares, the verbatim form it opens, and the root
//! policy (the Windows counterpart of `paths::check_root_policy`).
//!
//! `std::fs::canonicalize` returns verbatim paths (`\\?\C:\Notes`). The host keeps the plain form (`C:\Notes`), the
//! one Node's `realpath`, Explorer and the user see, and adds the `\\?\` prefix back whenever it opens a root itself,
//! so long paths work. A path whose plain form would mean something else to Win32 (a component ending in a dot or
//! space, a device name) stays verbatim.
use crate::error::{HostError, HostResult};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf, Prefix};

/// `std::fs::canonicalize`, in plain form.
pub fn canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path).map(|p| simplify(&p))
}

/// `\\?\C:\x` → `C:\x`, `\\?\UNC\server\share\x` → `\\server\share\x`; anything else unchanged.
pub fn simplify(path: &Path) -> PathBuf {
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else { return path.to_owned() };
    let rest: Vec<Component<'_>> = components.collect();
    let plain_safe = rest.iter().all(|c| match c {
        Component::RootDir => true,
        Component::Normal(name) => name.to_str().is_some_and(|n| super::names::segment_problem(n).is_none()),
        _ => false,
    });
    if !plain_safe {
        return path.to_owned();
    }
    let head: OsString = match prefix.kind() {
        Prefix::VerbatimDisk(drive) => format!("{}:", drive as char).into(),
        Prefix::VerbatimUNC(server, share) => {
            let mut s = OsString::from(r"\\");
            s.push(server);
            s.push(r"\");
            s.push(share);
            s
        }
        _ => return path.to_owned(),
    };
    let mut out = PathBuf::from(head);
    for c in rest {
        out.push(c.as_os_str());
    }
    out
}

/// `C:\x` → `\\?\C:\x`, `\\server\share\x` → `\\?\UNC\server\share\x`, for the host's own opens of absolute paths
/// (no `MAX_PATH` limit, no Win32 name rewriting). Verbatim paths are returned as they are.
pub fn verbatim(path: &Path) -> PathBuf {
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else { return path.to_owned() };
    let head: OsString = match prefix.kind() {
        Prefix::Disk(drive) => format!(r"\\?\{}:", drive as char).into(),
        Prefix::UNC(server, share) => {
            let mut s = OsString::from(r"\\?\UNC\");
            s.push(server);
            s.push(r"\");
            s.push(share);
            s
        }
        _ => return path.to_owned(),
    };
    let mut out = PathBuf::from(head);
    out.push(r"\");
    for c in components {
        if let Component::Normal(name) = c {
            out.push(name);
        }
    }
    out
}

/// The form to hand to Win32 APIs the host does not control (SQLite, the watcher): verbatim only when the plain
/// path is too long for them.
pub fn for_win32(path: &Path) -> PathBuf {
    if path.as_os_str().len() > 240 { verbatim(path) } else { path.to_owned() }
}

/// Case-insensitive path equality on plain forms (NTFS names are case-insensitive by default).
pub fn same_path(a: &Path, b: &Path) -> bool {
    a == b || key(a) == key(b)
}

/// True when `path` is `base` or inside it, compared case-insensitively.
pub fn starts_with(path: &Path, base: &Path) -> bool {
    let (path, base) = (key(path), key(base));
    path.len() >= base.len() && path[..base.len()] == base[..]
}

fn key(path: &Path) -> Vec<String> {
    simplify(path).components().filter(|c| !matches!(c, Component::CurDir)).map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect()
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from).filter(|p| p.is_absolute()).map(|p| canonicalize(&p).unwrap_or(p))
}

/// Roots a vault (or import folder) may never be, as on macOS and Linux: a drive or share root, the user's profile
/// folder and its ancestors, `AppData` (application data, like `~/Library`; folders inside `AppData\Local\Temp` are
/// allowed, as `/private/var/folders/...` is on macOS), the host's own data directory and its ancestors, and the
/// system trees (`Windows`, `Program Files`, `ProgramData`, the recycle bin and volume information).
pub fn check_root_policy(root: &Path, home: Option<&Path>, data_dir: Option<&Path>) -> HostResult<()> {
    let refuse = |why: &str| Err(HostError::not_allowed(format!("{} cannot be opened: {why}", root.display())));
    let root = &simplify(root);
    if !root.is_absolute() || root.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return refuse("not a canonical absolute path");
    }
    if root.parent().is_none() || (root.components().count() <= 2 && root.file_name().is_none()) {
        return refuse("drive or share root");
    }
    if let Some(home) = home {
        if starts_with(home, root) {
            return refuse("home folder or one of its ancestors");
        }
        let app_data = home.join("AppData");
        let temp = app_data.join("Local").join("Temp");
        let in_temp = starts_with(root, &temp) && !same_path(root, &temp);
        if starts_with(root, &app_data) && !in_temp {
            return refuse("inside AppData");
        }
    }
    if let Some(data) = data_dir
        && (starts_with(data, root) || starts_with(root, data))
    {
        return refuse("overlaps Thoth's own data directory");
    }
    // `C:` and `SystemDrive` are drive-relative; with a separator they name the drive's root.
    let with_root = |prefix: &std::ffi::OsStr| {
        let mut s = prefix.to_owned();
        s.push(r"\");
        PathBuf::from(s)
    };
    let drive = root.components().next().map(|c| with_root(c.as_os_str())).unwrap_or_default();
    let system_drive = std::env::var_os("SystemDrive").map(|d| with_root(&d)).unwrap_or_else(|| PathBuf::from(r"C:\"));
    let mut trees: Vec<PathBuf> = ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"].iter().filter_map(|v| env_dir(v)).collect();
    for fallback in [r"C:\Windows", r"C:\Program Files", r"C:\Program Files (x86)", r"C:\ProgramData"] {
        trees.push(PathBuf::from(fallback));
    }
    for on_each_drive in ["$Recycle.Bin", "System Volume Information", "Recovery", "$WinREAgent"] {
        trees.push(drive.join(on_each_drive));
    }
    if trees.iter().any(|t| starts_with(root, t)) {
        return refuse("system folder");
    }
    let mut exact: Vec<PathBuf> = vec![system_drive.join("Users"), system_drive.join("Users").join("Public")];
    if let Some(public) = env_dir("PUBLIC") {
        exact.push(public);
    }
    if exact.iter().any(|d| same_path(root, d)) {
        return refuse("system folder");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simplifies_and_restores_verbatim_paths() {
        assert_eq!(simplify(Path::new(r"\\?\C:\Users\a\Notes")), PathBuf::from(r"C:\Users\a\Notes"));
        assert_eq!(simplify(Path::new(r"\\?\UNC\srv\share\Notes")), PathBuf::from(r"\\srv\share\Notes"));
        assert_eq!(simplify(Path::new(r"C:\x")), PathBuf::from(r"C:\x"));
        // A component Win32 would rewrite keeps the verbatim form.
        assert_eq!(simplify(Path::new(r"\\?\C:\x.\y")), PathBuf::from(r"\\?\C:\x.\y"));
        assert_eq!(simplify(Path::new(r"\\?\C:\CON")), PathBuf::from(r"\\?\C:\CON"));
        assert_eq!(verbatim(Path::new(r"C:\Users\a\Notes")), PathBuf::from(r"\\?\C:\Users\a\Notes"));
        assert_eq!(verbatim(Path::new(r"\\srv\share\Notes")), PathBuf::from(r"\\?\UNC\srv\share\Notes"));
        assert_eq!(verbatim(Path::new(r"\\?\C:\x")), PathBuf::from(r"\\?\C:\x"));
        assert!(same_path(Path::new(r"C:\Users\A\notes"), Path::new(r"\\?\c:\users\a\Notes")));
        assert!(starts_with(Path::new(r"C:\Users\A\Notes\x"), Path::new(r"c:\users\a")));
        assert!(!starts_with(Path::new(r"C:\Users\Ab"), Path::new(r"C:\Users\A")));
    }

    #[test]
    fn root_policy_refuses_dangerous_roots() {
        let home = Path::new(r"C:\Users\alice");
        let data = Path::new(r"C:\Users\alice\AppData\Roaming\io.github.creaml4tt3.thoth");
        for bad in [
            r"C:\",
            r"D:\",
            r"\\srv\share",
            r"C:\Users",
            r"C:\Users\alice",
            r"c:\users\ALICE",
            r"C:\Users\Public",
            r"C:\Windows\System32",
            r"C:\Program Files\Thoth",
            r"C:\ProgramData\x",
            r"C:\$Recycle.Bin\S-1",
            r"D:\System Volume Information",
            r"C:\Users\alice\AppData\Roaming\Other",
            r"C:\Users\alice\AppData\Local\Temp",
            r"C:\Users\alice\AppData\Roaming\io.github.creaml4tt3.thoth\vault",
            r"relative\x",
        ] {
            assert!(check_root_policy(Path::new(bad), Some(home), Some(data)).is_err(), "{bad}");
        }
        for good in [r"C:\Users\alice\Notes", r"C:\Users\alice\OneDrive\Notes", r"D:\Vaults\Work", r"\\srv\share\Notes", r"C:\Users\alice\AppData\Local\Temp\vault-1", r"\\?\C:\Users\alice\Notes"] {
            assert!(check_root_policy(Path::new(good), Some(home), Some(data)).is_ok(), "{good}");
        }
    }
}
