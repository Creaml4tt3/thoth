# ADR-0022: Update notice

- **Status:** Proposed
- **Date:** 2026-10-26
- **Deciders:** project owner (the request); rules 1 to 5 were decided by the orchestrator for the owner. The details
  marked "(this ADR)" were decided while implementing them.
- **Refines:** ADR-0008 (the webview has no network; the host makes every request), ADR-0018 (notifications: a new
  kind), ADR-0020 (the host's fetch rules are reused).

## Context

The desktop app is installed by hand from the website (`docs/deploy/release.md`: R2 behind
`https://download.thoth.creaml4tt3.me/`, `latest.json` at the root naming the newest release, one `v<version>/` folder
per release). Nothing tells a person that a newer version exists.

Constraints:

- The builds are not signed with a Developer ID (release.md, "Signing (not yet)"). An in-app updater needs its own
  signing keys and would install code, which is a much larger trust decision than telling people a version is out.
- The webview has no network and a strict CSP (ADR-0008). Only the Rust host can ask.
- Asking tells a server that someone runs Thoth, and which version. Some people will not want that at all.

## Decision

1. **A notice, not an installer.** No Tauri updater plugin, no signing keys, no download or install by the app. The
   popup says a new version is out and offers "Download" (opens the downloads page in the system browser through the
   host), "What's new" (the release notes link, only if `latest.json` has one), "Later" and "Skip this version".
2. **Where it looks.** The host fetches one fixed address, `https://download.thoth.creaml4tt3.me/latest.json`,
   compiled in. A self-built copy may set another at build time: `apps/desktop/src-tauri/build.rs` reads
   `THOTH_UPDATE_URL` (and `THOTH_DOWNLOADS_PAGE_URL` for where "Download" goes; default
   `https://thoth.creaml4tt3.me/#download`); the value must be `https` or empty, and empty turns the notice off. Nothing
   at run time changes it: not the webview, not a flag, not the environment (a test holds this).
   - **Fetch rules**, the link-preview fetcher (ADR-0020) with these settings: https only (redirects too), a public
     address after DNS that is the address connected to, no cookies, credentials, `Referer` or proxy, a fixed
     `User-Agent` (`Thoth/<version> (update check)`), 5 s in total, at most 64 KB (a longer answer is refused), and
     only `Content-Type: application/json`.
   - **Test switch** (this ADR): the harness's `--link-preview-loopback` (`HostConfig.link_preview_loopback`) also lets
     an `http` address on a loopback IP address through for this request, for a local test server. The harness alone
     parses `--update-url`, `--update-current` and `--update-now` (a fixed clock); the desktop shell has none of them
     and never turns the switch on (a test holds this).
   - **The file.** The shape `scripts/publish-downloads.ts` writes is `{ version, date, base, files[] }`. The notice
     reads `version` (required, a semantic version, no leading `v`), `date` (optional, `yyyy-mm-dd`) and `notes`
     (optional, an `https` link; this ADR names the field, the workflow does not write it yet). A value of the wrong
     type or form is refused, not skipped; unknown fields are ignored. The answer to the webview is a verdict
     (`unavailable`, `off`, `waiting`, `failed`, `current` or `available` with the version, date, links and whether it
     was skipped), never the file and never an error message from the server.
   - **Comparison** is semver 2.0.0 (implemented in the host, no new dependency). A pre-release is never offered to a
     stable build; a build that is itself a pre-release is offered newer pre-releases and the release.
3. **When.**
   - 10 s after the window starts, then every 24 h while it is open (the window schedules; the host decides).
   - The host makes at most one request in 24 h, counted across restarts and windows: the time of the last request is
     kept in the app data folder (`update.json`, mode 0600, never in a vault). A request that fails or times out also
     counts (this ADR), so an offline start is not repeated on every restart. A last-check time in the future (a clock
     set back) does not block checks.
   - "Check now" in Settings skips the 24-hour wait, and shows a version the person skipped (they asked). It makes a
     request and so counts as the day's check.
   - Settings → General → "Tell me when a new version is out" is on by default. **Off means no request at all**,
     "Check now" included (it is disabled). The choice is kept by the host.
   - "Skip this version" is kept by the host until a newer version appears; a skipped version is not shown by the
     automatic check.
4. **The popup.** A small dialog in the top corner (`role="dialog"`, not modal). It takes no focus, so typing goes on;
   a polite status line says it appeared. "Later" or Esc closes it (Esc is ignored while the person types in the
   editor or a field, and when something else already used it). "Later" lasts until the next check. The version also
   becomes an entry in the notification list (ADR-0018) of the kind `update`, which opens the popup again.
   - **No system notification** for it, ever (the core refuses it).
   - **Switch** (this ADR): the per-kind switches of Settings → Notifications decide which kinds appear as system
     notifications, so a switch for `update` would do nothing. Its switch, "Add a new version to the list under the
     bell", decides instead whether the list gets the entry; it does not depend on the system-notifications switch.
     The popup does not depend on it.
5. **The web client** has nothing of this: it is always current. Its bundle has no `update.check`, `update.settings`
   or `latest.json` (a build test holds this).
6. **Host commands**, each granted to the webview by name (no plugin): `update.check({ force? })` and
   `update.settings({ notify?, skip? })`. "Download" and "What's new" use the existing `link.open`. A host created
   without `Host::with_updates` (the harness without `--update-url`, existing tests) has no notice and never asks.

## Consequences

- Positive: people learn a release exists without an updater, signing keys or any code being installed for them.
- Positive: the only new network path reuses the audited fetcher; the person can turn it off completely.
- Negative: every 24 h an installation tells `download.thoth.creaml4tt3.me` its IP address and version number (the
  `User-Agent`). Settings says so.
- Negative: a person who closes the popup with "Later" and restarts the app within 24 h sees nothing until the next
  allowed check. Accepted, to keep "at most once in 24 h".
- Negative: the Thai strings marked `REVIEW` need a native reader.
- Follow-up: `scripts/publish-downloads.ts` could write `notes`; a person checks the popup in a real Tauri window on
  macOS and Windows; Windows and Linux builds of the new tests run in CI as before.

## Alternatives considered

- **The Tauri updater plugin.** Not chosen: it needs signing keys and installs code; the builds are not signed with a
  Developer ID yet.
- **Ask from the webview.** Rejected: it would need `connect-src https:` (ADR-0008).
- **A system notification for a new version.** Not chosen: the notice is rare and the popup and the list are enough.
- **Check at every start.** Rejected: a request per launch tells the server how often someone works; 24 h is enough.
- **A semver crate.** Not needed: the rules are small and tested against semver.org's own ordering example.

## Spec references

Section 2 (local first), 13 (web client), 14.11 (browser contexts and least privilege).

## Open questions

- **Release notes link.** `latest.json` has no `notes` field yet; until `publish-downloads.ts` writes one the popup has
  no "What's new". Blocks nothing.
- **Where "Download" goes.** The website's `#download` section; if the site gets per-language paths, the host may need
  to pick one. Blocks nothing.
