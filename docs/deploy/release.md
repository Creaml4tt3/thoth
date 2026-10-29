# Releasing the desktop app

The installers are built by GitHub Actions (`.github/workflows/release-desktop.yml`) and served from
Cloudflare R2: bucket `thoth-downloads`, public at `https://download.thothnotes.com/`.

| Platform | Files | Built on |
| --- | --- | --- |
| macOS (Apple silicon and Intel) | `Thoth_<v>_universal.dmg` | `macos-latest` |
| Windows x64 | `Thoth_<v>_x64-setup.exe` (NSIS), `Thoth_<v>_x64_en-US.msi` | `windows-latest` |
| Linux x64 | `Thoth_<v>_amd64.AppImage`, `Thoth_<v>_amd64.deb` | `ubuntu-22.04` (older glibc, so it runs on more distributions) |

Each release lives under `v<version>/` with a `SHA256SUMS` file. `latest.json` at the root names the newest
release. Released files are never replaced: a fix is a new version.

The desktop app reads `latest.json` to tell people a new version is out (ADR-0022, a notice only: nothing is downloaded
or installed by the app). It needs `version` (semver); `date` and an optional `notes` (an `https` link to the release
notes, shown as "What's new") are read when present. Keep `latest.json` served as `application/json` and under 64 KB.
A self-built copy looks elsewhere through `THOTH_UPDATE_URL` at build time (empty: no notice).

**Keep the old host on the bucket.** Installed 0.2.0 apps (and older) read
`https://download.thoth.creaml4tt3.me/latest.json`; 0.2.1 and later read `https://download.thothnotes.com/latest.json`
(ADR-0031). Both hostnames are custom domains of the same `thoth-downloads` bucket, so one `latest.json` serves both.
Leave `download.thoth.creaml4tt3.me` connected until most installs are past 0.2.x; removing it earlier means those
installs never hear of a new version. `publish-downloads.ts` writes the new host into `latest.json` and the
downloads page; nothing needs to change on the old one.

## One-time setup

1. **R2 token.** Cloudflare → R2 → Manage API tokens → Create API token: permission **Object Read & Write**,
   applied to the bucket `thoth-downloads` only. It has no access to anything else in the account.
2. **GitHub secrets**, in the repository's `downloads` environment (Settings → Environments → downloads):
   `R2_ACCOUNT_ID` (the Cloudflare account ID), `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (from the token).
   Enter them in GitHub only, never in a chat, a file or a terminal log.
3. **The update signing key** (in-app updates, ADR-0034): see "Signing in-app updates" below.

## Releasing a version

0. **Changelog and post, before the tag** (ADR-0026; the website build and the release job fail without them):
   - In `CHANGELOG.md`, rename `## [Unreleased]` to `## [x.y.z] - yyyy-mm-dd`, keep only what ships, add a new
     `[Unreleased]` only when there is something in it (the parser refuses an empty section), and update the compare links at the bottom.
     Entries are user-facing, one line each, under Added, Changed or Fixed; links only as absolute `https` URLs.
   - Do the same in `CHANGELOG.th.md`: same versions, dates, sections and number of entries (a test checks).
   - Publish the version's post in both languages, `apps/site/src/content/blog/{en,th}/thoth-<x-y-z>.md`: set
     `date`, remove `draft: true`, check every line against the build being released. Its picture goes to
     `apps/site/public/blog/images/thoth-<x-y-z>.png` (1200×630).
   - Check the notes: `node scripts/release-notes.ts vx.y.z` prints what the GitHub release will say.
1. Set the version in `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json` and
   `apps/desktop/src-tauri/Cargo.toml` (then `cargo update -p thoth-desktop --offline`). The publish step
   refuses installers whose version differs from `tauri.conf.json`.
2. Commit, then tag and push: `git tag v0.1.0 && git push origin v0.1.0`. The workflow builds macOS,
   Windows and Linux, runs the Windows host tests (`test-windows`), and uploads the installers only if every
   build and those tests pass. `workflow_dispatch` (Actions → Release desktop → Run workflow) does the same
   without a tag; untick "Upload to R2" to build only. On a tag, the `github-release` job then creates (or edits)
   the GitHub release with `scripts/release-notes.ts` as its body, and `latest.json` carries
   `notes: https://thothnotes.com/changelog/#v<x-y-z>` for the app's "What's new" link.

   Faster builds: a tag's run can only use the Rust caches saved on `main`, and only a run on `main` saves them. When
   `Cargo.lock` or the Rust version changed, first warm them: `gh workflow run release-desktop.yml --ref main -f
   publish=false` (it builds and tests, uploads nothing), then tag once it has finished.
3. Copy the published `latest.json` into the website's download manifest
   (`apps/site/src/content/downloads.ts`), commit and push: Vercel deploys the website, with the new post, the
   changelog entry and the feeds.
4. **Tell search engines (IndexNow), after Vercel has deployed.** One-time setup: make a key (8 to 128 letters,
   digits or dashes, for example `uuidgen | tr -d '\n'`), and add it to the Vercel project as the environment
   variable `INDEXNOW_KEY` (Production). The build then publishes `/<key>.txt`, which is how the engines check the
   site is yours ([IndexNow protocol](https://www.indexnow.org/documentation), "Option 1"). Never commit the key.
   Each release, once the deploy is live:

   ```sh
   INDEXNOW_KEY='<the key>' node apps/site/scripts/indexnow.ts --dry-run   # checks the key file, counts the URLs
   INDEXNOW_KEY='<the key>' node apps/site/scripts/indexnow.ts             # one POST to api.indexnow.org
   ```

   It sends every URL of the live `sitemap.xml`; 200 or 202 is success. IndexNow engines (Bing, Yandex and others)
   share submissions with each other; Google does not use IndexNow, so it relies on the sitemap in Search Console.
   Do not run it more than once per deploy (429 means too often).
5. **New post pictures:** after adding `apps/site/public/blog/images/<slug>.png`, run
   `pnpm --filter @thoth/site webp` (needs `cwebp`) and commit the `.webp` next to it; the pages serve the WebP
   and keep the PNG for Open Graph. If a post was edited after its date, set `updated:` in both languages.
6. To rewrite the notes of an earlier release: `node scripts/release-notes.ts v0.1.3 > notes.md && gh release
   edit v0.1.3 --notes-file notes.md`.

## Windows

The Windows build has the same host as macOS and Linux, with its own file layer (`crates/thoth-host/src/win`,
`vault_fs_windows.rs`, `source_windows.rs`). Windows has no `openat`, but the NT API does: every vault and
import-folder path is opened with `NtCreateFile` relative to the directory handle the host opened for the root,
one component at a time, so no absolute path is re-resolved per call. Every open carries
`FILE_OPEN_REPARSE_POINT` and the handle's reparse attribute is checked, so symlinks, junctions and mount points
are reported and never followed, in any component. The root itself is opened by its canonical path and its final
path (`GetFinalPathNameByHandleW`) must still be that path, which refuses a junction swapped into an ancestor.

- Renames go through the source's handle with the target named relative to its directory handle
  (`FileRenameInfoEx`). The compare-and-swap write's temp-to-target replace is atomic, with POSIX semantics, so it
  works while another program has the page open and on a read-only target. No-replace is the volume's own atomic
  no-replace rename; any entry answering to the name (another letter case, NFD) is `EEXIST`.
- Names Windows cannot hold (`CON`, `nul.md`, `a.md:stream`, a trailing dot or space, `<>:"|?*`) are refused when
  creating and are "not found" when reading. Names match case-insensitively (per-folder case sensitivity is
  honoured), and a name stored in NFD (copied from a Mac) is found by its NFC spelling.
- FAT32 and exFAT volumes (USB sticks, SD cards, many external drives) do not support the attribute-tag query
  (`FileAttributeTagInfo`, error 87); there the host reads the attributes from `FileBasicInfo` instead. Those volumes
  hold no reparse points, and one seen without its tag is still refused (`win/nt.rs`, `attr_tag`).
- Long paths work: relative opens have no `MAX_PATH` limit and roots are opened with the `\\?\` prefix. The
  host shows and stores roots without it (`C:\Users\you\Notes`).
- The Agent Hub runs Claude Code in a Job Object (kill-on-close): cancel, timeout and app exit end the whole
  process tree at once. It finds `claude.exe` from the native installer (`%USERPROFILE%\.local\bin`), WinGet, or
  npm's `claude.cmd` (which runs the native `.exe` directly when it is the plain npm shim).
- `vault.reveal` opens File Explorer (`%SystemRoot%\explorer.exe`, the folder as one argument).

Where the guarantees differ from macOS and Linux, and why, is in ADR-0008 ("Windows file layer").

CI: the `Windows x64` build entry makes the NSIS and MSI installers; `test-windows` runs `cargo test -p
thoth-host` (including `tests/windows_fs.rs`, which makes a junction) and the port contract in Vitest
(`tests/ports`). Run both without publishing: Actions → Release desktop → Run workflow with "Upload to R2"
unticked, or `gh workflow run release-desktop.yml --ref <branch> -f publish=false`.

Not covered by CI: Windows on ARM (only x64 is built), FAT/exFAT and network volumes (renames
and deletes fall back to the classic, non-POSIX semantics there), and OneDrive folders (Windows shows cloud
placeholders to apps as plain files, so they should work; if a placeholder is exposed as a reparse point, the host
refuses it like any other).

## Signing in-app updates

In-app updates (ADR-0034) install only files signed with Thoth's updater key (minisign, not a Developer ID). Once:

1. `pnpm --filter @thoth/desktop tauri signer generate -w ~/.tauri/thoth-updater.key`, with a password.
2. Repository secrets (Settings → Secrets → Actions; the `build` job has no environment):
   `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/thoth-updater.key` and
   `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (type the password).
3. The contents of `~/.tauri/thoth-updater.key.pub` go into `apps/desktop/src-tauri/tauri.conf.json` as
   `plugins.updater.pubkey`. A release stops while it is still `THOTH_UPDATER_PUBKEY_PLACEHOLDER`, or while the private
   key secret is missing.
4. **Back up the private key file and its password** (a password manager). If either is lost, installed apps can never
   update in the app again: a new key means a new public key in the app, and everyone installs that version by hand
   once. Never paste either into a chat, a file in the repo or a log.

Each release then uploads, next to the installers, the signed update files (`*.sig`, and the Mac app archive
`Thoth_<version>_universal.app.tar.gz`), and `latest.json` lists them under `platforms`. The website lists only the
installers.

To try an update locally: build two debug versions with `THOTH_UPDATE_URL=http://127.0.0.1:<port>/latest.json`, signed
with a throwaway key (never committed), and serve the newer one's files and `latest.json` from that port. A release
build refuses an `http` address.

## Signing (not yet)

The builds are not signed with a Developer ID. The macOS app is ad-hoc signed (a sealed bundle, so macOS does
not call it damaged), but Gatekeeper still says it cannot check the app until the user chooses Open Anyway
once; the website's download section says how. The Windows installers are unsigned: SmartScreen warns about an
unknown publisher until the user chooses More info → Run anyway (the website says so too), and the MSI shows
"Unknown publisher" in its UAC prompt. Signing needs an Apple Developer ID (99 USD a year, plus notarization) and a Windows code-signing certificate. Both plug into
the same workflow through Tauri's signing environment variables.

## Cost

GitHub Actions minutes on a private repository count macOS at 10× and Windows at 2× (the free plan has 2,000
minutes a month). The first release took about 9 minutes each for macOS and Linux, so about 100 billed
minutes while the repository is private. Public repositories build for free.
R2 has no charge for downloads (egress); storage is free up to 10 GB a month.
