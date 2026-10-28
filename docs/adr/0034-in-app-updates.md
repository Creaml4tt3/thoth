# ADR-0034: In-app updates

- **Status:** Proposed
- **Date:** 2026-10-28
- **Deciders:** owner (rules 1 to 4); implementation agent and orchestrator (the rest, marked "(this ADR)")
- **Supersedes:** ADR-0022 rule 1 ("a notice, not an installer"). The rest of ADR-0022 (when it checks, the fetch rules,
  the popup, the notification entry) still holds.
- **Refines:** ADR-0008 (the webview has no network), ADR-0018 (notifications).

## Context

Since 0.2.0 the desktop app tells people a new version is out and opens the downloads page (ADR-0022). Installing by
hand each time is slow, and many people stay on old versions. The builds are still not signed with a Developer ID, but
the Tauri updater plugin signs updates with its own key (minisign), separate from code signing.

## Decision

1. **Download only when the person clicks Update** (owner). Nothing downloads in the background.
2. **Ask before restarting** (owner): after the download, "Restart now" or "Later". Restart now first writes the
   window's edits (`flushAll`); if a save fails, it does not restart and says so. If an assistant run is going, it says
   so and offers "Restart anyway".
3. **Two settings** (owner): "Tell me when a new version is out" (ADR-0022) and "Download and install updates in the
   app" (on by default). With the second off, or where the copy cannot update itself, the popup keeps Download. Off
   for the first still means no request at all. The second is shown only where it works.
4. **Ships in 0.2.3** (owner). Apps on 0.2.2 and older install 0.2.3 by hand once; their notice tells them.
5. **The host does it, not the webview** (this ADR). The desktop shell uses the plugin's Rust API behind four host
   commands granted by name: `update.install`, `update.cancel`, `update.status` and `update.restart`. Progress comes
   to every window as `update.progress` events. The webview gets no updater plugin permission (a test holds this).
6. **Only signed updates install** (this ADR). The plugin checks the signature against the public key in
   `tauri.conf.json` before it installs anything. The update file must come from the same origin as `latest.json`
   (`https://download.thothnotes.com`), over https, with no redirect and no proxy. A wrong or missing signature, or
   another origin, shows "could not be verified" and the Download button. Errors are reduced to `offline`, `verify`,
   `disk`, `cancelled` or `failed`; the updater's own message is never shown.
7. **One `latest.json`** (this ADR). The updater's `platforms` (address and signature contents) go into the same file
   the notice reads. The 0.2.x reader ignores unknown fields: `crates/thoth-host/tests/old_notice.rs` runs the 0.2.2
   reader, copied from git history, against the new file. A second file would mean two writes that can disagree.
8. **Platforms** (this ADR).
   - macOS: the universal `.app.tar.gz`, for both `darwin-aarch64` and `darwin-x86_64`. Installed in place; restart
     opens the new version. Not offered when the app runs outside a `.app` bundle or from App Translocation (a copy
     opened where it was downloaded), since it cannot replace that.
   - Windows: NSIS installs are updated by the NSIS installer (`windows-x86_64-nsis`), MSI installs by the MSI
     (`windows-x86_64-msi`), `installMode: "passive"`. The installer runs at restart, after every window has saved and
     closed.
   - Linux: the AppImage replaces itself (`linux-x86_64-appimage`). A `.deb` install would need root and a password
     prompt, so it keeps the notice and does not show the switch.
   - A build that is not bundled (`tauri dev`, `cargo run`) never updates itself.
9. **After the restart** (this ADR), the new version opens the Private Space that was open when Restart now was
   clicked (`update-reopen.json` in the app data folder, read once).
10. **Release safety** (this ADR). `bundle.createUpdaterArtifacts` is on. The release workflow stops before building
    if `tauri.conf.json` still has the placeholder public key or the `TAURI_SIGNING_PRIVATE_KEY` secret is missing.
    `scripts/publish-downloads.ts` refuses an installer without its signed update and a `.sig` that is not a minisign
    signature. The update files and signatures are uploaded as immutable, like the installers. The website lists only
    the installers.
11. **Local testing** (this ADR). A debug build may set `THOTH_UPDATE_URL=http://127.0.0.1:<port>/latest.json` to
    serve an update locally. `build.rs` refuses `http` in a release build, and the updater client is https only there.

## Consequences

- Positive: an update is one click and a restart, and only a file signed with Thoth's key installs.
- Negative: the private signing key and its password are a new secret to keep. If they are lost, installed apps can
  never update in the app again; everyone installs the next version by hand once (release.md, "Signing in-app
  updates").
- Negative: the app now includes the updater plugin (larger bundle; see the plan note for the measured size).
- Negative: the Thai strings marked `REVIEW` need a native reader.
- Follow-up: a real update on macOS and Windows, from 0.2.3 to the next release, checked by a person.

## Alternatives considered

- **The plugin's JavaScript API in the webview.** Rejected: it would grant the webview the plugin's network access
  (ADR-0008).
- **A separate updater file.** Not chosen: the old reader accepts the extra field (rule 7, tested).
- **Download in the background.** Rejected by the owner.
- **Update `.deb` installs.** Not chosen: it needs root and a password prompt.

## Open questions

- Whether macOS asks again for anything (keychain, notifications) after an update of the ad-hoc signed app. Check in
  the first real update.
