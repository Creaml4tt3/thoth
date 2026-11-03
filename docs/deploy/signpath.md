# Windows signing with SignPath Foundation: readiness check

Checked on 2 November 2026 against https://signpath.org/terms and `.github/workflows/release-desktop.yml` at 0.3.1.
The owner applies; nothing here is wired into CI yet, because the workflow needs the SignPath organization and project
IDs that the application gives.

## The conditions, one by one

| Condition (signpath.org/terms) | Thoth today | Status |
| --- | --- | --- |
| OSI licence, no commercial dual-licensing, no proprietary component | Apache-2.0 for everything in the repository | Fits |
| Actively maintained; already released in the form to sign; functionality described on the download page | 0.3.1 `.exe` and `.msi` on `download.thothnotes.com`, linked and described on `thothnotes.com` | Fits |
| Sign your own project and your own binaries only; the signing team owns the repository | `Creaml4tt3/thoth`, one maintainer. The Windows installers bundle `thoth-desktop.exe` and `thoth-mcp.exe`, both built from this repository. WebView2 is not bundled | Fits |
| No hacking tools; no malware or PUA | Nothing of that kind | Fits |
| Binary artifacts built from source in a verifiable way, by CI | Built on GitHub-hosted `windows-latest` from the tagged commit, `pnpm install --frozen-lockfile`, actions pinned to commit SHAs, `persist-credentials: false` | Fits. SignPath's GitHub integration verifies the origin from the workflow run, so the signing request must be made by that same run |
| Every release needs manual approval for signing | Not in place: the Windows job builds and `publish` uploads with no stop | **Gap**: the signing step waits for approval in SignPath (below) |
| MFA for everyone, on SignPath and on GitHub | One person | Owner: turn on 2FA on GitHub (if not already) and on SignPath |
| Roles: authors, reviewers, approvers | One person holds all three | Fits. Say so on the policy page |
| A "Code signing policy" on the home page and the download page, with the credit line "Free code signing provided by SignPath.io, certificate by SignPath Foundation", the roles and a privacy policy link | None yet | **Gap**: marketing (site). Link `https://thothnotes.com/privacy/` |
| All signed binaries carry product name and version metadata, the same version in each build | `thoth-desktop.exe` has Tauri's version resource (product name Thoth, version from `tauri.conf.json`). `thoth-mcp.exe` is a plain Cargo binary and probably has no version resource | **Check** on a built `.exe` (Properties → Details). If `thoth-mcp.exe` has none, either leave it unsigned inside the signed installer (allowed) or give it a version resource |
| Provide uninstallation | NSIS and MSI both register an uninstaller | Fits |
| Collecting user data: privacy policy, shown during installation, with an install-time option to turn it off | See the open question below | **Ask SignPath** |

## Open question for the owner to ask SignPath

The terms say: software that "collects user data and transfers it to systems not specified by the user" must describe
it in a privacy policy, display the policy during installation, and include installation options to disable it.

- **Update check:** about once a day the app asks `download.thothnotes.com/latest.json` for the newest version,
  sending its version in the user agent. The request also carries the user's IP address, and the weekly report counts
  distinct addresses. It can be turned off in Settings → Updates, but not during installation. The server is ours,
  not one the user chose. This is the case to ask about.
- **Link previews:** the app fetches a page the user linked in their own notes. The user chose that site, so this
  looks like "specified by the user". Worth mentioning in the same question.

Suggested question: "Thoth checks once a day for a new version by requesting a JSON file from our download server,
sending only its version number (and, as any request does, the IP address). It can be turned off in Settings, and the
privacy policy describes it. Does this count as collecting user data under 'Respect user privacy and security', and if
so, is a setting in the app enough, or do we need a checkbox in the installer?"

If SignPath wants an installer option: the NSIS installer can get a page with "Tell me when a new version is out"
(ticked by default, so the default does not change) that writes the same setting the app reads. That is a small
product change; ask before making it.

## What the release workflow needs once the application is accepted

1. **Sign after the build, in the same run.** The Windows build job uploads the unsigned `.exe` and `.msi` with
   `actions/upload-artifact`, then calls SignPath's GitHub action
   (`signpath/github-action-submit-signing-request`, https://docs.signpath.io/trusted-build-systems/github) with
   `github-artifact-id` from that upload, `organization-id`, `project-slug`, `signing-policy-slug`, an `api-token` from
   the repository secrets, and `wait-for-completion: true`. The run then waits until the owner approves the request in
   SignPath, so give the wait a timeout long enough to approve. For OSS projects SignPath checks that every job leading
   up to the request ran on GitHub-hosted runners, which is already the case.
2. **Re-sign the in-app updates.** Tauri writes each update's `.sig` (ADR-0034) over the unsigned installer. Authenticode
   signing changes the file, so the old `.sig` no longer matches and Windows in-app updates would fail. After SignPath
   returns the signed files, sign them again with `pnpm tauri signer sign` (the same `TAURI_SIGNING_PRIVATE_KEY`), and
   only then hand them to `publish`. `publish-downloads.ts` already refuses an installer without its `.sig`; it does
   not check that the `.sig` matches, so the re-sign step must not be skipped.
3. **Artifact configuration in SignPath:** sign the NSIS installer and the MSI. Ask SignPath whether it can also sign
   `thoth-desktop.exe` inside them (deep signing). If not, the inner program stays unsigned, which the terms allow
   for now.
4. **Docs:** update the "not code-signed" notes at the top of `release-desktop.yml` and in `docs/deploy/release.md`,
   and the site's install instructions. The publisher shown by Windows becomes "SignPath Foundation".

Unverified until the application is accepted: the exact action inputs, the slugs, and whether SignPath signs NSIS
installers and MSI contents. Check SignPath's own documentation then.
