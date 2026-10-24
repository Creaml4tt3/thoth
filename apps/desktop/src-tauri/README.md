# Thoth desktop shell (Tauri 2)

Hosts the platform ports for the webview (ADR-0008, option (a)). The React UI in
`apps/desktop` runs the TypeScript domain code; this crate exposes
`thoth_host::Host::call` (`crates/thoth-host`) as Tauri commands.

- **Bundle identifier `io.github.creaml4tt3.thoth`** (owner decision
  2026-10-22; replaces the provisional `app.thoth.desktop`). It names the app
  data directory (`~/Library/Application Support/<identifier>/`, which holds the
  recent vaults list). Changing it again later is possible, but the app then
  starts with an empty recent list unless a migration copies the old file, and
  macOS treats it as a new app (permission prompts, signing). Do not end it in
  `.app` (Tauri warns: it clashes with the macOS bundle extension).
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
