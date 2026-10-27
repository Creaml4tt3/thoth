# Thoth desktop shell (Tauri 2)

Hosts the platform ports for the webview (ADR-0008, option (a)). The React UI in
`apps/desktop` runs the TypeScript domain code; this crate exposes
`thoth_host::Host::call` (`crates/thoth-host`) as Tauri commands.

- **Bundle identifier `com.thothnotes.desktop`** (ADR-0031, 2026-10-27; was
  `io.github.creaml4tt3.thoth` from 0.1.0 to 0.2.0). It names the app data
  folder (`~/Library/Application Support/<identifier>/`, `%APPDATA%\<identifier>`,
  `~/.local/share/<identifier>`) and the keychain service. At start, before the
  builder, `run` moves the old identifier's folder to the new one once
  (`thoth_host::data_dir::move_legacy`), and secrets under the old keychain
  service move on first read (`MovingSecretStore`). Webview storage (tabs,
  sidebar order) is not moved. `bundle.publisher` (`github`) and
  `bundle.windows.wix.upgradeCode` are pinned to the values 0.2.0 was built
  with, so the Windows installers upgrade it in place. Do not end the
  identifier in `.app` (Tauri warns: it clashes with the macOS bundle
  extension).
- Commands: each contract command `a.b` in `packages/platform/src/ipc.ts` is the
  Tauri command `a_b`. Events are emitted as `vault:changed`.
- Capabilities (`capabilities/main.json`): only Thoth's commands plus
  `core:event:allow-listen`/`allow-unlisten`. No fs, shell, http or dialog
  permissions are granted to the webview. Native dialogs are opened by the host
  (`vault.pick`, `source.pick`), so only user-chosen paths enter the allow-list.
- `vault.reveal` shows an open vault's folder in Finder, File Explorer or the
  Linux file manager. It takes the vault's handle, never a path, so the webview
  can only reveal a folder the user opened. The host launches
  `/usr/bin/open`, `explorer` or `xdg-open` with the canonical root as one
  argument (no shell).
- CSP: `default-src 'self'`, `script-src 'self'`, no remote origins. `style-src`
  allows `'unsafe-inline'` because the UI and editor set inline styles. Fonts
  are bundled (`apps/desktop/src/fonts`, `font-src 'self'`).
- `Info.plist` (merged by Tauri) declares English and Thai localizations, so
  macOS reports a Thai system language to the webview and the UI can follow it.
- Icons are generated from `design/brand/app-icon-dark.svg` with
  `pnpm --filter @thoth/desktop tauri icon ../../design/brand/app-icon-dark.svg -o src-tauri/icons`.
- The `thoth-host-stdio` binary is test infrastructure and is never bundled.
