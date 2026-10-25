# ADR-0007: Agent adapter contract and execution security

- **Status:** Accepted for the Claude Code CLI adapter (Phase 4), with the decisions below taken on 2026-10-25
  (owner to confirm). Proposed for the Codex adapter and for OS-level sandboxing.
- **Date:** 2026-10-20 (decisions added 2026-10-25)

## Context

The Agent Hub drives AI CLI tools the user already owns (Claude Code CLI, Codex
CLI); there is no required Thoth AI subscription (spec section 2). The Agent Hub
is a control surface, not a content store (section 3.3). A prompt is not a
security sandbox, agent output is untrusted, and Thoth must not scrape provider
credentials (sections 10, 12). CLI interfaces change over time and must not be
guessed.

## Decision

1. **Contract.** The `AgentProvider` interface from spec section 10 lives in
   `packages/agent-core`. Adapters are `packages/agent-claude` and
   `packages/agent-codex`. The Claude Code CLI adapter is built end-to-end first,
   then Codex.
2. **No invented CLI details.** CLI flags and output formats are verified against
   the installed CLI's official documentation and `--help` at implementation time.
   Capabilities are detected, not assumed.
3. **Credentials.** Thoth uses the user's existing CLI login and never reads or
   copies provider credentials. Thoth-owned secrets are stored in the OS
   credential store.
4. **Execution scope.** A task runs in a scoped temporary working directory that
   contains copies of only the user-selected pages and folders.
5. **Review before apply.** Proposed changes are diffed against the originals and
   applied to managed notes only after explicit user review, through the same
   compare-and-swap write path as other writes (ADR-0001). Agent output is
   untrusted input.
6. **Sandboxing.** Prompts are not a sandbox. OS-level sandboxing is used where
   available; per-platform feasibility is an open question.
7. **Agent Hub data.** It stores task and run metadata (provider, task, selected
   context, changed files, approvals, outcome). It is not a content store.

## Decisions for Phase 4 (decided 2026-10-25, owner to confirm)

The owner asked for Phase 4 to start with conservative defaults for the open questions.

1. **Context.** Copies of the Private Space pages and folders the user selects, plus the attachments those pages
   link to (resolved links in the index, so relative links still work), at their vault paths in a fresh directory
   under the app data folder: `<app data>/agent-runs/run_<128-bit hex>/work`, mode `0700`. Not a git worktree, even
   when the vault is a git repository. Workspace (server) content is out of scope for now. A selection that names
   something missing or reserved is refused, never silently reduced.
2. **Working directory and tools.** The CLI's cwd is that directory. Claude Code runs with `--restricted` (no
   command- or code-running tools, no WebFetch, file tools confined to the working directories, user/project/local
   settings ignored, `bypassPermissions` refused), `--safe-mode` (no CLAUDE.md, skills, plugins, hooks, custom
   agents, auto memory), `--strict-mcp-config` with an empty MCP config, `--tools` and `--allowedTools`
   `Read,Edit,Write,Glob,Grep`, `--disallowedTools mcp__*`, `--permission-mode dontAsk` with
   `--permission-prompts none` (no TTY: anything that would prompt is denied), `--no-session-persistence` and
   `--disable-slash-commands`. The prompt goes to stdin. Verified against Claude Code 2.1.310, its `--help`, the
   official docs and real runs (`packages/agent-claude/README.md`); a real run confirmed that a read outside the
   working directory is denied and that no shell tool exists.
3. **The host enforces the argument list.** The TypeScript adapter builds it; the Rust host runs the CLI only if
   every token is one of the policy's flags with an allowed value (`crates/thoth-host/src/agent/claude.rs`), so a
   compromised webview (ADR-0008: the webview is untrusted) cannot add Bash, `--add-dir`, a permission bypass,
   settings, plugins or MCP servers. Both sides test the same fixture (`packages/agent-claude/test/fixtures/argv.json`).
   This is dedicated `agent.*` host commands, not a general process API: the webview never names a program, a path
   or an environment; it names a provider and a run handle.
4. **No OS-level sandbox in this phase.** The CLI runs with the user's OS permissions; the restrictions above are
   the CLI's own. The Agent Hub says so on screen: "The agent runs with your user permissions. Thoth limits what it
   is given, not what it can do." Sandboxing per platform stays an open question.
5. **Detection.** The host looks for `claude` on `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`,
   `~/.claude/local`, `~/.local/bin`, `~/.npm-global/bin` and `$NPM_CONFIG_PREFIX/bin` (an app started from the
   Dock has a minimal `PATH`). It runs `--version` (semver, at least 2.1.259, the first with every flag above),
   `--help` (every flag must be listed, and `dontAsk` among the permission modes) and `auth status --json` (the CLI's
   own `loggedIn`). At run time "not logged in" comes from the CLI's own output (`authentication_failed`,
   "Not logged in · Please run /login"). Each state has a fix in the UI. Thoth never reads credential files or the
   keychain. Detection runs when the Agent Hub tab is opened or "Check again" is pressed.
6. **Credentials and environment.** Thoth never reads, copies or passes provider credentials. The child inherits the
   user's environment minus every `THOTH_*` variable and any variable whose value names an open vault, with `PWD`
   set to the working directory. Prompts and agent output are never sent to analytics or logged (the desktop app
   has no analytics).
7. **Process lifecycle.** Each run is its own process group. Cancel sends SIGTERM to the group and SIGKILL after
   3 seconds; a 30-minute timeout (clamped to 1 s – 4 h) does the same; processes left in the group are killed when
   the CLI exits. Output is pulled by the webview (a bounded long poll), lines are capped at 1 MiB and stdout at
   64 MiB (beyond that the run is stopped). At most two runs at once.
8. **Review and apply.** After the run, the working directory is walked through the host's scoped API and compared
   with the staged manifest: modified, added, deleted. Names that are not safe vault paths, anything under a
   `.thoth` folder (any case), symlinks, special files, files over 32 MiB and pages that are not UTF-8 are listed
   with the reason and can never be approved. Apply writes only the approved paths, each with `writeFileAtomic` or
   `deleteFileAtomic` against the hash recorded at staging, after checking the agent's bytes still have the
   reviewed hash. A file changed in the vault since staging is a conflict and is never overwritten; the user can keep
   the agent's version as a copy, named like the editor's conflict copies.
9. **Run records.** `.thoth/agent/runs/<uuidv7>.json`, written with the vault's atomic record write (ADR-0001 §2):
   provider and version, the task text, model and budget, the context (paths, hashes, why each is there), every
   proposed change with the user's decision and the result, and the outcome (exit, cost estimate, error code). No
   page text and no agent output. They live with the vault because the context, approvals and writes are the
   vault's. The newest 200 finished records are kept.
10. **Cleanup.** A working directory is deleted when a run is cancelled, when it proposed nothing, after apply (or
    once the last conflict copy is made), on discard, when the vault closes and when the app exits. On the next
    start the host deletes every run folder it does not own (`agent.sweep`) and unfinished records become
    `interrupted`, like the transfer engine's journal recovery.

## Consequences

- Positive: agents never touch live notes directly; a stale or concurrent edit is
  caught by the existing CAS rule.
- Positive: no credential handling surface in Thoth.
- Negative: copying context into a temp directory costs disk and time and means
  agents cannot see unselected linked pages.
- Negative: without OS sandboxing, an agent process still has the user's OS
  permissions; the temp directory limits intent, not capability.
- Negative: the argument policy exists twice (TypeScript builds, Rust checks); a shared fixture keeps them equal.
- Negative: the task text is stored in the vault's `.thoth/` folder, so it travels with the vault (sync, backup).
- Follow-up: detection of installation status with actionable messages (done for Claude Code);
  cleanup of temp directories after runs (done); audit of approvals (the run record).

## Alternatives considered

- **Run the agent directly in the vault.** Rejected: live notes could change
  without review.
- **Thoth-hosted or API-key-based AI.** Out of scope; locked decision is
  user-owned CLI tools.
- **Prompt-only restrictions as protection.** Rejected: not a security boundary.
- **Both providers in parallel.** Rejected in favor of one provider end-to-end
  first (spec section 10).
- **A generic process API for the webview** (run a binary with any arguments). Rejected: the webview is untrusted.
- **The host builds the argument list itself.** Possible, but the spec puts provider logic in TypeScript; the host
  keeps the final say by checking the list.
- **`--bare`.** Rejected: it never reads the subscription login (OAuth or keychain), so most users could not run it.
- **Pushing output as host events.** Rejected for pulling: nothing is lost before the webview listens, and the same
  call works over Tauri, the stdio harness and the e2e bridge.
- **Run records in the app data folder.** Rejected: the records describe the vault's pages and writes.

## Spec references

Section 2 (agent integration), 3.3, 4, 10, 12, 13 (P4), 14 (steps 9-10), 15
step 7.

## Open questions

- OS-level sandboxing options per platform (macOS, Windows, Linux).
- ~~Whether a temporary git worktree is used instead of a plain temp directory when the vault is a git
  repository.~~ Not for now (decision 1).
- Handling of Workspace content as agent context (requires export permission checks, ADR-0009). Deferred.
- ~~Exact capability detection mechanism per CLI.~~ Decided for Claude Code (decision 5); Codex when it is built.
- Windows: the CLI is found and run, but cancel cannot signal a process group yet (Job Objects are the likely
  answer). The desktop app currently ships for macOS.
