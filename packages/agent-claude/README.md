# @thoth/agent-claude

The Claude Code CLI adapter for the Agent Hub (ADR-0007). It builds the command line, interprets the host's probes,
and turns `stream-json` output into `AgentEvent`s. It never runs anything itself: the native host
(`crates/thoth-host/src/agent`) finds the binary, checks the argument list against its own copy of the policy, and
runs it in the staged working directory.

Everything below was checked on 2026-10-25 against Claude Code **2.1.310** (`claude --help`, saved as
`test/fixtures/help-2.1.310.txt`) and the official docs, then confirmed by real runs (about USD 0.004 in total,
`--model haiku`). Nothing here is assumed from memory.

## Command line

The prompt is written to the CLI's stdin; it is never an argument.

```
claude -p --output-format stream-json --verbose --input-format text
  --restricted --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --tools Read,Edit,Write,Glob,Grep --allowedTools Read,Edit,Write,Glob,Grep --disallowedTools 'mcp__*'
  --permission-mode dontAsk --permission-prompts none
  --no-session-persistence --disable-slash-commands
  [--model <alias or name>] [--max-budget-usd <amount>]
```

| Flag | Why | Source |
|---|---|---|
| `-p` | Non-interactive print mode. | [CLI reference](https://code.claude.com/docs/en/cli-reference), [headless](https://code.claude.com/docs/en/headless) |
| `--output-format stream-json` + `--verbose` | Newline-delimited JSON events while the run goes; stream-json needs `--verbose` in print mode. | CLI reference, headless ("Stream responses") |
| `--input-format text` | The prompt comes from stdin (print mode reads stdin). | CLI reference, headless ("Pipe data through Claude") |
| `--restricted` (≥ 2.1.248) | Removes the built-in tools that run commands or code and WebFetch, confines the file tools to the working directory, loads only managed settings, refuses `bypassPermissions`. | CLI reference, `--help` |
| `--safe-mode` | No CLAUDE.md, skills, plugins, hooks, custom agents, auto memory. Auth, model selection and built-in tools work normally (unlike `--bare`, which would not use the user's subscription login). | CLI reference |
| `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` | No MCP servers, not even the user's configured ones. | CLI reference |
| `--tools Read,Edit,Write,Glob,Grep` | The only built-in tools available. Naming Glob/Grep brings them back on macOS/Linux, where the default set leaves them out. | CLI reference, [tools reference](https://code.claude.com/docs/en/tools-reference) |
| `--allowedTools` (same list) | These run without a permission prompt. | CLI reference, headless ("Auto-approve tools") |
| `--disallowedTools 'mcp__*'` | Belt and braces: `--tools` does not cover MCP tools. | CLI reference |
| `--permission-mode dontAsk` | Anything that would prompt is denied (there is no terminal to answer). | [Permission modes](https://code.claude.com/docs/en/permission-modes), headless |
| `--permission-prompts none` (≥ 2.1.259) | Nobody answers prompts; Claude is told not to retry. Denials arrive as `system/permission_denied`. | CLI reference, headless ("Turn off permission prompts") |
| `--no-session-persistence` | Nothing is added to the user's session history. | CLI reference |
| `--disable-slash-commands` | No skills or commands. | CLI reference |
| `--model`, `--max-budget-usd` | Optional; the budget is the CLI's own client-side estimate and can be exceeded slightly. | CLI reference |

Not used on purpose: `--bare` (no OAuth/keychain login), `--add-dir`, `--settings`, `--plugin-dir`, `--agents`,
`--dangerously-skip-permissions`, `--resume`/`--continue`, `--worktree`, `--append-system-prompt`.

`MIN_VERSION` is **2.1.259** (the newest flag above). Detection also checks that every flag appears in `--help`,
and that `dontAsk` is one of the `--permission-mode` choices.

## Detection

The host runs three fixed probes in a neutral folder: `claude --version` (`2.1.310 (Claude Code)`),
`claude --help`, and `claude auth status --json`, which prints `{"loggedIn": true|false, ...}` (exit code 1 when
signed out). Thoth never reads `~/.claude`, credential files or the keychain. States: `missing` (with the folders
searched), `too_old`, `unsupported` (flags missing from `--help`), `not_logged_in`, `ready`, `error`.

The host looks in `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`, `~/.claude/local`, `~/.local/bin`,
`~/.npm-global/bin` and `$NPM_CONFIG_PREFIX/bin` (a desktop app started from the Dock has a minimal `PATH`).

## Events relied on

From the recorded runs (`test/fixtures/*.jsonl`) and the
[Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) (`SDKMessage` types).
Unknown types and fields are ignored.

| Line | Fields read | Agent Hub event |
|---|---|---|
| `{"type":"system","subtype":"init"}` | `cwd`, `tools`, `model`, `claude_code_version`, `permissionMode` | `session` |
| `{"type":"system","subtype":"permission_denied"}` | `tool_name`, `message` | `denied` |
| `{"type":"system","subtype":"api_retry"}` | `attempt`, `error` | `retry` |
| `{"type":"assistant"}` | `message.content[]` blocks `text` (`text`) and `tool_use` (`id`, `name`, `input.file_path`/`path`/`pattern`); top-level `error` such as `authentication_failed`, `model_not_found`, `billing_error`, `rate_limit` | `text`, `tool`, `error` |
| `{"type":"user"}` | `message.content[]` `tool_result` with `is_error: true` | `tool_error` |
| `{"type":"result"}` | `is_error`, `subtype` (`success` or an error subtype), `result`, `total_cost_usd`, `num_turns`, `duration_ms` | `result` (+ `error`) |

Ignored: `rate_limit_event`, `system/thinking_tokens`, `system/ui_invalidate`, `stream_event`, hook events.

Recorded facts: a signed-out run prints an assistant message with `"error":"authentication_failed"` and a result
with `"is_error":true,"result":"Not logged in · Please run /login"` and exits 1. An unknown model gives
`"error":"model_not_found"`, `api_error_status: 404`, cost 0, exit 1. With `--restricted`, a `Read` outside the
working directory is denied (`permission_denied`, then an `is_error` tool result) and listed in the result's
`permission_denials`. On SIGTERM the CLI exits with 143 (headless docs; the host sends SIGTERM to the process group,
then SIGKILL after 3 s).

## Tests

- `test/args.test.ts`: the argument lists are exactly `test/fixtures/argv.json`; the Rust policy tests accept the
  same file.
- `test/stream.test.ts`, `test/detect.test.ts`: the recorded output and help text.
- `test/fake-claude/claude`: a Node script standing in for the CLI (probes, stream-json shaped like the recordings,
  directives in the prompt that edit files, hang, or fail). It records argv, cwd, environment, stdin and the files it
  saw next to its working directory. Used by `tests/agent`, `crates/thoth-host/tests/agent.rs`,
  `apps/desktop/test/agents.test.tsx` and `tests/e2e/agent-hub.e2e.ts`. CI never calls the real model.
- `tests/agent/real-claude.test.ts`: a manual smoke test with the real CLI on the Rust host, skipped unless
  `THOTH_REAL_CLAUDE=1`.
