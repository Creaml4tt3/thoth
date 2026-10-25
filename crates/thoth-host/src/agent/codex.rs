//! The Codex CLI argument policy (ADR-0007 rule 4, ADR-0008 "the webview is untrusted").
//!
//! The TypeScript adapter (`packages/agent-codex/src/args.ts`) builds the argument list; the host runs it only when it
//! is exactly [`ARGS`], optionally followed by `-m <model>`. Codex's main tool runs shell commands, so the shell
//! cannot be removed as it is for Claude Code; instead every list keeps Codex's own OS sandbox on with Thoth's
//! permission profile (read only the platform's runtime paths and the working directory, write only the working
//! directory, no `/tmp` or `$TMPDIR`, no network), approvals that never prompt, no web search, no user config,
//! rules, AGENTS.md, sub-agents, connectors, plugins or hooks. A compromised webview therefore cannot add
//! `--sandbox danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`, `--search`, a profile,
//! another `-c` override or a prompt on the command line (the prompt goes to stdin). Checked against
//! `codex exec --help` of Codex CLI 0.164.0, its `--strict-config` and the official docs (2026-10-25,
//! `packages/agent-codex/README.md`).
//!
//! Codex has no spending limit, so there is no budget value to check; the time limit is [`super::limits`].
use crate::error::{HostError, HostResult};
use std::ffi::OsString;
use std::path::Path;

/// Thoth's permission profile, the same as `CONFIG` in `args.ts`.
const PROFILE: &[&str] = &[
    "-c",
    "default_permissions=thoth",
    "-c",
    "permissions.thoth.filesystem.:minimal=read",
    "-c",
    "permissions.thoth.filesystem.:workspace_roots=write",
    "-c",
    "permissions.thoth.filesystem.:slash_tmp=deny",
    "-c",
    "permissions.thoth.filesystem.:tmpdir=deny",
    "-c",
    "permissions.thoth.network.enabled=false",
];

/// The whole argument list of every run, in order (`buildArgs()` in `args.ts`).
pub const ARGS: &[&str] = &[
    "exec",
    "--json",
    "--color",
    "never",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "-c",
    "approval_policy=never",
    "-c",
    "approvals_reviewer=user",
    "-c",
    "default_permissions=thoth",
    "-c",
    "permissions.thoth.filesystem.:minimal=read",
    "-c",
    "permissions.thoth.filesystem.:workspace_roots=write",
    "-c",
    "permissions.thoth.filesystem.:slash_tmp=deny",
    "-c",
    "permissions.thoth.filesystem.:tmpdir=deny",
    "-c",
    "permissions.thoth.network.enabled=false",
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "-c",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c",
    "web_search=disabled",
    "-c",
    "project_root_markers=[]",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "history.persistence=none",
    "-c",
    "shell_environment_policy.inherit=core",
    "-c",
    "agents.enabled=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.plugins=false",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.hooks=false",
    "-c",
    "features.memories=false",
    "-c",
    "features.image_generation=false",
    "-c",
    "features.browser_use=false",
    "-c",
    "features.computer_use=false",
    "-c",
    "features.skill_mcp_dependency_install=false",
    "-c",
    "check_for_update_on_startup=false",
];

/// Checks a Codex argument list: exactly [`ARGS`], then optionally `-m` and a model name. Nothing else, in no other
/// order; positional arguments are refused because the prompt is stdin.
pub fn validate(argv: &[String]) -> HostResult<()> {
    if argv.len() < ARGS.len() || argv.iter().zip(ARGS).any(|(a, b)| a != b) {
        let first = argv.iter().zip(ARGS).position(|(a, b)| a != b).unwrap_or(argv.len().min(ARGS.len()));
        return Err(HostError::not_allowed(match argv.get(first) {
            Some(token) => format!("The Codex argument {token:?} is not allowed here"),
            None => "The Codex argument list is incomplete".to_owned(),
        }));
    }
    match &argv[ARGS.len()..] {
        [] => Ok(()),
        [flag, model] if flag == "-m" && model_name(model) => Ok(()),
        [flag, _] if flag == "-m" => Err(HostError::not_allowed("The value of -m is not allowed")),
        [token, ..] => Err(HostError::not_allowed(format!("The Codex argument {token:?} is not allowed"))),
    }
}

/// A model slug (`gpt-5.5`, `gpt-6.1-sol`): ASCII letters, digits and `._:-`, starting with a letter or digit.
fn model_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 100 && name.starts_with(|c: char| c.is_ascii_alphanumeric()) && name.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}

/// The sandbox probe: Codex's own `codex sandbox` runs `<bin> --version` under Thoth's permission profile. It fails
/// where Codex's OS sandbox cannot start (no Seatbelt, no usable bubblewrap or user namespaces on Linux, a Windows
/// sandbox that is not set up), and then Codex is not run at all.
pub fn sandbox_probe(bin: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["sandbox".into()];
    args.extend(PROFILE.iter().map(OsString::from));
    args.extend(["-P".into(), "thoth".into(), "--".into(), bin.as_os_str().to_owned(), "--version".into()]);
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    /// The exact argument lists `packages/agent-codex` builds (its tests check the same file).
    fn adapter_fixtures() -> Vec<Vec<String>> {
        let text = include_str!("../../../../packages/agent-codex/test/fixtures/argv.json");
        let value: serde_json::Value = serde_json::from_str(text).unwrap();
        value["cases"].as_array().unwrap().iter().map(|c| c["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect()).collect()
    }

    #[test]
    fn accepts_what_the_adapter_builds() {
        let fixtures = adapter_fixtures();
        assert!(fixtures.len() >= 2);
        assert_eq!(fixtures[0], args(ARGS));
        for argv in fixtures {
            validate(&argv).unwrap_or_else(|e| panic!("{argv:?}: {e}"));
        }
    }

    #[test]
    fn the_sandbox_profile_is_in_every_run_and_in_the_probe() {
        let joined = ARGS.join(" ");
        assert!(joined.contains(&PROFILE.join(" ")));
        let probe = sandbox_probe(Path::new("/opt/codex/bin/codex"));
        assert_eq!(probe.first().unwrap(), "sandbox");
        assert_eq!(&probe[probe.len() - 4..], &["thoth", "--", "/opt/codex/bin/codex", "--version"].map(OsString::from));
    }

    #[test]
    fn refuses_anything_that_widens_the_agent() {
        let base = args(ARGS);
        let with = |extra: &[&str]| {
            let mut v = base.clone();
            v.extend(args(extra));
            v
        };
        for extra in [
            &["--dangerously-bypass-approvals-and-sandbox"][..],
            &["--dangerously-bypass-hook-trust"],
            &["--sandbox", "danger-full-access"],
            &["-s", "workspace-write"],
            &["--add-dir", "/"],
            &["--search"],
            &["--profile", "x"],
            &["-p", "x"],
            &["-C", "/"],
            &["--cd", "/"],
            &["--approve-for-me"],
            &["--worktree"],
            &["--oss"],
            &["-i", "/etc/passwd"],
            &["-o", "/tmp/out"],
            &["--output-schema", "/tmp/s.json"],
            &["-c", "sandbox_mode=danger-full-access"],
            &["-c", "permissions.thoth.network.enabled=true"],
            &["--enable", "apps"],
            &["write a poem"],
            &["-"],
            &["--", "prompt"],
            &["-m", "gpt-5.5", "-c", "x=1"],
            &["-m", "gpt-5.5", "-m", "o3"],
            &["-m"],
        ] {
            assert_eq!(validate(&with(extra)).unwrap_err().code, "NOT_ALLOWED", "{extra:?}");
        }
        // A changed, dropped or reordered token of the fixed list is refused too.
        for (i, _) in ARGS.iter().enumerate() {
            let mut dropped = base.clone();
            dropped.remove(i);
            assert!(validate(&dropped).is_err(), "without {}", ARGS[i]);
        }
        for (token, replacement) in [
            ("approval_policy=never", "approval_policy=on-request"),
            ("permissions.thoth.network.enabled=false", "permissions.thoth.network.enabled=true"),
            ("permissions.thoth.filesystem.:minimal=read", "permissions.thoth.filesystem.:root=read"),
            ("web_search=disabled", "web_search=live"),
            ("--ignore-user-config", "--ephemeral"),
        ] {
            let mut v = base.clone();
            let i = v.iter().position(|a| a == token).unwrap();
            v[i] = replacement.to_owned();
            assert_eq!(validate(&v).unwrap_err().code, "NOT_ALLOWED", "{replacement}");
        }
        let mut swapped = base.clone();
        swapped.swap(1, 4);
        assert!(validate(&swapped).is_err());
        assert!(validate(&[]).is_err());
    }

    #[test]
    fn checks_model_values() {
        for good in ["gpt-5.5", "gpt-6.1-sol", "o3", "gpt-5:latest"] {
            assert!(model_name(good), "{good}");
        }
        for bad in ["", "-c", "--add-dir", "a b", "x;rm", "x=y", "a\"b", "[1m]", &"m".repeat(101)] {
            assert!(!model_name(bad), "{bad}");
        }
    }
}
