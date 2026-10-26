# ADR-0007: Agent adapter contract and execution security

- **Status:** Accepted for the Claude Code CLI adapter (Phase 4), with the decisions below decided on 2026-10-25 by the
  owner. The Codex CLI adapter follows decision 13 (2026-10-25), implemented within the owner's decisions and
  proposed for the owner's review. A Thoth OS-level sandbox is deferred (see "Future: OS-level sandbox"); Codex runs
  inside its own. The amendments "Answers and sessions" (decisions 14–20, 2026-10-26) and "Conversations" (decisions
  21–27, 2026-10-26, which replace decision 20) are Proposed.
- **Date:** 2026-10-20 (decisions added 2026-10-25; context scope, limits and history answered by the owner the same day;
  answers and sessions, and conversations, 2026-10-26)

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
6. **Sandboxing.** Prompts are not a sandbox. A Thoth OS-level sandbox is not part of Phase 4 (decision 4 below); the
   plan for it is under "Future: OS-level sandbox". Codex, which runs shell commands, runs only inside Codex's own
   OS sandbox (decision 13).
7. **Agent Hub data.** It stores task and run metadata (provider, task, selected
   context, changed files, approvals, outcome). It is not a content store.

## Decisions for Phase 4 (decided 2026-10-25 by the owner)

Phase 4 started with conservative defaults for the open questions. On 2026-10-25 the owner answered them; decisions
1, 4 and 7 to 10 below were amended accordingly and decisions 11 and 12 were added.

1. **Context.** Two kinds, with different rules.
   - **Private Space (editable, reviewed).** The agent may be given any Private Space page or folder, or the **whole
     Private Space** (every file except `.thoth/` and the folders the index ignores), and may edit all of it.
     Copies go at their vault paths, with the attachments the selected pages link to (resolved links in the index,
     so relative links still work), in a fresh directory under the app data folder:
     `<app data>/agent-runs/run_<128-bit hex>/work`, mode `0700`. Not a git worktree, even when the vault is a git
     repository. Every change is still reviewed per file and applied only on approval, through compare-and-swap
     writes (rule 5 and decision 8). The existing limits (2000 files, 32 MiB a file, 256 MiB in all) apply to
     every selection including the whole space, and the form shows the file count and total size before the task
     starts, with the limit when it would be exceeded. A selection that names something missing or reserved is
     refused, never silently reduced.
   - **Workspace pages (read-only reference).** The user can add pages of a workspace on a server (from the picker
     in the task form, which lists the workspaces and their page tree). They are fetched with the ordinary
     `WorkspaceClient` (so the server authorizes every request) and copied into a clearly separate folder of the
     working directory, `workspace/<workspace name>/<page title>.md` (names made safe and unique; if the Private Space
     context already uses a top level `workspace`, the folder is `workspace (read-only)`), with file mode read-only
     (`agent.fs.write` takes `readOnly`; the Node test host does the same). The task framing put in front of the
     user's prompt says the folder holds reference copies that must not be changed, and that any change is
     discarded; the record keeps only the user's own words. **Any change under that folder after the run (modify,
     add, delete) is never offered for apply:** review lists it as "Read-only workspace page: change discarded"
     (problem `read_only`), it cannot be approved, kept as a copy or written anywhere, whatever the agent did to
     the file mode, and the check also covers differently cased folder names and a stored review that was edited
     on disk. The page is not written back to the server either: the client sends only `GET` requests for it.
   - **Who may add a workspace page.** ADR-0009 left "export" open for agent context. Decided: handing a page to an
     agent copies it out of the workspace's access control, so it is treated like a Workspace to Private copy. The
     page is refused unless the caller's role can read (all three MVP roles can) **and** the workspace is not
     `exportRestricted`; both come from a fresh `GET /workspaces` at the start of every run, so a role or flag
     that changed after the sidebar loaded still counts. The picker shows a restricted workspace with its reason
     and offers none of its pages; a page that is refused, gone, or whose server cannot be asked stops the whole
     task before anything is staged. The server stays the authority (it answers 404 or 403 for what the user may
     not read, and `export_restricted` for a restricted workspace, which the client also maps).
2. **Working directory and tools.** The CLI's cwd is that directory. Claude Code runs with `--restricted` (no
   command- or code-running tools, no WebFetch, file tools confined to the working directories, user/project/local
   settings ignored, `bypassPermissions` refused), `--safe-mode` (no CLAUDE.md, skills, plugins, hooks, custom
   agents, auto memory), `--strict-mcp-config` with an empty MCP config, `--tools` and `--allowedTools`
   `Read,Edit,Write,Glob,Grep`, `--disallowedTools mcp__*`, `--permission-mode dontAsk` with
   `--permission-prompts none` (no TTY: anything that would prompt is denied), `--no-session-persistence` and
   `--disable-slash-commands`. The prompt goes to stdin. Verified against Claude Code 2.1.310, its `--help`, the
   official docs and real runs (`packages/agent-claude/README.md`); a real run confirmed that a read outside the
   working directory is denied and that no shell tool exists. Codex: decision 13.
3. **The host enforces the argument list.** The TypeScript adapter builds it; the Rust host runs the CLI only if
   every token is one of the policy's flags with an allowed value (`crates/thoth-host/src/agent/claude.rs`), so a
   compromised webview (ADR-0008: the webview is untrusted) cannot add Bash, `--add-dir`, a permission bypass,
   settings, plugins or MCP servers. Both sides test the same fixture (`packages/agent-claude/test/fixtures/argv.json`).
   For Codex the host accepts exactly one list, optionally followed by `-m <model>` (`agent/codex.rs`, fixture
   `packages/agent-codex/test/fixtures/argv.json`), so its sandbox, approval and isolation settings cannot be changed,
   dropped or widened.
   This is dedicated `agent.*` host commands, not a general process API: the webview never names a program, a path
   or an environment; it names a provider and a run handle.
4. **No Thoth OS-level sandbox in this phase** (the owner decided: not now). The CLI runs with the user's OS
   permissions; the restrictions above are the CLI's own. The Agent Hub says so on screen: "The agent runs with your
   user permissions. Thoth limits what it is given, not what it can do." For Codex the note says that its commands
   and edits run only inside Codex's own sandbox (decision 13) while Codex itself runs with the user's permissions.
   The plan for a Thoth sandbox is under "Future: OS-level sandbox".
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
   3 seconds; the time limit (decision 11) does the same; processes left in the group are killed when the CLI
   exits. Output is pulled by the webview (a bounded long poll), lines are capped at 1 MiB and stdout at
   64 MiB (beyond that the run is stopped). At most two runs at once.
8. **Review and apply.** After the run, the working directory is walked through the host's scoped API and compared
   with the staged manifest: modified, added, deleted. Names that are not safe vault paths, anything under a
   `.thoth` folder (any case), symlinks, special files, files over 32 MiB and pages that are not UTF-8 are listed
   with the reason and can never be approved, and so is anything under the read-only workspace folder (decision 1).
   Apply writes only the approved paths, each with `writeFileAtomic` or
   `deleteFileAtomic` against the hash recorded at staging, after checking the agent's bytes still have the
   reviewed hash. A file changed in the vault since staging is a conflict and is never overwritten; the user can keep
   the agent's version as a copy, named like the editor's conflict copies.
9. **Run records.** `.thoth/agent/runs/<uuidv7>.json`, written with the vault's atomic record write (ADR-0001 §2):
   provider and version, the task text, model, budget and time limit, whether the whole space was given, the context
   (paths, hashes, why each is there; for a workspace page also its workspace and page IDs, titles and revision),
   every proposed change with the user's decision and the result, and the outcome (exit, the model that answered,
   cost estimate, error code, and whether a limit stopped it). No page text and no agent output. They live with the
   vault because the context, approvals and writes are the vault's. The newest 200 finished records are kept.
10. **Cleanup.** A working directory is deleted when a run is cancelled, when it proposed nothing, after apply (or
    once the last conflict copy is made), on discard, when the vault closes and when the app exits. On the next
    start the host deletes every run folder it does not own (`agent.sweep`) and unfinished records become
    `interrupted`, like the transfer engine's journal recovery, except a run that was waiting for review whose
    stored details are intact (decision 12), which stays reviewable.
11. **Limits** (decided by the owner, all adjustable in the Agent Hub settings and overridable per run in the task
    form; the settings are kept in the webview's `localStorage` with the other desktop preferences).
    - *Time limit:* 5, 15, 30 or 60 minutes, default 30. On expiry the host stops the process group like a cancel
      and reports `timeout`; the record says the run was stopped by the time limit.
    - *Budget:* Codex has none (decision 13): the field says "Not supported by Codex" and a task that asks for one is
      refused, never silently dropped. For Claude Code: the CLI's own `--max-budget-usd`, choices US$0.25, 0.50, 1, 2, 5 or no limit (no flag), default
      US$1. A budget stop is read from the CLI's own result, never guessed: a real run on 2026-10-25 with
      `--max-budget-usd 0.0001` printed a `result` line with `subtype: "error_max_budget_usd"`, `is_error: true`,
      `errors: ["Reached maximum budget ($0.0001)"]`, `terminal_reason: "budget_exhausted"`, no `result` text, and
      exited with 1 (cost US$0.00014; recorded as `packages/agent-claude/test/fixtures/stream-budget.jsonl`). The
      estimate is the CLI's and can be exceeded a little.
    - *The host validates, it does not clamp:* a time limit must be a whole number of milliseconds from 1 second to
      24 hours (`crates/thoth-host/src/agent/limits.rs`) and a budget more than US$0, at most two decimals and at
      most **US$100** (`claude.rs`). The budget maximum is 20 times the largest choice: a person who set a bigger
      limit on purpose is not blocked, while a forged value cannot lift the safety net to something that could
      drain an account. Values outside the bounds are refused with `BAD_ARGUMENT` / `NOT_ALLOWED` and nothing
      runs. The argument allowlist is otherwise unchanged. The Node test host and the webview apply the same
      bounds. Both a time-limit stop and a budget stop leave the work done so far reviewable, and the run panel,
      the review and the history say which limit stopped it.
12. **History (local only).** The vault keeps the metadata records (decision 9). The transcript (the streamed
    events) and what is needed to open the review again (the agent's proposed bytes for each change, the staged
    original of each changed page when the vault still holds it, and a manifest) are kept in the app data folder,
    `<app data>/agent-history/<run uuid>/` through four dedicated host commands (`agent.history.write/read/list/
    delete`), **never inside a vault, never synced or backed up with it**. The host accepts only a run UUID and a
    flat file name (`a-z 0-9 . _ -`), replaces files atomically and bounds file, run and total sizes; the webview is
    still untrusted. The manifest is written last, so its presence means the files it names are complete.
    - *Awaiting review:* after a restart a run whose record says `review` and whose stored files are intact is
      shown as "awaiting review" instead of `interrupted` and can be opened from the history. Its working directory
      is gone (swept as before); the review is rebuilt from the stored files, `stale` is judged against the vault
      as it is now, and applying still uses compare-and-swap against the hashes recorded at staging, after checking
      the stored bytes still have the reviewed hash. A page edited in the meantime is therefore a conflict, never
      an overwrite. A run whose details are missing, damaged or of the wrong size is `interrupted`.
    - *History list and details:* date, task, model, cost and outcome for each run (the vault records), and, while
      the local details exist, its transcript and the diffs (original against proposal).
    - *Retention:* 30 days by default; 7, 30, 90 days or for ever in the Agent Hub settings; plus "Delete history
      now". Details are pruned by age at start and after every run, and "Delete history now" removes all of them,
      in both cases except for the runs still going and the ones waiting for review (they are work in progress,
      not history). The metadata records stay either way.

## Amendment: answers and sessions (2026-10-26, Proposed)

The owner's report: a question such as "What content is on this page?" got only "The agent finished without changing
anything." The CLI had answered, but the answer was never shown. Decided for the owner (to accept):

14. **The answer is shown.** When a run ends, its answer is shown (`runAnswer`, `packages/agent-core/src/answer.ts`):
    the `result` event's text; when that is empty or there is no result (a time-limit stop, a crash), the last
    assistant text blocks after the last tool call (or the last text before it); never the text of a failed result,
    which is the error the outcome already shows. Same rule for Claude Code and Codex (Codex's result carries its last
    agent message). It is plain text: line breaks kept, no HTML, no Markdown, no auto-linking, as clipped by the
    adapters; selectable, with "Copy answer". It shows in the bubble's finished view (a bounded box that scrolls) and
    in the session tab. "No pages were changed." is a small line under it; with no answer the old sentence stays.
15. **Where it lives.** Never in the vault's run record (decision 9 unchanged; a test checks the record). In memory
    for the run just finished (`AgentHub.answer`), and read back from the local transcript (`RunDetails.answer`,
    decision 12) for earlier runs. When retention deleted the transcript, the session tab says so. Notifications keep
    their fixed text (ADR-0018).
16. **A session tab per run.** Tab target `{ kind: "agent-run", run }` (stored `{ k: "run", run }`; a run that is not
    a UUIDv7 is dropped on parse). Opening a run again goes to its tab. It shows the task (first line as title and tab
    name, the whole task below), agent, model, start time and state; for this window's current run, the live transcript
    with Cancel, the answer, the existing review (unchanged: per-file approval, compare-and-swap) and the result; for
    any other run, its answer, transcript and proposed changes from the local details. The old single review tab
    (`{ k: "agents" }`) showed the current run; no run is current at start, so a stored one is dropped. The web client
    drops session tabs as it dropped that one. Notifications about a run open its session tab.
17. **The bubble's "Open in a tab" icon** (running, review-ready and finished views) opens the current run's tab.
18. **The sidebar's Assistant section** (stable section id `agents`, its own `<section>` with a `.sec` header, after the
    Private Space and the workspaces): runs newest first from the records; the five newest, "Show N more" for the rest
    (up to the 200 records kept), "Show less"; collapsed by default and not remembered. A row is the task's first line;
    a run going or waiting for review says so in words with a dot. The current tab's run is marked (`aria-current`).
    Not shown without agents or before the first run.
19. **Several windows** (ADR-0019 rule 8). A window shows any run read-only from its record and transcript. It cannot
    cancel a run it does not run, and while other windows are open it does not reopen a run waiting for review (it may
    be theirs): the tab says to use the window that owns it. Alone on the Private Space, it may reopen such a run as
    before. A window that is not alone now also reads the history at start (it skipped recovery and so the list).
20. *(Replaced by the amendment "Conversations", decisions 21–27.)* **Follow-up questions** stayed out of scope (`--no-session-persistence` stays). "Ask again" returns to the bubble
    with the same task and context (an earlier run gives back its Private Space pages and files; workspace pages are
    picked again, since the record does not keep their server).

## Amendment: conversations (2026-10-26, Proposed)

The owner asked for sessions that can go on: after an answer, ask a follow-up in the same session. Decided for the owner
(to accept); this replaces decision 20.

21. **Thoth-side conversations, not CLI sessions.** A follow-up is a new one-shot run that belongs to the same
    conversation. The CLI flags and the host's allowlists do not change: no `--resume`, `--continue` or `--session-id`,
    `--no-session-persistence` and Codex's `--ephemeral` stay, nothing is added to `~/.claude` or Codex's history. A
    test checks that turn 2's argument list equals turn 1's and the shared fixture (`tests/agent/hub.test.ts`, on the
    Rust and the Node host). It works the same for both providers.
22. **The context of a follow-up.** The earlier turns of the conversation (each question and answer, oldest first) are
    quoted to the CLI in front of the new question (`fitConversation`, `packages/agent-core/src/conversation.ts`),
    ending with the line `--- End of earlier turns ---`; like the workspace framing and the selected-text excerpt they
    are sent, never kept. Earlier answers come from memory or the local transcripts (decision 15); a turn whose
    transcript was deleted is left out. The 20 000-character prompt limit holds for the quoted turns plus the new
    question: the newest turns that fit are sent, stopping at the first that does not (no gaps).
    - *Leave out what this turn is not given.* An answer can quote the pages its turn was given. So an earlier turn
      goes along only when this turn is given the same kind of material: Private Space pages if it had any, and pages
      of the same workspaces if it had workspace pages (checked against what was staged now, after the fresh
      `GET /workspaces` of decision 1). Otherwise it is left out and counted. This keeps a workspace page's text from
      reaching a turn that no longer has (or may no longer have) that workspace, or another provider.
23. **The run record** keeps only the person's own new question as its task, plus `conversation`: the conversation's
    id (the first turn's run id, a UUID), the turn number, and for a follow-up the counts `earlier`, `sent`, `deleted`
    and `notAllowed`. Counts only, never earlier text (a test reads the record on disk on both hosts). An older record
    without `conversation` is a one-turn conversation whose id is its own run id, so it can be continued too.
24. **Same context and settings as the turn before.** A follow-up uses the last turn's provider, model, Private Space
    pages or whole Private Space, workspace pages, time limit and budget: as this window started it, or from the record
    for a conversation from an earlier session (workspace pages then need picking again, since the record does not keep
    their server; the composer says so). Permissions are checked again at each send, and the hub stages each turn
    fresh, re-reading workspace pages with the person's access. "Change pages or settings…" puts the follow-up into the
    bubble's form ("Follow-up to “…”", with "Ask as a new task" to drop that), where the usual form applies. A turn
    that proposes changes is reviewed and applied like any run (decisions 5 and 8); while a turn runs or waits for
    review, the hub refuses the next question of that conversation, and so does the composer.
25. **UI.** The session tab is the conversation (tab target unchanged, its `run` is the conversation's id; any turn
    opens it): the first question as title, the facts, the turns top to bottom (heading "Question N", the question,
    for a follow-up how many earlier turns went with it, then the live progress or the answer, the review and the
    result), and a composer ("Ask a follow-up", Cmd/Ctrl+Enter sends). The composer's text stays editable; Send is
    disabled, with the reason in words, while a turn runs or waits for review or this window runs another task. The
    bubble's finished view gets "Ask a follow-up", which opens the session tab with the composer focused: the turns it
    follows are there, and one composer is easier to keep right than two (a compact composer in a 380-pixel bubble
    would also hide the earlier answers). The sidebar lists one row per conversation (first question, "N questions"
    from two on, the newest turn's state when it is going or waiting for review); the five-newest rule and "Show N
    more" stay. Notifications stay one per run, with their fixed text, and open the conversation's tab.
26. **Restore and history.** Conversations come back after a restart from the records (`conversation` id and turn) and
    the local transcripts. Retention and "Delete history now" remove answers as before; such a turn shows its question
    and that its details were deleted, and a later follow-up leaves it out.
27. **Several windows** (ADR-0019 rule 8). A conversation belongs to the window that started it (or continued it while
    alone on the Private Space). Another window shows it read-only and says to continue it in the window that owns it;
    a window alone on the Private Space (after a restart, or once the others closed) may continue any.

Not changed: review before apply, compare-and-swap, the host's argument allowlists, Permissions, the records' rule of
no page text and no agent output, local-only history.

## Decision for the Codex adapter (2026-10-25, proposed for the owner's review)

13. **Codex runs commands, inside Codex's own OS sandbox.** Verified against Codex CLI 0.164.0, its `--help`,
    `codex exec --help`, `--strict-config`, `codex sandbox`, `codex debug prompt-input`, the official docs and the CLI's
    source, then real runs (`packages/agent-codex/README.md` lists every flag and event with its source).
    - *The difference.* Claude Code runs without a shell (`--restricted`). Codex's main tool is the shell, and nothing
      takes it away. So Thoth does not remove the shell; it requires Codex's own OS sandbox (Seatbelt on macOS,
      bubblewrap and seccomp on Linux and WSL2, the native Windows sandbox) for every command and every file edit,
      with a permission profile Thoth defines: read only the platform's runtime paths (`:minimal`) and the working
      directory, write only the working directory, deny `/tmp` and `$TMPDIR`, no network. This is stricter than
      Codex's `workspace-write` mode, which can read the whole disk. Thoth still limits what Codex is given (the same
      staged copies, decision 1) and reviews every change (decision 8); the sandbox limits what its commands can do,
      not what Codex itself (which talks to OpenAI) can do.
    - *Command line.* `codex exec --json --color never --ephemeral --skip-git-repo-check --ignore-user-config
      --ignore-rules --strict-config` with `-c` overrides for the profile, `approval_policy=never` (nobody can answer;
      anything outside the sandbox fails), no automatic approval reviewer, no web search, no parent project root and
      no AGENTS.md from the working directory, no history, a core environment for commands, and no sub-agents,
      connectors, plugins, hooks, memories, image generation, browser or computer use; `-m` optional; the prompt on
      stdin. `--sandbox`, `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`, `--search`,
      profiles and any other override are refused by the host. The user's own `~/.codex/AGENTS.md` and skills are still
      read (they live in `CODEX_HOME` with the login); what a skill runs is sandboxed.
    - *Runs by its real path.* Codex re-runs its own binary inside the sandbox for file edits, and its sandbox allows
      that only for the path it was started as, so the host resolves symlinks before running it (a real run started
      through Homebrew's link could not edit with its own tool).
    - *No sandbox, no run.* Detection adds a probe, `codex sandbox` with the same profile running the CLI's own
      `--version`. Where it fails (no usable bubblewrap or user namespaces, a Windows sandbox that is not set up, a
      policy that forbids the profile), the state is `sandbox_unavailable`, the Agent Hub explains it with a fix, and
      Codex is not run, rather than run without its sandbox.
    - *Detection.* `codex --version` (at least 0.164.0, the version every setting was checked on), `codex exec
      --help` (every flag listed), `codex login status` (the CLI's own "Logged in" / "Not logged in"), the sandbox
      probe. Thoth never reads `~/.codex/auth.json` or the keychain. Install folders: `PATH`, Homebrew, `/usr/local/bin`,
      `~/.local/bin` and `$CODEX_INSTALL_DIR` (the standalone installer), npm's global folders, and on Windows
      `%APPDATA%\npm\codex.cmd` and `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`.
    - *No spending limit.* Codex has no budget flag or setting. The Agent Hub shows the field as not supported for
      Codex, the adapter has no `spending-limit` capability, and the hub refuses a task that names a budget for it.
      The time limit applies as for Claude Code. Records keep Codex's token counts instead of a cost.
    - *Unchanged.* Environment filtering, the process group (Job Object on Windows) and its kill, the time limit
      check, staging, review, apply, records and local history are the same code as for Claude Code. Windows was not
      tried on a real machine: the sandbox probe decides there.

## Consequences

- Positive: agents never touch live notes directly; a stale or concurrent edit is
  caught by the existing CAS rule.
- Positive: no credential handling surface in Thoth.
- Negative: copying context into a temp directory costs disk and time and means
  agents cannot see unselected linked pages.
- Negative: without OS sandboxing, an agent process still has the user's OS
  permissions; the temp directory limits intent, not capability.
- Negative: the argument policy exists twice (TypeScript builds, Rust checks); a shared fixture keeps them equal.
- Negative: the task text (and, for a workspace page, its title and workspace name) is stored in the vault's
  `.thoth/` folder, so it travels with the vault (sync, backup).
- Negative: transcripts and proposed files stay on the computer for the retention period, outside the vault, so a
  vault backup does not contain them and they are not protected by anything but the user account. Page text from
  a workspace is never among them (changes to reference copies are not kept), but the transcript can quote it.
- Negative: a workspace page given to an agent leaves the workspace's access control as soon as it is copied; the
  restriction check is the client's, on top of what the server enforces.
- Negative: a follow-up feeds earlier answers (agent output, untrusted) back to the CLI as input. They can steer the
  next turn like any prompt text; that turn is still restricted, staged and reviewed like any run. A selected-text
  excerpt is not recorded, so an earlier turn whose excerpt came from a workspace page (and whose answer may quote it)
  is judged only by the pages its record lists; the excerpt itself is never sent again.
- Negative: Codex's sandbox is Codex's own code and its permission profiles are marked beta; a change to them can
  break runs (`--strict-config` makes a renamed setting fail instead of being ignored) and the probe only shows that
  the sandbox starts, not every rule it enforces.
- Follow-up: detection of installation status with actionable messages (done for Claude Code and Codex);
  cleanup of temp directories after runs (done); audit of approvals (the run record); limits and local history
  (done, decisions 11 and 12).

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
- **Run records in the app data folder.** Rejected: the records describe the vault's pages and writes. (The
  transcript and proposed files, which are content, are the opposite case and do live there: decision 12.)
- **Letting the agent edit workspace pages and applying them through the workspace client.** Rejected by the owner
  for now: workspace content is read-only reference; a change to it is shown and discarded.
- **Clamping an out-of-range limit.** Rejected: a limit that was asked for but not applied is worse than an error.
- **Keeping the transcript in the vault's records.** Rejected: agent output can quote any page, and it must not be
  synced or backed up with the vault.

## Spec references

Section 2 (agent integration), 3.3, 4, 10, 12, 13 (P4), 14 (steps 9-10), 15
step 7.

## Future: OS-level sandbox

Decided 2026-10-25: not now. This is the plan, so the question is not lost.

**What already limits the agent.** Thoth runs Claude Code with `--restricted` (no shell, no code-running tools, no
WebFetch; file tools confined to the working directory), `--safe-mode`, no MCP servers and `dontAsk` permissions
(decision 2), and gives it copies, not the vault. Those are the CLI's own controls and Thoth checks that every flag is
present. They limit the CLI's tools, not the process: a bug in the CLI or a tool it still has runs with the user's
permissions.

**Claude Code's own sandbox first.** Its sandbox ([docs](https://code.claude.com/docs/en/sandboxing)) wraps only
shell commands (Bash, PowerShell, Monitor) and their children, with Seatbelt on macOS and bubblewrap on Linux and
WSL2; it does not cover the file tools, MCP servers or hooks, it is off by default, and native Windows has none.
With `--restricted` Thoth has no shell tool at all, so enabling that sandbox adds nothing today. It becomes relevant
only if a later phase gives the agent a shell, and then it should be switched on (and its flags added to the host
policy) before anything of Thoth's own is written. Re-check the docs and `--help` then; do not assume.

**Codex's own sandbox** is already required for Codex (decision 13): it covers that CLI's commands and edits. A Thoth
sandbox would add the same kind of boundary around the CLI process itself, for every provider.

**Plan (each step behind a setting, off until it has been tested on real machines):**

1. **macOS first**, behind an Agent Hub setting: run the CLI under `sandbox-exec` with a generated Seatbelt profile
   that allows reading the system and the CLI's install and config folders, writing only the run's working
   directory (and the CLI's own cache and config folders, which it needs for login and settings), and network only to
   the provider. `sandbox-exec` is deprecated but drives Seatbelt, the mechanism Claude Code's own sandbox uses; the alternative is the App Sandbox
   through a helper binary, which needs signing and an entitlement set per user.
2. **Linux:** bubblewrap (`bwrap`: new mount, PID and, where possible, network namespaces, a read-only bind of the
   system, a writable bind of the working directory) when it is installed, or Landlock (a kernel feature that
   restricts a process to listed paths, no helper binary, Linux 5.13 and later, network rules from 6.7) applied by a
   small launcher before `exec`. Landlock alone cannot hide paths, only deny them.
3. **Windows later:** a Job Object (kills the whole tree, also wanted for cancel) plus a restricted token or an
   AppContainer for the file and registry access. The most work and the least certain; WSL2 is Claude Code's own
   answer.

**Pros:** contains a bug or a tool the flags do not cover; protects the rest of the user's files and credentials from
a compromised or confused agent; makes "Thoth limits what it is given, not what it can do" less true. **Cons:** the
CLI needs its login (keychain or `~/.claude`) and the network, so the profile must allow both and cannot stop
exfiltration of what the agent reads; per-platform code and tests; profiles break when the CLI changes where it reads
or writes; sandbox-exec is deprecated; bubblewrap needs unprivileged user namespaces (disabled on some distributions);
a sandbox that fails open gives false confidence, so it must fail closed or say so on screen. Even then the working
directory is writable, so review before apply stays the control that matters.

## Open questions

- Whether a temporary git worktree is used instead of a plain temp directory when the vault is a git repository.
  Not for now (decision 1).
- ~~Exact capability detection mechanism per CLI.~~ Decided for Claude Code (decision 5) and Codex (decision 13).
- ~~Windows: cancel and the time limit cannot signal a process group yet.~~ Decided 2026-10-25: each run is a
  kill-on-close Job Object; cancel and the time limit terminate the job at once (no SIGTERM first), see ADR-0008
  "Windows file layer".
- Workspace pages beyond single pages (a folder page does not bring its children; each page is picked on its own),
  and workspace attachments, which are not copied.
- Whether the OS-level sandbox should become a default once it exists (see "Future: OS-level sandbox").
