# Releasing the desktop app

The installers are built by GitHub Actions (`.github/workflows/release-desktop.yml`) and served from
Cloudflare R2: bucket `thoth-downloads`, public at `https://download.thoth.creaml4tt3.me/`.

| Platform | Files | Built on |
| --- | --- | --- |
| macOS (Apple silicon and Intel) | `Thoth_<v>_universal.dmg` | `macos-latest` |
| Windows x64 | `Thoth_<v>_x64-setup.exe`, `Thoth_<v>_x64_en-US.msi` | `windows-latest` |
| Linux x64 | `Thoth_<v>_amd64.AppImage`, `Thoth_<v>_amd64.deb` | `ubuntu-22.04` (older glibc, so it runs on more distributions) |

Each release lives under `v<version>/` with a `SHA256SUMS` file. `latest.json` at the root names the newest
release. Released files are never replaced: a fix is a new version.

## One-time setup

1. **R2 token.** Cloudflare → R2 → Manage API tokens → Create API token: permission **Object Read & Write**,
   applied to the bucket `thoth-downloads` only. It has no access to anything else in the account.
2. **GitHub secrets**, in the repository's `downloads` environment (Settings → Environments → downloads):
   `R2_ACCOUNT_ID` (the Cloudflare account ID), `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (from the token).
   Enter them in GitHub only, never in a chat, a file or a terminal log.

## Releasing a version

1. Set the version in `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json` and
   `apps/desktop/src-tauri/Cargo.toml` (then `cargo update -p thoth-desktop --offline`). The publish step
   refuses installers whose version differs from `tauri.conf.json`.
2. Commit, then tag and push: `git tag v0.1.0 && git push origin v0.1.0`. The workflow builds the three
   platforms and uploads them. `workflow_dispatch` (Actions → Release desktop → Run workflow) does the same
   without a tag; untick "Upload to R2" to build only.
3. Copy the published `latest.json` into the website's download manifest
   (`apps/site/src/content/downloads.ts`) and deploy the website (docs/deploy/trial.md §6).

## Signing (not yet)

The builds are not code-signed. macOS Gatekeeper says it cannot check the app, and Windows SmartScreen warns
about an unknown publisher; the website's download section tells people how to open them. Signing needs an
Apple Developer ID (99 USD a year, plus notarization) and a Windows code-signing certificate. Both plug into
the same workflow through Tauri's signing environment variables.

## Cost

GitHub Actions minutes on a private repository count macOS at 10× and Windows at 2× (the free plan has 2,000
minutes a month). A full release uses roughly 20 macOS minutes, 15 Windows minutes and 10 Linux minutes, so
about 240 billed minutes while the repository is private. Public repositories build for free.
R2 has no charge for downloads (egress); storage is free up to 10 GB a month.
