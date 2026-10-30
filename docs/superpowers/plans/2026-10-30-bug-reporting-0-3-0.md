# Privacy-first bug reporting (0.3.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app keeps a small, redacted local log of errors and app events, and a person reporting a
problem can look at that log and choose to attach it to the feedback they already send to their own Thoth server.
They can also save it to a file. No third party gets anything.

**Architecture:**
- **Logging:** `tauri-plugin-log` writes one size-capped, rotating file in the app's log folder. Every line goes
  through one Rust redaction function before it reaches disk.
- **Webview errors:** reported to the host through a rate-limited host command. The webview gets no plugin permission.
- **Reporting:** "Report a Problem" is the existing Send feedback dialog (ADR-0033) with an opt-in "Include recent
  app log" box that shows the exact lines first. The feedback body gains a bounded `diagnostics` field and the
  server stores it in a new column.

**Tech Stack:** Tauri 2.12 + `tauri-plugin-log` (Rust), React 19, zod (protocol), Node server with PostgreSQL,
Vitest, cargo test, Playwright.

**Spec:**
- The owner's brief and the 2026-10-27 decision in thread "Handoff from earlier MCP thread": "the smallest you
  suggest": local logs plus Report a Problem; **no Sentry, no third party**; release as **0.3.0**.
- ADR-0033 (feedback), which this extends.
- The privacy notice `docs/legal/privacy.md` lines 30–32: "the desktop app sends nothing anywhere unless you connect
  it to a server, and it has no analytics". This plan keeps that promise as written.

## Global Constraints

- **No new network path.** The log never leaves the computer unless the person ticks the box and sends, and then
  only to their own feedback server.
- **Never logged or sent:** page text, titles, file or folder names, paths, search words, emails, tokens,
  credentials or share-link secrets. Host-command failures log `command` and `code` only, never the message.
- **New crate:** `tauri-plugin-log = "=2.10.0"`, an exact pin of a release at least three weeks old (2.10.0 is from
  2026-09-26; 2.10.1 is only 20 days old). Add it in the root `Cargo.toml` with the house-style comment. It brings
  in `fern`; no other new crates. No new npm packages.
- **Webview permissions:** the webview gets **no `log:` permission**. `apps/desktop/src-tauri/capabilities/main.json`
  keeps "no fs, shell, http, opener or window plugins", reworded to say the log plugin is used from the host only.
- **Local log limits:** one file `thoth.log`, `max_file_size` 1 000 000 bytes, `RotationStrategy::KeepSome(2)` (at
  most about 3 MB on disk), UTC times, level `Info`.
- **Third-party crates** (`tao`, `wry`, `reqwest`, `hyper`, `rustls`, `tauri`) log at `Warn` only.
- **Bounds:**
  - a log line is at most **500 characters**, clipped at a character boundary;
  - an attached or exported log is the newest **200 lines**, at most **64 KB**;
  - webview error reports: at most **20 per window load** and **50 per app run**;
  - a webview error's stack is cut to its first **5 lines**.
- **"Include recent app log" is off by default** on every open of the dialog.
- **Commands:** new host commands are `diag.report` and `diag.collect`. Each is added to every contract list:
  `thoth_host::COMMANDS`, `build.rs` `TAURI_COMMANDS`, `capabilities/main.json` (`allow-diag-report`,
  `allow-diag-collect`) and `packages/platform/src/ipc.ts`.
- **Strings:** every English string gets a Thai one, marked `// REVIEW` like the existing unreviewed Thai strings.
- **Commits:** `git commit -s`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The ADR change
  goes in the same branch (CONTRIBUTING.md).

## Review Focus

1. **A path with spaces inside an error message**, e.g. `failed to open /Users/a/My Notes/Secret plan.md: denied`.
   It must come out as `failed to open <path>: denied`, with no part of the name left. Test in Task 1.
2. **A share or invite link with its secret in the path**, e.g. `https://api.thothnotes.com/s/AbC123xyz?x=1`. It
   keeps only scheme and host: `https://api.thothnotes.com/<redacted>`. Test in Task 1.
3. **A webview error thrown on every frame.** At most 20 reach the host per window load, and the host keeps at most
   50 per run, so the log stays within its cap. Tests in Tasks 2 and 4.
4. **No log yet** (fresh install, log folder missing, or the e2e bridge with no logger). `diag.collect` returns
   `log: []`, and the dialog shows "No log yet" instead of failing. Tests in Tasks 2 and 6.
5. **Thai or emoji text at the 500-character limit.** It is clipped on a character boundary, with no panic and no
   broken UTF-8. Test in Task 1.

---

### Task 0: Baseline measurements (before any change)

**Files:**
- Create: `scripts/measure-desktop.sh`
- Create: `crates/thoth-host/tests/save_latency.rs`

**Interfaces:**
- **Produces:** `scripts/measure-desktop.sh <path to Thoth.app>`, which prints one line per metric in the form
  `name value unit`. Task 8 runs the same script and test again.

- [ ] **Step 1: Write `save_latency.rs`.** It is an `#[ignore]` test, `save_latency_median`. It builds a `Host` the
  way `tests/file_save.rs` does, opens a temp vault and calls `fs.write` 1000 times with 20 KB of bytes. It prints
  the median and p95 in microseconds and asserts only that every call succeeded.
- [ ] **Step 2: Write `measure-desktop.sh` (macOS only).**
  - **Size:** `du -sk` of the `.app` and of the `.dmg`.
  - **Cold start:** 5 runs. Each run launches `Contents/MacOS/Thoth` and times until
    `osascript -e 'tell application "System Events" to exists window 1 of process "Thoth"'` is true; the script
    prints the median.
  - **Idle use:** after 30 s idle, 10 `ps -o %cpu=,rss=` samples 1 s apart; the script prints the medians of CPU %
    and RSS in MB.
  - The script then quits the app.
- [ ] **Step 3: Run the baseline.**
  - Build on `main` with `pnpm --filter @thoth/desktop tauri build`.
  - Run `scripts/measure-desktop.sh apps/desktop/src-tauri/target/release/bundle/macos/Thoth.app` and
    `cargo test --release -p thoth-host --test save_latency -- --ignored --nocapture`.
  - Save both outputs to `.tmp/measure/baseline.txt` (not committed).
  - Expected: every metric printed and the test passes.
- [ ] **Step 4: Commit** the script and the test: `chore: desktop size, start, idle and save measurements`.

### Task 1: Redaction and the log reader (`thoth-host`)

**Files:**
- Create: `crates/thoth-host/src/diagnostics.rs` (declared `pub mod diagnostics;` in `crates/thoth-host/src/lib.rs`)
- Test: unit tests in the same file (the house pattern of `mcp/log.rs`)

**Interfaces:**
- **Produces:**
  - `pub fn redact(line: &str) -> String`: one output line, with no control characters, at most `MAX_LINE_CHARS`.
  - `pub fn tail(dir: &Path, max_lines: usize, max_bytes: usize) -> Vec<String>`: the newest lines, oldest first.
    It reads `thoth.log` plus its rotated siblings, and runs `redact` on each line again.
  - `pub const MAX_LINE_CHARS: usize = 500; pub const TAIL_LINES: usize = 200; pub const TAIL_BYTES: usize = 64 * 1024;`

- [ ] **Step 1: Write the failing tests:**
  - `redacts_unix_path_with_spaces`: `failed to open /Users/a/My Notes/Secret plan.md: denied` →
    `failed to open <path>: denied`.
  - `redacts_windows_and_unc_paths`: `C:\Users\a\Notes\x.md` → `<path>`; `\\srv\share\x.md` → `<path>`.
  - `redacts_home_tilde`: `~/Notes/x.md` → `<path>`.
  - `keeps_only_url_host`: `https://api.thothnotes.com/s/AbC123xyz?x=1` → `https://api.thothnotes.com/<redacted>`;
    `https://thothnotes.com` stays as it is.
  - `redacts_email`: `mail a.b@c.co now` → `mail <email> now`.
  - `redacts_secrets_after_keys`: `Bearer abc.def`, `token=abc`, `password: x`, `Authorization: abc` → the value
    becomes `<redacted>`, matched case-insensitively.
  - `redacts_long_opaque_runs`: a run of 32 or more `[A-Za-z0-9+/=_-]` characters → `<redacted>`.
  - `flattens_and_clips_on_char_boundary`: control characters and newlines become spaces. 600 Thai characters plus
    an emoji are clipped to `MAX_LINE_CHARS` chars, ending in `…`, and stay valid UTF-8.
  - `tail_reads_rotated_files_newest_last`: two rotated files and the current one hold 300 lines in total. The result
    is the last 200, in order. Lines are kept whole when the 64 KB budget cuts in.
  - `tail_of_missing_dir_is_empty`.
  - `tail_skips_blank_lines`: the protocol refuses empty log lines (`shortText` has `min(1)`).
- [ ] **Step 2: Run** `cargo test -p thoth-host diagnostics` → FAIL (module missing).
- [ ] **Step 3: Implement.**
  - `redact` is a single left-to-right scan, with no regex crate.
  - A path starts at `/` (after whitespace, `(` or `"`), at `~/`, at `X:\` or at `\\`. It runs until a quote, a
    `)`, the string `": "` or the end of the line.
  - URLs: keep `scheme://host[:port]`, then `/<redacted>` if anything follows.
  - The key list is `bearer`, `token`, `secret`, `password`, `passwd`, `authorization`, `cookie`, `api_key`,
    `apikey`.
  - `tail`: sort the files `thoth*.log` by modified time, read from the end, stop at whichever limit comes first.
- [ ] **Step 4: Run** `cargo test -p thoth-host diagnostics` → PASS.
- [ ] **Step 5: Commit:** `feat(host): redaction and a bounded log reader for diagnostics`.

### Task 2: Host commands `diag.report` and `diag.collect`

**Files:**
- Modify:
  - `crates/thoth-host/src/lib.rs`: `COMMANDS`, the `call_as` match, and a new `pub fn with_log_dir(self, dir: Option<PathBuf>) -> Self` next to `with_updates` (line 211)
  - `apps/desktop/src-tauri/build.rs` (`TAURI_COMMANDS`)
  - `apps/desktop/src-tauri/capabilities/main.json`
  - `packages/platform/src/ipc.ts`
- Test: `crates/thoth-host/tests/diagnostics.rs`

**Interfaces:**
- **Consumes:** `diagnostics::{redact, tail, TAIL_LINES, TAIL_BYTES}`.
- **Produces:**
  - `"diag.report": { args: { kind: "error" | "rejection"; message: string; stack?: string }; result: null }`. It
    logs `log::error!(target: "webview", ...)` with the message and the first 5 stack lines. The host keeps at most
    50 per run (an `AtomicUsize`); after that it accepts calls but logs nothing.
  - `"diag.collect": { args: Record<string, never>; result: DiagnosticsBundle }`, with
    `DiagnosticsBundle = { version: string; os: string; arch: string; log: string[] }`.
    - `os` and `arch` come from `std::env::consts`.
    - `version` comes from the update options' current version, or `""`.
    - `log` is `tail(log_dir, TAIL_LINES, TAIL_BYTES)`, or `[]` when there is no log folder.

- [ ] **Step 1: Write the failing tests:**
  - `collect_without_log_dir_is_empty`: the `log` array is `[]`, and `arch` equals `std::env::consts::ARCH`.
  - `collect_reads_and_redacts`: write a `thoth.log` holding a path in a temp dir, set it with `with_log_dir`, and
    the result has `<path>` in it.
  - `report_refuses_bad_kind`: `kind: "x"` → `bad_argument`.
  - `report_caps_at_50`: 60 calls all return Ok. A test logger (a `log::Log` implementation counting records with
    target `webview`) sees 50.
  - The existing command-list tests in `apps/desktop/src-tauri/src/lib.rs` (around :835–:978) must still pass with
    the new names.
- [ ] **Step 2: Run** `cargo test -p thoth-host --test diagnostics` → FAIL.
- [ ] **Step 3: Implement** the two match arms and `with_log_dir`, and add the names to the four lists. `log` is
  already in the lock file; add `log = "0.4"` to `crates/thoth-host/Cargo.toml` (an existing version, no new crate).
- [ ] **Step 4: Run** `cargo test -p thoth-host` and `cargo test -p thoth-desktop` → PASS.
- [ ] **Step 5: Commit:** `feat(host): diag.report and diag.collect`.

### Task 3: The log in the desktop shell

**Files:**
- Modify:
  - `Cargo.toml` (root, the pin)
  - `apps/desktop/src-tauri/Cargo.toml`
  - `apps/desktop/src-tauri/src/lib.rs`: `run()` at :712, `handle()` at :548, and `.with_log_dir(app.path().app_log_dir().ok())` on the `Host`
  - `apps/desktop/src-tauri/capabilities/main.json` (description text only)
- Test: unit tests in `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- **Consumes:** `thoth_host::diagnostics::redact`.
- **Produces:**
  - `fn log_line(level: log::Level, target: &str, message: &str) -> String`, which returns
    `"{LEVEL} {target}: {redact(message)}"`. The plugin adds the time.
  - `fn install_panic_hook()`.

- [ ] **Step 1: Write the failing tests:**
  - `log_line_redacts`: `log_line(Error, "webview", "at /Users/a/x.md")` == `"ERROR webview: at <path>"`.
  - `panic_hook_logs_location_not_payload_paths`: install the hook, then run `std::panic::catch_unwind` around
    `panic!("bad /Users/a/x.md")`. The test logger sees one `error` record holding `<path>` and the file:line, and the
    previous hook still ran.
- [ ] **Step 2: Run** `cargo test -p thoth-desktop log_line panic_hook` → FAIL.
- [ ] **Step 3: Register the plugin first in `run()`.**
  - Use `tauri_plugin_log::Builder::new()`.
  - Call `.clear_targets().target(Target::new(TargetKind::LogDir { file_name: Some("thoth".into()) }))`.
  - Then call `.max_file_size(1_000_000)`, `.rotation_strategy(RotationStrategy::KeepSome(2))`,
    `.timezone_strategy(TimezoneStrategy::UseUtc)` and `.level(LevelFilter::Info)`.
  - Add `.level_for(...)` at `Warn` for each crate in the Global Constraints.
  - Set `.format(|out, msg, rec| out.finish(format_args!("{}", log_line(rec.level(), rec.target(), &msg.to_string()))))`.
- [ ] **Step 4: Add the rest of the logging.**
  - In `setup`, call `install_panic_hook()` and log one line: `info!("start {version} {os} {arch}")`.
  - In `handle()`, when `reply` is `Err(error)`, log
    `log::warn!(target: "host", "{command} failed: {}", error.code)`. Log the code only.
  - Log nothing else. Successful calls are never logged.
- [ ] **Step 5: Run** `cargo test -p thoth-desktop`, then `pnpm --filter @thoth/desktop tauri dev`. Open a Private
  Space and `~/Library/Logs/<identifier>/thoth.log` has the start line, and no path in it.
- [ ] **Step 6: Commit:** `feat(desktop): a small redacted local log, and panics in it`.

### Task 4: Platform API and webview error reporting

**Files:**
- Modify:
  - `packages/platform/src/index.ts`: `readonly diagnostics?: Diagnostics` on `Platform`, plus the interface
  - `packages/platform/src/remote.ts`: `remoteDiagnostics(transport)`, wired in `createRemotePlatform`
  - `packages/platform/src/http.ts`: wired the same way
  - `apps/desktop/src/main.tsx`
- Create: `apps/desktop/src/platform/errors.ts`
- Test: `apps/desktop/test/errors.test.ts`

**Interfaces:**
- **Produces:**
  - `interface Diagnostics { report(e: { kind: "error" | "rejection"; message: string; stack?: string }): Promise<void>; collect(): Promise<DiagnosticsBundle> }`. `DiagnosticsBundle` is exported from `ipc.ts`.
  - `createErrorReporter(send: Diagnostics["report"], limit = 20): (event: ErrorEvent | PromiseRejectionEvent) => void`.
    It drops an exact repeat of the last message, stops after `limit`, and never throws, even when `send` rejects.

- [ ] **Step 1: Write the failing tests:**
  - `reports_error_event_message_and_stack`.
  - `reports_rejection_reason_string_and_error`.
  - `stops_after_limit`: 25 distinct events → 20 sends.
  - `drops_repeats`.
  - `send_failure_is_swallowed`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/test/errors.test.ts` → FAIL.
- [ ] **Step 3: Implement `errors.ts`.** In `main.tsx`, once the platform is selected and only if
  `platform.diagnostics` is present, register the reporter for `error` and `unhandledrejection`.
- [ ] **Step 4: Run** the test → PASS, then `pnpm typecheck`.
- [ ] **Step 5: Commit:** `feat(desktop): report uncaught webview errors to the local log`.

### Task 5: Protocol, server storage and CLI

**Files:**
- Modify:
  - `packages/workspace-protocol/src/feedback.ts`
  - `docs/protocol/README.md` (:100 and :606)
  - `apps/server/src/routes/feedback.ts` (JSON path only; the website form never sends diagnostics)
  - `apps/server/src/feedback.ts` (`storeFeedback`, `listFeedback`, `FeedbackRow`)
  - `apps/server/src/cli.ts` (`formatFeedback`, :178)
  - `protocol/conformance/src/checks-feedback.ts`
  - `apps/server/test-db/migrate.test.ts` (:27, :31, :37: the file list and the count become 14)
- Create: `apps/server/migrations/014_feedback_diagnostics.sql`
- Regenerate: `pnpm schemas && pnpm openapi`
- Test: `apps/server/test-db/feedback.test.ts`, `apps/server/test-db/cli.test.ts`, `tests/protocol/schemas.test.ts`

**Interfaces:**
- **Produces:**
  - `FeedbackContextSchema` gains `arch: shortText(20).optional()`.
  - `FeedbackDiagnosticsSchema = z.strictObject({ log: z.array(shortText(500)).min(1).max(200) })`.
  - `FeedbackRequestSchema` gains `diagnostics: FeedbackDiagnosticsSchema.optional()`.
  - `FEEDBACK_LOG_LINES = 200`.
- **Migration:**
  `ALTER TABLE feedback ADD COLUMN diagnostics jsonb NULL CHECK (diagnostics IS NULL OR jsonb_typeof(diagnostics) = 'object');`

- [ ] **Step 1: Write the failing tests:**
  - `stores_diagnostics_when_sent`: a POST with `diagnostics.log` of 3 lines → the row's `diagnostics` equals the
    body's.
  - `refuses_201_log_lines`: → 400.
  - `refuses_control_characters_in_a_log_line`: → 400.
  - `refuses_unknown_member_in_diagnostics`: → 400.
  - `site_form_ignores_diagnostics_field`: a form post carrying `diagnostics=...` is stored with `diagnostics` null.
  - CLI `list` prints `log: 3 lines`. `export --json` includes the lines, run through `printable()`.
  - Conformance: add a refusal check `feedback.diagnostics.too_long` (201 lines → 400). Like the other checks, it
    never stores anything.
- [ ] **Step 2: Run** `pnpm test:server -- feedback cli migrate` → FAIL.
- [ ] **Step 3: Implement** the schema, migration, store, list and CLI changes, then regenerate the schemas and
  OpenAPI. The route's description in `routes.ts:601-611` lists the new field.
- [ ] **Step 4: Run** `pnpm test:server` and `pnpm vitest run tests/protocol` → PASS.
- [ ] **Step 5: Commit:** `feat(feedback): an optional, bounded app log with a problem report`.

### Task 6: Report a Problem in the dialog, and Save diagnostics

**Files:**
- Modify:
  - `packages/app-ui/src/feedback/FeedbackDialog.tsx`
  - `packages/app-ui/src/strings/en.ts` and `th.ts`: `feedback.*`, around :877–909
  - `apps/desktop/src/features/feedback/Feedback.tsx`
  - `apps/desktop/src/strings/en.ts` and `th.ts`: `helpFeedback.*`
- Test: `packages/app-ui/test/feedback.test.tsx`, `apps/desktop/test/feedback.test.tsx`,
  `tests/e2e/feedback.e2e.ts`

**Interfaces:**
- **Consumes:** `platform.diagnostics?.collect()` and `platform.saveFile?(name, bytes)`.
- **Produces:**
  - New prop `FeedbackDialogProps.diagnostics?: () => Promise<string[]>`. When it is absent (web), nothing changes.
  - The desktop context adds `arch` from `collect()`.
  - The Settings button "Save diagnostics…" saves `thoth-diagnostics.md`. It is Markdown: a header (version, OS,
    arch, date) and the log lines in a fenced block. It uses `saveFile`, whose `.md` cleaning fits.

- [ ] **Step 1: Write the failing tests:**
  - `log_box_absent_without_diagnostics_prop`.
  - `log_box_off_by_default_and_nothing_sent`: send with the box untouched → the request has no `diagnostics`.
  - `ticking_shows_exact_lines_then_sends_them`: the preview `<pre>` text equals the lines joined by newlines, and the
    request body's `diagnostics.log` equals the same array.
  - `empty_log_shows_no_log_yet_and_sends_nothing`.
  - `collect_failure_shows_message_and_still_sends_feedback`.
  - Desktop: `save_diagnostics_writes_markdown`: the fake `saveFile` receives `thoth-diagnostics.md` and bytes
    containing a fenced block holding the lines.
  - e2e: the bridge has no log, so ticking the box shows "No log yet", and the feedback still sends.
- [ ] **Step 2: Run** `pnpm vitest run packages/app-ui/test/feedback.test.tsx apps/desktop/test/feedback.test.tsx` →
  FAIL.
- [ ] **Step 3: Implement.**
  - **Checkbox:** "Include recent app log", the same pattern as `include` at :239–252. Ticking loads the lines once.
    The preview is a focusable, scrollable `<pre>`, labelled by its hint "This is everything that will be sent.
    Page text, titles and file paths are removed."
  - **Strings:** all new ones in English and Thai (`// REVIEW`).
  - **Privacy note:** the dialog's `t.privacy` gains "…and, if you include it, the app log shown above."
- [ ] **Step 4: Run** the tests, then `pnpm e2e -- feedback` → PASS.
- [ ] **Step 5: Commit:** `feat(feedback): Report a Problem with a log you see first, and Save diagnostics`.

### Task 7: ADR, privacy notice, protocol docs and changelog

**Files:**
- Create: `docs/adr/0040-local-log-and-problem-reports.md`
- Modify:
  - `docs/adr/README.md` (a row for 0040)
  - `docs/legal/privacy.md` and `privacy.th.md`
  - `CHANGELOG.md` and `CHANGELOG.th.md` (`## [Unreleased]`)

- [ ] **Step 1: ADR-0040**, Status "Proposed", extending ADR-0033. It records:
  - the decisions and bounds in the Global Constraints;
  - **Sentry was considered and not chosen:** third party, privacy notice; crash dumps could hold typed text;
  - a **Measurements** section, filled in by Task 8;
  - **Open questions:**
    - how long the server keeps `diagnostics`;
    - whether to add a Settings switch that turns the local log off.
- [ ] **Step 2: Privacy notice, English and Thai.**
  - **Lines 30–32:** the promise stays, plus one sentence: "It keeps a small log on your computer (errors and app
    events, never page text, titles or file paths; about 3 MB at most). The log is sent only if you include it in a
    problem report, after you have seen it."
  - **Data table:** a feedback row (what is sent, to whose server).
  - **Date:** update "last updated". Note that the site test pins that date, in the site repo (`upstream/`).
- [ ] **Step 3: Changelog, English and Thai,** with the same number of entries in each:
  - **Added:** Report a Problem with the app log, and Save diagnostics.
  - **Changed:** feedback can include the processor type.
- [ ] **Step 4: Run** `pnpm check` → PASS (the changelog parity test included).
- [ ] **Step 5: Commit:** `docs: ADR-0040, privacy notice and changelog for problem reports`.

### Task 8: Final measurements and full check

- [ ] **Step 1: Measure.** Build the release `.app` from the branch, then run `scripts/measure-desktop.sh` and the
  `save_latency` test exactly as in Task 0. Save the output as `.tmp/measure/final.txt`.
- [ ] **Step 2: Fill in ADR-0040 → Measurements.** Write a table: metric, baseline median, final median, difference.
  State that it was measured on one Mac only, with the machine model.
  - If cold start or save latency is worse by more than 5% or 20 ms, or the `.dmg` grows by more than 300 KB, find
    the cause before going on. The likely suspect is the plugin's file open at start.
- [ ] **Step 3: Run** `pnpm check`, `pnpm test:server`, `cargo test --workspace` and `pnpm e2e` → all PASS.
- [ ] **Step 4: Commit:** `docs(adr-0040): baseline and final measurements`.
- [ ] **Step 5: Stop for the owner.** The release (version 0.3.0, the post, tags) follows `docs/deploy/release.md`
  once the owner says so.
