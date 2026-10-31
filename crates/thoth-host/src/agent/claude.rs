//! The Claude Code CLI argument policy (ADR-0007 rule 4, ADR-0008 "the webview is untrusted").
//!
//! The TypeScript adapter (`packages/agent-claude/src/args.ts`) builds the argument list; the host runs it only when
//! every token is one of the flags below with an allowed value. A compromised webview therefore cannot widen what the
//! agent may do: no `Bash`, no web tools, no `--add-dir`, no `--dangerously-skip-permissions`, no settings, plugins
//! or MCP servers, no prompt on the command line (the prompt goes to stdin). Flags were checked against
//! `claude --help` of Claude Code 2.1.310 and https://code.claude.com/docs/en/cli-reference (2026-10-25).
use crate::error::{HostError, HostResult};
use std::collections::HashSet;

/// Built-in file tools the agent may be given (https://code.claude.com/docs/en/tools-reference).
pub const FILE_TOOLS: &[&str] = &["Read", "Edit", "Write", "Glob", "Grep"];
/// The only MCP configuration accepted: none at all (with `--strict-mcp-config`).
pub const EMPTY_MCP_CONFIG: &str = r#"{"mcpServers":{}}"#;
/// The largest `--max-budget-usd` the host accepts, in US dollars. The Agent Hub offers at most US$5 a run; this is 20
/// times that, so a person who chose a bigger limit on purpose is not blocked, while a forged value cannot lift the
/// safety net (the CLI's own estimate, which can overshoot a little) to something that could drain an account.
pub const MAX_BUDGET_USD: f64 = 100.0;
const MAX_ARGS: usize = 64;
const MAX_ARG_BYTES: usize = 1024;

#[derive(Clone, Copy)]
enum Takes {
    Nothing,
    Exactly(&'static str),
    /// A comma-separated subset of `FILE_TOOLS`.
    FileTools,
    /// A comma-separated list of tool names or `name*` patterns to deny (denying more is always allowed).
    Denied,
    Model,
    Budget,
}

const FLAGS: &[(&str, Takes)] = &[
    ("-p", Takes::Nothing),
    ("--output-format", Takes::Exactly("stream-json")),
    ("--verbose", Takes::Nothing),
    ("--input-format", Takes::Exactly("text")),
    ("--restricted", Takes::Nothing),
    ("--safe-mode", Takes::Nothing),
    ("--strict-mcp-config", Takes::Nothing),
    ("--mcp-config", Takes::Exactly(EMPTY_MCP_CONFIG)),
    ("--tools", Takes::FileTools),
    ("--allowedTools", Takes::FileTools),
    ("--disallowedTools", Takes::Denied),
    ("--permission-mode", Takes::Exactly("dontAsk")),
    ("--permission-prompts", Takes::Exactly("none")),
    ("--no-session-persistence", Takes::Nothing),
    ("--disable-slash-commands", Takes::Nothing),
    ("--model", Takes::Model),
    ("--max-budget-usd", Takes::Budget),
];

/// Flags every run must carry: print mode with structured output, restricted tools and settings, no MCP servers,
/// no prompts nobody could answer, nothing saved to the user's session history.
const REQUIRED: &[&str] = &[
    "-p",
    "--output-format",
    "--verbose",
    "--restricted",
    "--safe-mode",
    "--strict-mcp-config",
    "--mcp-config",
    "--tools",
    "--permission-mode",
    "--permission-prompts",
    "--no-session-persistence",
];

fn refuse(message: impl Into<String>) -> HostError {
    HostError::not_allowed(message)
}

/// Checks a Claude Code argument list against the policy. Positional arguments are refused: the prompt is stdin.
pub fn validate(argv: &[String]) -> HostResult<()> {
    if argv.len() > MAX_ARGS {
        return Err(refuse("Too many agent arguments"));
    }
    if argv.iter().any(|a| a.len() > MAX_ARG_BYTES || a.contains('\0')) {
        return Err(refuse("Agent argument too long or not text"));
    }
    let mut seen = HashSet::new();
    let mut i = 0;
    while i < argv.len() {
        let flag = argv[i].as_str();
        let Some((name, takes)) = FLAGS.iter().find(|(name, _)| *name == flag) else {
            return Err(refuse(format!("The agent flag {flag:?} is not allowed")));
        };
        if !seen.insert(*name) {
            return Err(refuse(format!("The agent flag {flag} is given twice")));
        }
        i += 1;
        if matches!(takes, Takes::Nothing) {
            continue;
        }
        let Some(value) = argv.get(i) else { return Err(refuse(format!("The agent flag {flag} needs a value"))) };
        i += 1;
        let ok = match takes {
            Takes::Nothing => true,
            Takes::Exactly(expected) => value == expected,
            Takes::FileTools => !value.is_empty() && value.split(',').all(|t| FILE_TOOLS.contains(&t)),
            Takes::Denied => !value.is_empty() && value.split(',').all(denied_name),
            Takes::Model => model_name(value),
            Takes::Budget => budget(value),
        };
        if !ok {
            return Err(refuse(format!("The value of {flag} is not allowed")));
        }
    }
    for required in REQUIRED {
        if !seen.contains(required) {
            return Err(refuse(format!("The agent flag {required} is required")));
        }
    }
    Ok(())
}

/// `Bash`, `WebFetch`, `mcp__*`: a tool name, optionally ending in `*`.
fn denied_name(name: &str) -> bool {
    let core = name.strip_suffix('*').unwrap_or(name);
    !core.is_empty() && core.len() <= 64 && core.starts_with(|c: char| c.is_ascii_alphabetic()) && core.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// An alias (`sonnet`) or a full model name (`claude-sonnet-5`, `claude-sonnet-5[1m]`). Never starts with `-`.
fn model_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._:-[]".contains(c))
}

/// A positive dollar amount with at most two decimals and at most [`MAX_BUDGET_USD`].
fn budget(value: &str) -> bool {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    if whole.is_empty() || whole.len() > 3 || !digits(whole) || fraction.len() > 2 || !digits(fraction) || (value.contains('.') && fraction.is_empty()) {
        return false;
    }
    matches!(value.parse::<f64>(), Ok(n) if n > 0.0 && n <= MAX_BUDGET_USD)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    /// The exact argument lists `packages/agent-claude` builds (its tests check the same file).
    fn adapter_fixtures() -> Vec<Vec<String>> {
        let text = include_str!("../../../../packages/agent-claude/test/fixtures/argv.json");
        let value: serde_json::Value = serde_json::from_str(text).unwrap();
        value["cases"].as_array().unwrap().iter().map(|c| c["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect()).collect()
    }

    #[test]
    fn accepts_what_the_adapter_builds() {
        let fixtures = adapter_fixtures();
        assert!(fixtures.len() >= 2);
        for argv in fixtures {
            validate(&argv).unwrap_or_else(|e| panic!("{argv:?}: {e}"));
        }
    }

    #[test]
    fn refuses_anything_that_widens_the_agent() {
        let base = adapter_fixtures().remove(0);
        let with = |extra: &[&str]| {
            let mut v = base.clone();
            v.extend(args(extra));
            v
        };
        for extra in [
            &["--dangerously-skip-permissions"][..],
            &["--allow-dangerously-skip-permissions"],
            &["--add-dir", "/"],
            &["--settings", "{}"],
            &["--plugin-dir", "/tmp/p"],
            &["--append-system-prompt", "x"],
            &["--agents", "{}"],
            &["--resume", "abc"],
            &["--continue"],
            &["--worktree"],
            &["write a poem"],
            &["--", "prompt"],
            &["--debug-file", "/tmp/x"],
            &["-p"],
        ] {
            assert_eq!(validate(&with(extra)).unwrap_err().code, "NOT_ALLOWED", "{extra:?}");
        }
        let replace = |flag: &str, value: &str| {
            let mut v = base.clone();
            let i = v.iter().position(|a| a == flag).unwrap();
            v[i + 1] = value.to_owned();
            v
        };
        for (flag, value) in [
            ("--tools", "Read,Edit,Bash"),
            ("--tools", "default"),
            ("--tools", ""),
            ("--permission-mode", "bypassPermissions"),
            ("--permission-mode", "acceptEdits"),
            ("--permission-prompts", "host"),
            ("--mcp-config", r#"{"mcpServers":{"x":{"command":"sh"}}}"#),
            ("--mcp-config", "/tmp/mcp.json"),
            ("--output-format", "text"),
        ] {
            assert_eq!(validate(&replace(flag, value)).unwrap_err().code, "NOT_ALLOWED", "{flag} {value}");
        }
        for required in REQUIRED {
            let mut v = base.clone();
            let i = v.iter().position(|a| a == required).unwrap();
            let takes_value = !matches!(FLAGS.iter().find(|(n, _)| n == required).unwrap().1, Takes::Nothing);
            v.drain(i..if takes_value { i + 2 } else { i + 1 });
            assert!(validate(&v).is_err(), "{required} missing");
        }
    }

    #[test]
    fn checks_model_and_budget_values() {
        for good in ["sonnet", "claude-sonnet-5", "claude-sonnet-5[1m]", "us.anthropic.claude:1"] {
            assert!(model_name(good), "{good}");
        }
        for bad in ["", "-p", "--add-dir", "a b", "x;rm", &"m".repeat(101)] {
            assert!(!model_name(bad), "{bad}");
        }
        for good in ["1", "0.25", "0.5", "5.00", "100", "100.00", "99.99"] {
            assert!(budget(good), "{good}");
        }
        for bad in ["0", "0.00", "-1", "1.", ".5", "1.234", "1e3", "100.01", "101", "1000", "1001", "abc", ""] {
            assert!(!budget(bad), "{bad}");
        }
        assert!(denied_name("mcp__*") && denied_name("Bash") && !denied_name("Bash(rm *)") && !denied_name("*"));
    }
}
