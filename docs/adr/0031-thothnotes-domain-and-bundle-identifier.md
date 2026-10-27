# ADR-0031: thothnotes.com, and the bundle identifier com.thothnotes.desktop

- **Status:** Proposed
- **Date:** 2026-10-27
- **Deciders:** owner (bought `thothnotes.com`; the identifier), orchestrator (brief, DNS, Vercel and R2), implementation agent
- **Amends:** ADR-0014 (addresses), ADR-0015 (website address), ADR-0022 (where the notice looks), ADR-0021 (socket path)

## Context

Until 0.2.0 everything lived under the owner's personal domain: the website and web client at `thoth.creaml4tt3.me`,
the hosted trial at `api.thoth.creaml4tt3.me`, the installers at `download.thoth.creaml4tt3.me`. ADR-0014 planned a
move to a bought domain. The desktop identifier was `io.github.creaml4tt3.thoth`, chosen while there was no domain.
The owner bought `thothnotes.com`, and both change with 0.2.1.

The identifier is more than a label. Tauri names the app data folder after it (`~/Library/Application Support/<id>`,
`%APPDATA%\<id>`, `~/.local/share/<id>`), the app uses it as its keychain service, WebKit and WebView2 keep the
webview's storage per identifier, macOS ties permissions and Gatekeeper's approval to it, and Tauri's Windows bundler
derives some installer values from it. People with 0.2.0 installed must not lose anything that matters.

## Decision

### Addresses

1. **New addresses.** Website `https://thothnotes.com` (`www` redirects to it), web client `https://thothnotes.com/app/`,
   hosted trial `https://api.thothnotes.com`, downloads `https://download.thothnotes.com`. Every address in code, tests,
   the website build, the desktop's starter server and update URL, the release scripts, docs, legal pages and the
   changelog uses them. The contact email stays the same.
2. **The old hosts stay up, outside the repo.** `thoth.creaml4tt3.me` answers with a 301 to the new site (Vercel); the
   site build knows only the new origin. `api.thoth.creaml4tt3.me` keeps serving the same API (not a redirect: the app
   follows none, ADR-0014). `download.thoth.creaml4tt3.me` stays a custom domain of the same R2 bucket, because 0.2.0
   and older read `latest.json` there; keep it until most installs are past 0.2.x (docs/deploy/release.md).
3. **A saved hosted trial moves to the new address.** After the move the server names itself on the new host only
   (`PUBLIC_URL`: `iss`, the sign-in endpoints), and the app requires both on the saved server's origin, so a server
   saved at the old address would stop signing in and refreshing. When the host loads `servers.json` and finds
   `https://api.thoth.creaml4tt3.me`, it changes that record's address to `https://api.thothnotes.com`, moves its
   recorded token and revocation endpoints with it (same path), keeps its handle (the keychain entry and the session
   are keyed by it) and account, renames a label that was only the old host name, and writes the list back once
   (`crates/thoth-host/src/remote/mod.rs`, `move_trial`). If the new address is saved too, neither entry is changed:
   two entries for one origin would be one server listed twice. Any other server is the user's and is never rewritten.
4. The showcase video's published captions (`apps/site/public/media/showcase-*.vtt`) keep the old address, because the
   rendered video shows it; the video script now has the new one, and the captions change when the video is rendered
   again.

### Identifier

5. **`com.thothnotes.desktop`** (Tauri: an identifier must not end in `.app`). The keychain service is the identifier
   (`KEYCHAIN_SERVICE`); a test holds the two equal.
6. **The app data folder moves once, before anything opens it.** It holds the recent Private Spaces, servers, agent run
   history, Connected apps settings and socket, the update and notification settings and the link-preview cache. `run`
   in the desktop shell calls `thoth_host::data_dir::move_legacy(<data>/io.github.creaml4tt3.thoth, <data>/<id>)` before
   the Tauri builder: Tauri creates the config's window before `setup`, and on Linux the webview's folder is the data
   folder itself, so a move in `setup` would find the new folder there already. The old folder is renamed; on a
   cross-device error it is copied to `<new>.moving` (folders, files and links; sockets are left out, the app makes its
   socket again), renamed into place when complete, and the old one removed. Anything at the new path, folder or not,
   is never overwritten, and then the old folder is left too. A failed move is not fatal: the app starts with a new
   folder and the old one stays on disk for a person to move.
7. **Keychain secrets move on first read.** `MovingSecretStore` reads the new service first; when it has no entry it
   reads the old service (`io.github.creaml4tt3.thoth`) and, if that has one, writes it under the new service and only
   then deletes the old entry. If the write fails the secret is still returned and stays where it was. Writes go to the
   new service; deletes clear both, so signing out leaves nothing behind.
8. **Connected apps.** The socket is in the data folder, so its path (`--socket` in the setup an app copied) changes
   and those apps stop connecting. Settings → Connected apps shows a one-time notice, "Copy the setup again", to whoever
   has apps on record the first time they look there; it goes away with "Got it" or when the setup is copied. Someone
   with no apps the first time is marked as having seen it, since any app they set up later uses the new setup. The
   flag is in webview storage, which starts empty after the change (rule 9), so it needs no host support.
   `thoth-mcp`'s default socket uses the new identifier; the sidecar's own path does not depend on it.
9. **Webview storage is not migrated.** Tabs, the sidebar's layout, recent pages, workspace favorites and the language
   and theme choices live in the webview's localStorage, which WebKit (macOS) and WebView2 (Windows,
   `%LOCALAPPDATA%\<id>\EBWebView`) keep per identifier. Copying another app's WebKit data is not supported and could
   corrupt it; these are preferences that come back with use. They start fresh once on macOS and Windows. On Linux the
   webview's folder is the data folder, so they come along with rule 6.
10. **Windows installers upgrade 0.2.0 in place.** From the bundler of `@tauri-apps/cli` 2.12.3
    (`crates/tauri-bundler/src/bundle/windows/{msi,nsis}`):
    - The MSI `UpgradeCode` is derived from the product name (`Thoth.exe.app.x64`, UUID v5 in the DNS namespace), not
      the identifier, so it would not have changed. It is pinned anyway (`bundle.windows.wix.upgradeCode`
      `86c59b04-326e-5a3d-a791-dc519a7a35af`, the value `tauri inspect wix-upgrade-code` prints) so a product rename
      cannot change it.
    - The NSIS uninstall key is `Software\Microsoft\Windows\CurrentVersion\Uninstall\<product name>`, so it would not
      change either. But both installers default the publisher ("manufacturer") to the identifier's second part, which
      was `github` and would become `thothnotes`; it names `HKCU\Software\<publisher>\Thoth`, where the NSIS installer
      remembers the install folder and the MSI its shortcut and install-folder values. `bundle.publisher` is pinned to
      `github`, so a custom install folder is found and the entries stay where they are. (It also stays the `.deb`
      Maintainer, as in 0.2.0.) Changing it later costs the same; it is left until upgrades from 0.2.x stop mattering.
    - What still follows the identifier on Windows: the MSI component GUIDs (harmless: its `MajorUpgrade` removes the
      old product first), the Start Menu shortcut's AppUserModelID, and the folders "delete app data" removes on
      uninstall (now the new ones, which hold the data after rule 6).
11. **macOS treats it as a new app**: notification permission and Gatekeeper's "Open Anyway" are asked again. Said in
    the changelog.

## Consequences

- People upgrading keep their recent Private Spaces, servers and sign-ins, assistant history and settings kept by the
  host. They lose open tabs and the sidebar's order once (macOS, Windows), answer two macOS prompts again, and copy the
  Connected apps setup again.
- The old download and API hosts must stay up for a while; removing the download host early leaves 0.2.0 installs
  without update notices, and removing the API host signs out any 0.2.0 install still running.
- Workspace favorites are stored per server address in webview storage; on Linux, where that storage survives, those
  for the moved trial server are keyed by the old address and are not found again. Favorites are a shortcut, not data.
- A move that fails (permissions, disk full) leaves the old folder for a person; the app does not retry once the new
  folder exists.

## Alternatives considered

- **Keep the identifier.** No migration, but the app would keep a personal GitHub namespace forever, and the cost of
  changing only grows with installs.
- **Tauri's `app.appDirectoriesOverride` pointing at the old folder.** No move, but the old name stays in every path
  for good and the keychain still changes; the move is a one-time cost.
- **Migrate webview storage by copying WebKit or WebView2 folders.** Unsupported formats, and both are locked while a
  webview runs.
- **Ask the user to re-add the demo server.** Simpler, but every 0.2.0 user of the demo would be cut off at the next
  token refresh; rewriting one known origin keeps the handle and the sign-in.

## Spec references

- ADR-0014 (hosted trial, moving domains), ADR-0015 (website), ADR-0021 (Connected apps), ADR-0022 (update notice).
- `docs/deploy/trial.md` (DNS, moving domains), `docs/deploy/release.md` (the old download host).

## Open questions

- When to drop the old download and API hosts (watch the request counts on each).
