# ADR-0040: A local log, and problem reports with it

- **Status:** Proposed
- **Date:** 2026-10-30
- **Deciders:** owner (the aim and the privacy rules); implementation agent (the rest, marked "(this ADR)")
- **Extends:** ADR-0033 (feedback). **Refines:** ADR-0007 rule 7 and ADR-0015 (nothing leaves the device without the
  person choosing it), ADR-0008 (no network in the webview).

## Context

"Send feedback" (ADR-0033) tells the owner what a person typed, but not what the app was doing when it failed. A
problem report that says "it broke when I saved" is hard to act on, and the desktop app keeps no record of its own
errors. Thoth's rules stay as they were: no page text, titles, file names or paths leave the device, the desktop app
contacts no server the person has not added (ADR-0014), and the webview has no network (ADR-0008). A crash-reporting
service would break all three at once.

## Decision

1. **A small local log.** The desktop shell writes one file, `thoth.log`, in the operating system's log folder:
   `max_file_size` 1 000 000 bytes and `RotationStrategy::KeepSome(2)`, so about 3 MB on disk at most. Times are UTC,
   the level is `Info`, and `tao`, `wry`, `reqwest`, `hyper`, `hyper_util`, `rustls`, `tauri`, `tauri_runtime_wry` and
   `tauri_plugin_updater` log at `Warn` only. Nothing is sent anywhere by writing it.
2. **The logger is attached in `setup`, not registered as a plugin** (this ADR). `attach_log` builds the
   `tauri-plugin-log` builder, calls `split()` and installs the logger with `attach_logger`, and drops the plugin value.
   Two things follow. A log that cannot be opened (a folder that is not writable) returns `false` and the app starts
   without one, which a registered plugin would not allow. And the plugin is never registered, so the webview has no
   `log` command, and `capabilities/main.json` grants no `log:` permission (its description says the plugin is used from
   the host only). The cost is that records made before `setup` (Tauri's own start-up) are not in the log.
3. **Every line is redacted before it is written** (`thoth_host::diagnostics::redact`, called by the formatter, so it
   covers records from Thoth and from other crates). `redact`, in this order of intent:
   - turns control characters into spaces;
   - keeps a URL's scheme, host and port and replaces the rest with `<redacted>`, with any user info, so a share or
     invite link's secret in its path is gone (`https://api.thothnotes.com/s/AbC123xyz?x=1` becomes
     `https://api.thothnotes.com/<redacted>`);
   - replaces the value after a secret key (`bearer`, `token`, `secret`, `password`, `passwd`, `authorization`,
     `cookie`, `api_key`, `apikey`, any case, `-` read as `_`, also inside a longer name such as `refresh_token`);
     `Authorization` and `Cookie` run to the end of the line;
   - replaces a path with `<path>`: a word holding a `/` or `\` that starts with one or holds a letter (`/Users/a`,
     `~/x`, `Notes/x.md`, `C:\x`; not `3/5`). The path runs over the spaces and apostrophes of a file name, to a `: `,
     a closing quote or bracket, or the line's end, so `failed to open /Users/a/My Notes/Secret plan.md: denied` leaves nothing of
     the name. Kept: a `.rs:N` location under a `src/` folder, which a panic line needs, and `HTTP/1.1`;
   - replaces an email address with `<email>`, and a run of 32 or more `[A-Za-z0-9+/=_-]` characters with `<redacted>`;
   - clips the result to **500 characters**, counting the `…` of a clipped line, at a character boundary (Thai and
     emoji are safe).
4. **The limit of redaction, stated plainly** (this ADR). `redact` is a safety net. It cannot know that a bare word
   such as `Secret plan.md` (no `/` in it) or a sentence someone typed is private. So the rule for callers is that they
   log **codes, not text**: a failing host command logs its `command` and `code`, never its message; a webview error
   report is bounded in what it carries (rule 7); no code path logs a page, a title, a file name or a search word.
   Over-redacting is the intended failure.
5. **The 500-character bound is on the message.** The line on disk also has a timestamp, the level and the target,
   about 60 characters more. `tail` redacts again and clips each line to 500 characters, so what a report carries is
   never longer.
6. **A panic is logged** as `at file:line:col: payload` (target `panic`), then passed to the previous hook. The
   location comes first because `redact` takes a path to the end of the line, so a path inside the payload would
   otherwise swallow the location.
7. **The webview's uncaught errors reach the log through `diag.report`**, bounded at **20 per window load** (in the
   webview) and **50 per app run** (in the host, which drops the rest), and a stack is cut to its first **5 lines**.
   A script that throws on every frame cannot fill the log.
8. **Two host commands**, `diag.report` and `diag.collect`, added to every contract list: `thoth_host::COMMANDS`,
   `build.rs` `TAURI_COMMANDS`, `capabilities/main.json` (`allow-diag-report`, `allow-diag-collect`) and
   `packages/platform/src/ipc.ts`. `diag.collect` returns `{ version, os, arch, log }`, where `log` is the newest
   **200 lines** and at most **64 KB** of the log, redacted again. With no log yet (a fresh install, no log folder, the
   end-to-end bridge, which has no logger) `log` is `[]`, not an error.
9. **The report dialog** (the one of ADR-0033, `FeedbackDialog.tsx`; the desktop app only). A box, "Include recent app
   log", **off on every open**. Ticking it reads the log and shows every line that will be sent; while it loads, Send
   waits, and a failed read can be retried by unticking and ticking again. Loading, failure and "No log yet" are
   announced to screen readers. The web client has no such box. The desktop app also adds `arch` (the processor type,
   such as `aarch64`) to the context that "Include the app version and system" already sends, shown on screen like
   the other values.
10. **Save diagnostics…** (Settings, "Help and feedback"): saves the same redacted log as `thoth-diagnostics.md`
    through the host's save dialog, for a person who would rather attach it to an email than send it. The file says
    "No log yet" when there is none, and its fence is longer than any backtick run in the log.
11. **The protocol grows by two optional members of the request body**, both strict: `context.arch` (1 to 20
    printable characters) and `diagnostics` `{ log }`, 1 to 200 lines of 1 to 500 printable characters. The same
    schema is in `protocol/openapi.yaml` and `protocol/schemas`. A server without the `feedback` capability is
    unchanged, and the capability name is the same.
12. **Server storage:** migration `014_feedback_diagnostics.sql` adds one nullable `diagnostics jsonb` column. It is
    additive, so an older build running against the migrated database keeps working; production applies it by hand
    (`MIGRATE_ON_START=false`) before deploying a build that stores it. `feedback list` and `feedback export --json`
    show it, with control characters escaped like the message.
13. **An older server answers 400 to `diagnostics`**, because ADR-0033's body is strict and refuses unknown members.
    Self-hosters lag releases. The dialog does not retry on its own: when a send that included the log fails with a
    400, it says "This server doesn't accept the app log yet. Untick “Include recent app log” and send again." and the
    person decides.
14. **No new network path.** The log goes nowhere unless the person ticks the box and sends, and then only to the
    server ADR-0033 rule 9 picks, through the host (`api.call`). The webview still has no network.
15. **One new crate, and what it brings** (this ADR). `tauri-plugin-log = "=2.10.0"`, an exact pin of a release from
    2026-09-26, at least three weeks old (2.10.1 was 20 days old). It brings `fern`, and `num_threads` transitively
    (the plugin's required time and local-offset support). No other new crate and no new npm package. The Cargo.toml
    comment names these.
16. **Strings:** every English string has a Thai one, marked `// REVIEW` like the other unreviewed Thai strings.

## Consequences

- Positive: a problem report can say what happened, without anything private in it, and the person sees every line
  first. A crash leaves a line with its source location. The log's size is bounded on disk and in every report.
- Positive: the log is written by the host, so a webview bug or a dependency cannot read or enlarge it.
- Negative: a person's own words in a message are not redacted for them, since the message is theirs and shown in the
  form. The log is only as private as its callers are careful (rule 4). A future change that logs a name, a title or
  a search word is a privacy bug that no test of `redact` will catch, so reviews of new `log::` calls matter.
- Negative: `redact` takes most words with a slash to be a path, so a line can lose useful words (a `km/h`). The log is a little less readable; nothing leaks.
- Negative: start-up records before `setup` are not logged (rule 2).
- Negative: self-hosters on an older server must untick the box (rule 13), and their server stores nothing new until
  it is upgraded and migrated.
- The privacy notice (`docs/legal/privacy.md`, `privacy.th.md`) gains a sentence on the log and a row for feedback.
  The website's copy lives in the private site repository (ADR-0039): its `upstream/` copy and the test that pins
  the date must be updated at release.

## Alternatives considered

- **Sentry, or another crash-reporting service.** Considered and not chosen. It is a third party, so it would need
  the privacy notice, a processor agreement and a consent step, and it would send from the person's computer to a
  server they never added, against ADR-0014. A crash dump or a breadcrumb can hold typed text, page text or file
  names, which the rules above rule out and which no filter can promise to remove from a native dump.
- **Registering the log plugin the usual way.** It exposes a `log` command to the webview (or needs care to keep it
  off), and a log folder that cannot be opened stops the app from starting. `split()` and `attach_logger` avoid both.
- **A log with no redaction, trusting callers.** One careless `log::warn!("{err}")` with a path in it would leave the
  computer in a report. The formatter is the one place every record passes, so the net is there.
- **Sending the log with every report, or in the background.** The log leaves only when the person ticks the box and
  has seen it.
- **Retrying without `diagnostics` on a 400** (an earlier plan). It would hide from the person that the log was not
  sent, and it needs a second code path. One extra click on an older server is the smaller cost.

## Measurements

Filled in before release: see Task 8 of the plan.

## Spec references

Section 8 (protocol endpoints, extended), section 10 (server), ADR-0004 (capabilities), ADR-0007 rule 7 and ADR-0015
(nothing leaves the device unchosen), ADR-0008 (no network in the webview), ADR-0014 (servers are contacted only when
added), ADR-0033 (feedback), ADR-0039 (the private site repository). Plan:
`docs/superpowers/plans/2026-10-30-bug-reporting-0-3-0.md`.

## Open questions

- How long the server keeps `diagnostics` (and feedback in general, ADR-0033). There is no limit yet, and the privacy
  notice cannot name one until the owner decides.
- Whether to add a Settings switch that turns the local log off. Today it is always on, small and local.
