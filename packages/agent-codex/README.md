# @thoth/agent-codex

The OpenAI Codex CLI adapter for the Agent Hub (ADR-0007). It builds the `codex exec` command line, interprets the
host's probes, and turns `--json` output into `AgentEvent`s. It never runs anything itself: the native host
(`crates/thoth-host/src/agent`) finds the binary, checks the argument list against its own copy of the policy
(`codex.rs`), and runs it in the staged working directory.

Everything below was checked on 2026-10-25 against Codex CLI **0.164.0** (`codex --help`, `codex exec --help` saved as
`test/fixtures/help-exec-0.164.0.txt`, `codex login status`, `codex sandbox`, `codex debug prompt-input`, and
`--strict-config`, which refuses any `-c` key this version does not know), the official docs and the CLI's source at
the `rust-v0.164.0` tag, then confirmed by real runs (see "Real runs"). Nothing here is assumed from memory.

Docs used (`developers.openai.com/codex/...` redirects to these pages):
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[command line options](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
[sandbox](https://learn.chatgpt.com/docs/sandboxing),
[agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security),
[permissions](https://learn.chatgpt.com/docs/permissions),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced),
[AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox),
[installing the CLI](https://learn.chatgpt.com/docs/codex/cli).

## The difference from Claude Code

Claude Code can run without a shell (`--restricted`), so Thoth gives it only file tools. Codex's main tool *is* the
shell, and there is no flag that takes it away. So Thoth does not try to; instead every command Codex runs, and
Codex's own file edits (`apply_patch`, which re-runs the Codex binary inside the sandbox), run inside **Codex's own
OS sandbox** (Seatbelt on macOS, bubblewrap plus seccomp on Linux and WSL2, the native Windows sandbox), with a
permission profile Thoth defines on the command line:

| Profile rule | Effect | Verified |
|---|---|---|
| `:minimal` = read | Only the platform and runtime paths common tools need are readable. | `codex sandbox` with the profile: `cat` of a file in the home folder and in `/tmp` → "Operation not permitted"; `ls ~` denied |
| `:workspace_roots` = write | The working directory (the session's workspace root) is readable and writable. | a sandboxed write inside succeeds, one in the home folder fails |
| `:slash_tmp` = deny, `:tmpdir` = deny | `/tmp` and `$TMPDIR` are neither readable nor writable (a working directory inside `$TMPDIR` still is: the more specific rule wins). | `codex sandbox` checks; `codex debug prompt-input` lists both as denied reads |
| `network.enabled` = false | Commands have no network. | `curl https://example.com` → "Could not resolve host", in a real run too |

This is stronger than the older `--sandbox workspace-write` mode, which can **read the whole disk** (a sandboxed
`cat ~/…` succeeded in that mode). Profiles are documented as beta, so `--strict-config` makes a renamed key fail the
run instead of being ignored, and the older `sandbox_workspace_write` settings are set as well (no network, no temp
folders) in case a system or managed config forces the older mode (the docs: the older settings win when
`sandbox_mode` appears in any loaded config file; Thoth does not load the user's, see `--ignore-user-config`).

Codex runs by its **real path** (the host resolves symlinks). Its sandbox lets the binary run itself again only under
the path it was started as; started through Homebrew's `/opt/homebrew/bin/codex` link, a real run's `apply_patch`
failed with "fs sandbox helper failed … sandbox-exec: execvp() of '/opt/homebrew/bin/codex' failed: Operation not
permitted" and Codex fell back to `sed`. Started by its real path it works (real run through the Rust host below).

Codex itself (the process that talks to OpenAI and reads its login from `CODEX_HOME`) is not sandboxed; only what it
runs is. Thoth still gives it only the copied context and reviews every change before anything is applied.

**Where the sandbox cannot start, Codex is not run.** Detection includes a fourth probe, `codex sandbox <profile> -P
thoth -- <codex> --version`: Codex's own sandbox runs the CLI itself under the same profile. If that fails (no usable
bubblewrap or user namespaces on Linux, a Windows sandbox that is not set up, a policy that forbids the profile),
the state is `sandbox_unavailable`, the Agent Hub says why with a fix, and nothing runs. The docs say Codex falls back
to a bundled helper when `bwrap` is missing and warns when that cannot create its namespace; the probe catches both.

## Command line

The prompt is written to the CLI's stdin; it is never an argument (`codex exec --help`: "If not provided as an
argument (or if `-` is used), instructions are read from stdin").

```
codex exec --json --color never --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules --strict-config
  -c approval_policy=never -c approvals_reviewer=user
  -c default_permissions=thoth
  -c permissions.thoth.filesystem.:minimal=read -c permissions.thoth.filesystem.:workspace_roots=write
  -c permissions.thoth.filesystem.:slash_tmp=deny -c permissions.thoth.filesystem.:tmpdir=deny
  -c permissions.thoth.network.enabled=false
  -c sandbox_workspace_write.network_access=false -c sandbox_workspace_write.exclude_slash_tmp=true
  -c sandbox_workspace_write.exclude_tmpdir_env_var=true
  -c web_search=disabled -c project_root_markers=[] -c project_doc_max_bytes=0
  -c history.persistence=none -c shell_environment_policy.inherit=core
  -c agents.enabled=false -c features.apps=false -c features.plugins=false -c features.multi_agent=false
  -c features.hooks=false -c features.memories=false -c features.image_generation=false
  -c features.browser_use=false -c features.computer_use=false -c features.skill_mcp_dependency_install=false
  -c check_for_update_on_startup=false
  [-m <model>]
```

Every value is written without quotes or braces: `-c` parses the value as TOML and, when that fails, takes it as a
plain string (`codex exec --help`), so `approval_policy=never` is the string `"never"`. Checked with `--strict-config`
and `codex debug prompt-input` (the profile shows in the model's `<environment_context>`). This also keeps every
token free of the characters `cmd.exe` treats specially, for npm's `codex.cmd` launcher on Windows.

| Flag or key | Why | Source |
|---|---|---|
| `exec` | Non-interactive mode. | [non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode), `codex --help` |
| `--json` | stdout becomes JSON Lines events. | non-interactive ("Create structured outputs"), `codex exec --help` |
| `--color never` | No ANSI codes in anything printed. | `codex exec --help` |
| `--ephemeral` | No session rollout files on disk. | non-interactive, `codex exec --help` |
| `--skip-git-repo-check` | The working directory is not a git repository; `exec` refuses to run outside one otherwise. | non-interactive ("Git repository required"), `codex exec --help` |
| `--ignore-user-config` | `$CODEX_HOME/config.toml` is not loaded: none of the user's MCP servers, profiles, sandbox, approval or provider settings; the login still comes from `CODEX_HOME`. Also leaves the project untrusted, so a `.codex/` folder in the copies is ignored. | `codex exec --help`, non-interactive, [advanced config](https://learn.chatgpt.com/docs/config-file/config-advanced) ("Project config files") |
| `--ignore-rules` | No user or project execpolicy `.rules` (which can allow commands outside the sandbox). | `codex exec --help`, non-interactive |
| `--strict-config` | An unknown `-c` key is an error ("unknown configuration field `x` in -c/--config override", tried). | `codex exec --help` |
| `approval_policy=never` | Never ask (nobody can answer); a command that needs more than the sandbox gets the failure. `exec` already defaults to it unless an automatic reviewer is configured; set explicitly so the host can check it. | [approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security) ("Run without approval prompts"), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference), source `exec/src/lib.rs` |
| `approvals_reviewer=user` | No automatic reviewer that could approve an escalation. | approvals & security, config reference |
| `default_permissions=thoth` + `permissions.thoth.*` | The sandbox profile above. | [permissions](https://learn.chatgpt.com/docs/permissions), config reference |
| `sandbox_workspace_write.*` | The same limits for the older sandbox mode, if a system or managed layer forces it. | config reference, [sandbox](https://learn.chatgpt.com/docs/sandboxing) |
| `web_search=disabled` | No web search tool (the default is a cached index). | config reference, approvals & security |
| `project_root_markers=[]` | The working directory is the project root: no walking up to a parent git repository for project files. | advanced config ("Project root detection") |
| `project_doc_max_bytes=0` | No AGENTS.md is read from the working directory (a copied page named AGENTS.md stays content, not instructions). | [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), config reference, source `core/src/agents_md.rs` (`max_total == 0` reads nothing); `codex debug prompt-input` |
| `history.persistence=none` | Nothing added to `~/.codex/history.jsonl`. | config reference, advanced config ("History persistence") |
| `shell_environment_policy.inherit=core` | Commands get only a core environment, not every variable of the user's. | config reference |
| `agents.enabled=false`, `features.multi_agent=false` | No sub-agents (checked: the multi-agent instructions leave the prompt). | config reference, `codex features list` |
| `features.apps=false`, `features.plugins=false` | No connectors or plugins (connector traffic is not covered by the command sandbox). | config reference |
| `features.hooks`, `memories`, `image_generation`, `browser_use`, `computer_use`, `skill_mcp_dependency_install` = false | None of these tools. | `codex features list` (0.164.0), config reference |
| `check_for_update_on_startup=false` | No update check. | config reference |
| `-m <model>` | Optional; a slug such as `gpt-5.5`. | `codex exec --help` |

Never used (the host refuses them): `--sandbox`/`-s` (any mode, and `danger-full-access` in particular),
`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--approve-for-me`, `--add-dir`,
`--search`, `--profile`/`-p`, `--cd`/`-C`, `--worktree`, `--oss`, `--image`, `--output-schema`,
`--output-last-message`, `--enable`/`--disable`, any other `-c`, `resume`/`fork`, and a prompt argument.

**Not suppressible**, documented here so it is not mistaken for a gap in the list: the user's own global
`~/.codex/AGENTS.md` and their skills (`~/.codex/skills`, `~/.agents/skills`) are still loaded; Codex reads them from
`CODEX_HOME`, which also holds the login (source: `codex-home/src/instructions`, and `codex debug prompt-input` shows
both). They are the user's own files, as the login is; anything a skill runs is inside the sandbox.

## Spending limit: none

Codex has **no spending limit**: no flag in `codex exec --help` and no setting in the configuration reference for
0.164.0 (`token_budget` and `rollout_budget` appear in `codex features list` only as "under development"). With a
ChatGPT login the usage counts against the plan, not in dollars per run. So the adapter does not claim the
`spending-limit` capability, the Agent Hub shows the field as "Not supported by Codex" (disabled), and a task that
still asks for one is refused (`LimitError`) before anything is staged, never silently dropped. The time limit is the
host's and applies as for Claude Code. Runs record Codex's **token counts** instead of a cost.

## Detection

The host runs four fixed probes in a neutral folder: `codex --version` (`codex-cli 0.164.0`), `codex exec --help`
(the exec flags are not in the top-level help), `codex login status` ("Logged in using ChatGPT", exit 0, or "Not
logged in", exit 1, both on **stderr**) and the sandbox probe above. Thoth never reads `~/.codex/auth.json` or the
keychain. States: `missing` (with the folders searched), `too_old`, `unsupported` (flags missing from
`codex exec --help`), `sandbox_unavailable`, `not_logged_in`, `ready`, `error`.

`MIN_VERSION` is **0.164.0**. `--ignore-user-config` and `--ignore-rules` exist since 0.130.0 and `--strict-config`
since 0.138.0 (the CLI's source at those tags), but the profile, its quote-free `-c` form, the sandbox probe and the
event shapes were checked only on 0.164.0, so nothing older is accepted.

Where the host looks (after `PATH`, as for Claude Code): macOS and Linux `/opt/homebrew/bin` (Homebrew cask),
`/usr/local/bin`, `~/.local/bin` (the standalone `install.sh`), `$CODEX_INSTALL_DIR`, `~/.npm-global/bin`,
`$NPM_CONFIG_PREFIX/bin` (npm); Windows `%APPDATA%\npm\codex.cmd` (npm), `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`
(the standalone `install.ps1`) and `%CODEX_INSTALL_DIR%`. Install locations were read from
[install.sh](https://chatgpt.com/codex/install.sh), [install.ps1](https://chatgpt.com/codex/install.ps1) and the npm
package `@openai/codex@0.164.0` (`bin/codex.js` starts the native binary from its platform package).

## Events relied on

The `ThreadEvent` type of the CLI's source
([`codex-rs/exec/src/exec_events.rs` at rust-v0.164.0](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/exec/src/exec_events.rs)),
the event list in [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), and the recorded runs
(`test/fixtures/*.jsonl`). Unknown types and fields are ignored.

| Line | Fields read | Agent Hub event |
|---|---|---|
| `thread.started` | (`thread_id` ignored) | `session` (the model is the one asked for; Codex does not report it) |
| `item.started` / `item.completed`, `agent_message` | `text` | `text` |
| `command_execution` | `command` (the `/bin/zsh -lc "…"` wrapper removed), `status` (`in_progress`, `completed`, `failed`, `declined`), `exit_code`, `aggregated_output` | `tool` "Shell"; `tool_error` with the exit code and the end of the output when failed; `denied` when declined |
| `file_change` | `changes[].path` (absolute; shown relative to the working directory), `changes[].kind` (`add`, `update`, `delete`), `status` | `tool` "Write", "Edit", "Delete"; `tool_error` when failed |
| `mcp_tool_call`, `web_search` | `server`/`tool`, `query` | `tool` (both are turned off; shown if they ever appear) |
| item `error` | `message` | `log` (non-fatal, such as "Model metadata for `x` not found") |
| `error` | `message`: "Reconnecting... N/M (…)" | `retry`; any other message is kept for the failure |
| `turn.completed` | `usage.input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens` | `result` ok with `tokens` |
| `turn.failed` | `error.message` (sometimes the API's JSON error) | `result` not ok + `error`: `model_not_found` (code `model_not_found`), `not_logged_in` (401), `rate_limit` (429, usage limit), `billing` (quota), else `cli` |

Ignored: `turn.started`, `item.updated`, `reasoning`, `todo_list`, `collab_tool_call`. stderr lines are shown as
logs; "Reading prompt from stdin..." is printed there on every run.

## Real runs (2026-10-25, Codex CLI 0.164.0, ChatGPT login)

Three runs used the model (1, 2 and 4, all with `-m gpt-5.6-luna`); the unknown-model run was refused before
anything was generated, and the signed-out run (below) at authentication:

1. The policy's flags but the read rule without the CLI's install folder, started through the Homebrew link: the
   edit landed through `sed` after `apply_patch` failed (see "Codex runs by its real path"), `curl` failed with
   "Could not resolve host" (`test/fixtures/stream-shell-edit.jsonl`). 136,978 input tokens (128,128 cached), 1,043
   output.
2. The same with the CLI's folder readable: `apply_patch` edited the file (`file_change`), the model reported
   `cat ../secret.txt` as "Operation not permitted" (`test/fixtures/stream-edit.jsonl`). 52,600 input (45,696
   cached), 344 output.
3. `-m thoth-no-such-model`: `turn.failed` with HTTP 400 `model_not_found` ("The 'thoth-no-such-model' model is not
   supported when using Codex with a ChatGPT account."), exit 1, no tokens (`stream-model-not-found.jsonl`).
4. The manual smoke test through the Rust host with exactly the adapter's arguments, Codex started by its real path
   (`THOTH_REAL_CODEX=1 THOTH_REAL_CODEX_MODEL=gpt-5.6-luna pnpm vitest run tests/agent/real-codex.test.ts`):
   `apply_patch` edited `Notes/Pets.md` with no sandbox helper error, `cat` of a page outside the working directory
   gave "Operation not permitted", exit 0. 53,946 input tokens (46,720 cached), 613 output. (Its first assertion
   expected the session as the very first event, but stderr's "Reading prompt from stdin..." comes first; the test
   was corrected afterwards and not run again, so its review and apply steps ran only with the fake.)

Signed out (`CODEX_HOME` pointed at an empty folder, so no login was read or used): five WebSocket and five HTTPS
reconnects with "401 Unauthorized: Missing bearer or basic authentication in header", then `turn.failed`, exit 1
(`stream-not-logged-in.jsonl`); `codex login status` said "Not logged in" with exit 1.

Cost: with a ChatGPT login there is no dollar charge; the usage counts against the plan's limits (the token counts
above). Note that in runs 2 and 4 the model's report of the denied `cat` came without a `command_execution` item, so
the transcript may not show every command a model runs; the sandbox checks themselves were made with `codex sandbox`.

## Tests

- `test/args.test.ts`: the argument lists are exactly `test/fixtures/argv.json`; the Rust policy tests accept the
  same file and refuse every widening (`crates/thoth-host/src/agent/codex.rs`).
- `test/stream.test.ts`, `test/detect.test.ts`: the recorded output and help text.
- `test/fake-codex/codex`: a Node script standing in for the CLI (the four probes, `--json` events shaped like the
  recordings, directives in the prompt that edit files, run or fail commands, hang, fail like a signed-out run or
  an unknown model). It records argv, cwd, environment, stdin and the files it saw to `fake-codex-record.json` next to
  its working directory. Used by `tests/agent/codex.test.ts`, `crates/thoth-host/tests/agent.rs`,
  `apps/desktop/test/agents.test.tsx` and `tests/e2e/agent-hub.e2e.ts`. CI never calls the real model.
- `tests/agent/real-codex.test.ts`: the manual smoke test with the real CLI on the Rust host, skipped unless
  `THOTH_REAL_CODEX=1`.
