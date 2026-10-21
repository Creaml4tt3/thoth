# Thoth desktop shell (Tauri 2)

Hosts the platform ports for the webview (ADR-0008, option (a)). The React UI in
`apps/desktop` runs the TypeScript domain code; this crate exposes
`thoth_host::Host::call` (`crates/thoth-host`) as Tauri commands.

- **Bundle identifier `app.thoth.desktop` is provisional.** The owner has not
  decided it; changing it later moves the app data directory (recent vaults).
- Commands: each contract command `a.b` in `packages/platform/src/ipc.ts` is the
  Tauri command `a_b`. Events are emitted as `vault:changed`.
- Capabilities (`capabilities/main.json`): only Thoth's commands plus
  `core:event:allow-listen`/`allow-unlisten`. No fs, shell, http or dialog
  permissions are granted to the webview. Native dialogs are opened by the host
  (`vault.pick`, `source.pick`), so only user-chosen paths enter the allow-list.
- CSP: `default-src 'self'`, `script-src 'self'`, no remote origins. `style-src`
  allows `'unsafe-inline'` because the UI and editor set inline styles.
- Icons are generated from `design/brand/app-icon-dark.svg` with
  `pnpm --filter @thoth/desktop tauri icon ../../design/brand/app-icon-dark.svg -o src-tauri/icons`.
- The `thoth-host-stdio` binary is test infrastructure and is never bundled.
