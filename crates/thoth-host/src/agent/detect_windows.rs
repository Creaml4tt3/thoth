//! Finding Claude Code on Windows. Checked against https://code.claude.com/docs/en/setup and
//! https://code.claude.com/docs/en/troubleshoot-install (2026-10-25):
//!
//! - The native installer (recommended) puts `claude.exe` in `%USERPROFILE%\.local\bin` and does not always add
//!   that folder to `PATH`.
//! - `npm install -g @anthropic-ai/claude-code` installs the same native binary and creates `claude.cmd` (and
//!   `claude.ps1`) launchers in npm's global folder, `%APPDATA%\npm` unless `NPM_CONFIG_PREFIX` moves it.
//! - WinGet links `claude.exe` into `%LOCALAPPDATA%\Microsoft\WinGet\Links`.
//! - Older versions made a local npm install under `%USERPROFILE%\.claude\local`.
//!
//! Only `claude.exe` and `claude.cmd` are considered (`Provider::binary_names`), in that order, and only if their
//! extension is in `PATHEXT`: never `.ps1`, `.js` or another script host.
//!
//! A `.cmd` launcher can only run through `cmd.exe`, whose command-line parsing is a shell's. When the launcher is
//! the plain npm shim for a native binary (one line running `"%dp0%\...\claude.exe" %*`), the host runs that
//! `.exe` directly instead (`direct_target`), so no shell is involved. Otherwise the `.cmd` runs through Rust's
//! `std::process::Command`, which starts `cmd.exe /e:ON /v:OFF /d /c` and quotes every argument for it, refusing
//! arguments it cannot quote safely (the BatBadBut fix, CVE-2024-24576). The remaining risk is small: the argument
//! list is the policy's (`claude::validate`: fixed flags, values limited to tool names, model names, a budget and
//! one fixed JSON string), so no `%`, `^`, `&`, `|`, `<` or `>` can reach `cmd.exe`, and the prompt goes to stdin.
//! The `.cmd` file itself is the user's own install, like the binary.
use std::path::{Path, PathBuf};

/// Install folders searched after `PATH`, in order.
pub fn install_dirs() -> Vec<PathBuf> {
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from).filter(|p| p.is_absolute());
    let mut dirs = Vec::new();
    if let Some(profile) = env("USERPROFILE") {
        dirs.push(profile.join(".local").join("bin"));
    }
    if let Some(prefix) = env("NPM_CONFIG_PREFIX") {
        // On Windows npm puts the launchers in the prefix itself, not in `bin`.
        dirs.push(prefix);
    }
    if let Some(app_data) = env("APPDATA") {
        dirs.push(app_data.join("npm"));
    }
    if let Some(local) = env("LOCALAPPDATA") {
        dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
    }
    if let Some(profile) = env("USERPROFILE") {
        dirs.push(profile.join(".claude").join("local"));
    }
    dirs
}

/// True for an `.exe` or `.cmd` whose extension `PATHEXT` lists (Windows' default list does).
pub fn launchable(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase) else { return false };
    if ext != "exe" && ext != "cmd" {
        return false;
    }
    match std::env::var("PATHEXT") {
        Ok(list) => list.split(';').any(|e| e.trim().trim_start_matches('.').eq_ignore_ascii_case(&ext)),
        Err(_) => true,
    }
}

/// For a `.cmd` launcher that only runs a native `.exe` inside its own folder (npm's shim for a binary package),
/// that `.exe`; otherwise `path` unchanged. A verbatim `\\?\` path is returned in plain form, which `cmd.exe`
/// accepts.
pub fn direct_target(path: PathBuf) -> PathBuf {
    let path = crate::win::paths::simplify(&path);
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")) {
        return path;
    }
    let Some(dir) = path.parent() else { return path };
    let Ok(text) = std::fs::read(&path) else { return path };
    if text.len() > 16 * 1024 {
        return path;
    }
    match shim_target(&String::from_utf8_lossy(&text), dir) {
        Some(exe) => exe,
        None => path,
    }
}

/// Parses an npm `cmd-shim` launcher for a binary: the one command line is `"%dp0%\<relative>.exe" %*` (or with
/// `%~dp0`). The target must be an existing `.exe` under the launcher's folder, reached without `..`.
pub fn shim_target(text: &str, dir: &Path) -> Option<PathBuf> {
    let mut found = None;
    for line in text.lines().map(str::trim) {
        let lower = line.to_ascii_lowercase();
        if line.is_empty() || lower.starts_with('@') || lower.starts_with(':') || lower.starts_with("goto ") || lower.starts_with("set ") || lower == "setlocal" || lower.starts_with("call :") || lower.starts_with("exit") {
            continue;
        }
        if found.is_some() {
            // More than one command: not the plain binary shim.
            return None;
        }
        let rest = line.strip_suffix("%*")?.trim_end();
        let quoted = rest.strip_prefix('"')?.strip_suffix('"')?;
        let relative = quoted.strip_prefix(r"%dp0%\").or_else(|| quoted.strip_prefix(r"%~dp0\")).or_else(|| quoted.strip_prefix("%~dp0"))?;
        if relative.contains(['"', '%', '!', '^', '&', '|', '<', '>']) || relative.split(['\\', '/']).any(|s| s == ".." || s.is_empty()) {
            return None;
        }
        if !relative.to_ascii_lowercase().ends_with(".exe") {
            return None;
        }
        found = Some(dir.join(relative));
    }
    let exe = found?;
    let canonical_dir = crate::win::paths::canonicalize(dir).ok()?;
    let canonical_exe = crate::win::paths::canonicalize(&exe).ok()?;
    (crate::win::paths::starts_with(&canonical_exe, &canonical_dir) && std::fs::metadata(&canonical_exe).is_ok_and(|m| m.is_file())).then_some(canonical_exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_the_npm_shim_for_a_native_binary_only() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join(r"node_modules\@anthropic-ai\claude-code\bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("claude.exe"), b"MZ").unwrap();
        // What cmd-shim writes for a bin target without a shebang.
        let shim = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";
        let expected = crate::win::paths::canonicalize(&bin.join("claude.exe")).unwrap();
        assert_eq!(shim_target(shim, dir.path()), Some(expected.clone()));
        std::fs::write(dir.path().join("claude.cmd"), shim).unwrap();
        assert_eq!(direct_target(dir.path().join("claude.cmd")), expected);
        // A Node script launcher, a second command, an escape or a missing binary stay with the .cmd.
        for other in [
            "@ECHO off\r\nnode \"%~dp0\\node_modules\\x\\cli.js\" %*\r\n",
            "@ECHO off\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\" %*\r\ndel x\r\n",
            "@ECHO off\r\n\"%dp0%\\..\\claude.exe\" %*\r\n",
            "@ECHO off\r\n\"%dp0%\\missing.exe\" %*\r\n",
            "@ECHO off\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\" --flag %*\r\n",
        ] {
            assert_eq!(shim_target(other, dir.path()), None, "{other:?}");
        }
    }

    #[test]
    fn only_exe_and_cmd_launch() {
        assert!(launchable(Path::new(r"C:\x\claude.exe")) && launchable(Path::new(r"C:\x\claude.CMD")));
        for bad in [r"C:\x\claude", r"C:\x\claude.ps1", r"C:\x\claude.js", r"C:\x\claude.bat"] {
            assert!(!launchable(Path::new(bad)), "{bad}");
        }
    }
}
