# Thoth implementation plan and status

Baseline: `Thoth_Architecture_MVP_Handoff.md` v0.2 (2026-10-20). Status is
updated only when the listed acceptance tests pass (`pnpm check`).

## 1. Repository state at handoff (2026-10-20)

The repository directory was **empty**: no source, no git history, no
conventions to follow. Per spec §18, the monorepo was scaffolded from §5.

Toolchain verified on the dev machine:

- Node 24.15 (built-in `node:sqlite`, SQLite 3.51 with FTS5), pnpm 11, TypeScript 7.0
- Rust 1.90; the Tauri CLI is **not installed**
- Docker 29, PostgreSQL 18 client

## 2. Gap analysis vs spec

| Spec area | State | Notes |
|---|---|---|
| ADRs 001–011 (§16) | **Written** | `docs/adr/`. 001, 003 and 010 are Accepted. 002 is Accepted except its editor part. 008 is Accepted for runtimes. The rest are Proposed. ADR-011 needs an owner decision. |
| Canonical content schema (§6, §15.1) | **Done (v1)** | `packages/content`, `packages/domain`, `protocol/schemas/*.json`, `docs/architecture/content-schema.md` |
| Private Space persistence + index (P0) | **Done: domain/storage layer** | `packages/local-store`: CAS atomic writes, journal recovery, reconcile, rebuild, FTS5 search, links/backlinks/graph |
| Filesystem watcher (P0) | **Done (2026-10-21)** | Rust `notify` debouncer (200 ms) emits vault-relative paths; the UI debounces into `vault.reconcile()`, with a full rescan on overflow. |
| Markdown editor (P0) | **Done (2026-10-21)** | `packages/editor` (schema and serializer) plus the editor UI in `apps/desktop`: callout, wikilink and read-only raw node views, CAS saves, and a conflict dialog (keep mine, keep theirs, keep both). |
| Desktop runtime (P0) | **Done (2026-10-21)** | `crates/thoth-host` (Rust ports, openat traversal, SQL sandbox, picker allow-list) and `apps/desktop/src-tauri` (least-privilege capability, strict CSP). `tauri build --debug` succeeds. No signed release bundle yet. |
| Import pipeline (P1) | **Done: domain layer** | `importer-core`, `importer-obsidian`, `importer-notion`, with all four adapters from §7.4 |
| Import wizard UI (P1, §7.1) | **Done (2026-10-21)** | All 10 steps of §7.1, plus resume of unfinished jobs. Runs on the portable importer (`openArchiveSource`/`openFolderSource` over a `SourceHost`) with the Rust source host. |
| Workspace protocol / server / web (P2) | **Contract drafted (2026-10-21)**; auth decided (OIDC, ADR-0013); server 2a done (Podman + PostgreSQL) | `packages/workspace-protocol` route registry → `protocol/openapi.yaml` (drift-checked); `docs/protocol/README.md`; `protocol/conformance` runner and CLI, tested against good and deliberately broken fixture servers. ADR-0004, ADR-0005 and ADR-0009 are still Proposed. |
| Transfer engine (P3) | Not started | ADR-0006 is Proposed. The state enum and `operation_journal` table are reserved. |
| Agent Hub (P4) | Not started | ADR-0007 is Proposed. |
| Licensing | **Decided (2026-10-22)** | Apache-2.0 (ADR-0011). `LICENSE` added; dependency audit clean. Contributions use the DCO (`CONTRIBUTING.md`). |

## 3. Phased plan with acceptance criteria

Each phase is complete only when its listed tests pass in CI.

### Phase 0 — Foundations ✅

- Monorepo, strict TypeScript, Vitest, ADRs, canonical schemas.
- AC: `pnpm check` runs the typecheck, the schema drift check and all tests.

### Phase 1a — Private Space core ✅ (`packages/local-store`, `packages/content`)

Acceptance tests (`packages/local-store/test/vault.test.ts`,
`packages/content/test/*`):

- Indexing never mutates user files. Unknown frontmatter is preserved
  byte-for-byte.
- Links resolve by path, basename, suffix and alias. Ambiguous targets are
  reported, never guessed.
- External create/edit/delete is detected by reconcile.
- Deleting `index.sqlite` and reopening yields an identical index.
- Compare-and-swap writes refuse stale writes and never silently overwrite.
- A crash between the temp write and the rename recovers with no content change.
- Symlinks are never followed, and writes outside the vault or into `.thoth/`
  are refused.
- FTS5 search works for Latin text with diacritics and for Thai substrings.
  FTS syntax in user input is neutralized.
- Works with network access stubbed to throw.

### Phase 1b — Import pipeline ✅ (`packages/importer-*`)

Acceptance tests (`tests/import/*.test.ts`) map to spec §7.5:

| §7.5 fixture | Test |
|---|---|
| Notion ZIP: nested pages, repeated titles, links, images, CSV | `notion.test.ts` › imports pages… / previews… |
| Notion callout/HTML fallback, unsupported DB semantics | same; `html_block`, `database_semantics_lost` warnings |
| Obsidian: wikilinks, aliases, headings, tags, frontmatter, embeds, attachments, duplicates | `obsidian.test.ts` |
| Broken/missing links | unresolved + ambiguous link assertions |
| Malformed ZIP, traversal, huge file, compression ratio | `security-and-resume.test.ts` › archive safety |
| Duplicate import, interrupted/resumed import | idempotent re-import; crash-mid-commit resume; cancel + resume |
| Unicode, Thai, emoji, case collisions | Thai/emoji/NFC assertions; `Readme.md`/`README.md` ZIP test |
| Unknown frontmatter fields | `cssclasses`, nested `custom` map preserved |
| No network | fetch stubbed to throw |

### Track 1 (2026-10-21) ✅ — work not blocked on ADR-0008

| Item | Result | Tests |
|---|---|---|
| `packages/editor` | Tiptap schema and Markdown round-trip (ADR-0002 §7) | 237 tests: every fixture `.md` round-trips byte-identically; canonical goldens; minimal diff; raw survival; more than 2,500 seeded escaping and idempotence cases |
| Import memory (review item 11) | See §5 | `streaming.test.ts`, `memory-smoke.test.ts` |
| Workspace protocol contract | Zod route registry, OpenAPI 3.1, normative docs, conformance suite | 194 tests in `tests/protocol/` |

### Phase 1c — Desktop shell + editor UI + import wizard ✅ (2026-10-21)

1. ADR-0008 is decided (Rust-hosted ports). Scaffold `apps/desktop` (Tauri 2)
   and `apps/web` (Vite + React), sharing `packages/ui`. Implement `VaultFs` and
   `SqlDriver` as Rust commands (`rusqlite` bundled, FTS5) behind a shared port
   contract test suite.
2. Editor UI on top of `packages/editor` (the schema and serializer are done):
   node views for callouts, wikilinks and read-only raw blocks.
3. A filesystem watcher (Rust `notify`, per ADR-0008) that debounces into `vault.reconcile()`. Saving from the editor uses
   `writePage(…, { expectedHash })`. On `ConflictError` the UI shows a diff with
   keep-mine, keep-theirs and keep-both. It never silently overwrites.
4. Import wizard covering spec §7.1 steps 1–10. It goes in Settings → Import &
   Export and in onboarding.

AC:

- Playwright or WebDriver e2e: create a note offline → edit → edit externally
  → conflict prompt.
- Import wizard happy path plus cancel and resume.
- Editor UI: an edit in the app saves through CAS with only the edited
  block changed on disk.

Result:

| AC | Evidence |
|---|---|
| E2E: create a note offline → edit → edit externally → conflict prompt | `tests/e2e/private-space.e2e.ts`. The real UI runs in Chromium on the real Rust host through a test-only bridge, with the network blocked. Keep both writes a conflict copy and never overwrites. |
| Import wizard happy path plus cancel and resume | Same file: an Obsidian ZIP through all wizard steps; a second import cancelled mid-run, then resumed with an identical file set and the source byte-identical. |
| Golden round-trip tests for the editor serializer | `packages/editor/test` |
| One port contract for Node and Rust | `tests/ports`: 22 contract tests on each runtime, 15 Rust security tests, 8 tests running the real `Vault` on Rust ports. |
| Desktop UI behaviour | `apps/desktop/test`: 39 jsdom tests (no-op save, minimal diff, every conflict path, watcher, read-only pages, wizard, search). |

Run with `pnpm check` (unit and contract tests) and `pnpm e2e` (Playwright, which needs the Rust toolchain and Chromium).

Not done in 1c:
- No real-webview e2e. The IPC path is covered by a fake-API test and a successful `tauri build`, not by driving the WebKit webview.
- No signed or notarized bundle.
- No editor toolbar or slash menu. (Wikilink autocomplete: done in Track 2.)
- Import performance is about 13 ms per file on Rust ports. Most of it is fsync (two per file) and IPC round trips. Batch staging and commits before importing exports with tens of thousands of files.

### Track 2 (2026-10-22) ✅ — Plain editor mode (ADR-0012)

Owner request: block editing like Notion and plain writing like Obsidian.

AC:

- Plain mode saves exactly the typed characters, with CRLF, a BOM and odd
  spacing kept: `apps/desktop/test/plain-text.test.ts` (whole fixture and
  golden corpus round-trips through CodeMirror unchanged, plus edge cases) and
  `plain-mode.test.tsx`.
- Switching modes never writes and never drops an unsaved edit; disabled while
  a conflict is open: `plain-mode.test.tsx`.
- The same `PageSession` rules hold in Plain mode (no-op save, CAS, conflict
  dialog with keep both, silent reload, read-only non-UTF-8):
  `plain-mode.test.tsx`.
- Real keystrokes in Chromium on the Rust host: the third scenario in
  `tests/e2e/private-space.e2e.ts` (list continuation uses the file's CRLF).
- The tests were checked by breaking the code on purpose (dropping the BOM, not
  carrying text across a switch, forcing LF): each break fails them.

Wikilink autocomplete (2026-10-22), both modes: typing `[[` lists vault pages
(title, file name, alias, then folder; prefix before word start before
substring). Enter/Tab/click inserts the shortest target that resolves to the
chosen page, so a picked link is never ambiguous. Escape dismisses. In Blocks a
hand-typed `[[Target]]` becomes a real link. Tests: `link-suggest.test.ts`,
`link-autocomplete.test.tsx`, and the fourth e2e scenario (real keystrokes in
both modes).

Not done: per-page mode is remembered for the session only.

### Track 3 (2026-10-22) — Notion-style blocks in Blocks mode (ADR-0012)

The owner clarified that "Blocks" meant Notion's block interactions, not only a
rich-text editor. Built before sign-in (Phase 2b part 2), per the owner. Scope,
all saved as plain Markdown:

- a `/` menu to insert any block;
- a ⋮⋮ handle on each block to drag it, and a block menu: turn into, duplicate,
  delete, move up and down, with keyboard equivalents;
- toggle blocks, stored as Obsidian foldable callouts `> [!toggle]- Title`.
  Folding only changes the view and never writes the file;
- callouts, to-dos, code, quotes and dividers can be inserted, converted and
  deleted.

Columns and databases are out of scope: neither has a plain Markdown form.

AC:

- Moving, duplicating or editing one block leaves every untouched block
  byte-identical.
- Toggles round-trip (parse, serialize, reparse, idempotent) for every fold
  marker.
- Folding a toggle never saves.
- Every block action is one undo step and can be done from the keyboard.
- Read-only pages show no handle or menus.
- e2e: insert a toggle and a to-do with `/`, drag a block, fold the toggle,
  save, and check the file on disk.

Result (2026-10-23) ✅:
- `pnpm check` 924/924; `pnpm e2e` 5/5 (scenario 5 drives the real mouse and
  keyboard on the Rust host).
- The callout title is now editable inline content: `calloutTitle block+`
  (`editor-serialization.md` §3a–3b). Untouched callouts stay byte-identical.
- Drag uses ProseMirror's own dragging, with no new dependency.
- Shortcuts: Alt+Shift+↑/↓ moves the block at the cursor, Ctrl/Cmd+Alt+M opens
  its block menu, Mod+Enter folds. `>> ` starts a toggle.
- Mutation checks:
  - fold writing to the file (2 failures);
  - move dropping neighbours' source bytes (1 failure);
  - the handle staying on a read-only page (1 failure, my own run).
- Not done: inserting an image from `/`. A local path needs the host to read
  the file, so it waits for an attachments design.

### Phase 2 — Workspace protocol + reference server + web (ADR-0013)

The protocol contract and conformance suite exist (Track 1). Phase 2 is split:

**2a — Reference server core.** `apps/server` (Fastify + PostgreSQL,
filesystem blob store), personal access tokens behind an `Authenticator`
interface, admin CLI, `compose.yaml` for `podman compose`.

AC:

- The conformance suite is green against the reference server on real
  PostgreSQL (Podman), nothing skipped.
- Server-side authorization tests cover every resource type, including search,
  revisions, attachments and change feeds.
- A stale write returns 412 `revision_conflict`, including two racing writes.
- Missed SSE events are recoverable from the cursor.
- Tokens never appear in logs or responses.

Result (2026-10-22) ✅: `pnpm test:server` 85/85 on PostgreSQL 18 in Podman
(authorization matrix, 12 racing writers ×5 rounds with exactly one winner,
SSE recovery and fan-out across two instances, idempotency across restart,
log/secret capture); `pnpm server:conformance` 36 passed / 0 failed / 0
skipped against the built container. Both kinds of check were confirmed by
breaking the code on purpose (stale-write check removed; non-members let in).
Deviations are listed in `apps/server/README.md` (substring + trigram search,
no rate limiting yet, unbounded change-feed retention).

**2b — Sign-in and trial mode (ADR-0014).** Built in three parts:

- **Part 1, trial mode.** Every limit is configuration
  (`THOTH_PROFILE=trial`), advertised in `/capabilities`, and enforced with
  `quota_exceeded`. Also: a CORS allow-list, rate limits counted in PostgreSQL,
  a daily maintenance job (revision retention, expiry), a PostgreSQL blob store,
  and `EVENTS=off` for serverless hosts.
- **Part 2, sign-in broker.** The server signs in to Google (OIDC) and GitHub
  (OAuth adapter) on the user's behalf. Clients do Authorization Code + PKCE
  against the Thoth server. The server issues short-lived opaque access tokens
  and rotating refresh tokens.
- **Part 3, desktop sign-in.** A loopback redirect, with tokens in the OS
  keychain.

Because SSE is off on the trial, the stream tickets of ADR-0013 are needed
only by self-hosted servers that keep SSE for browsers.

Part 1 result (2026-10-22) ✅:
- `pnpm check` 817/817; `pnpm test:server` 149/149; `pnpm server:conformance`
  36 passed, 0 failed, 0 skipped.
- Every limit is tested at its boundary, including concurrent page creation and
  transfers that would exceed the page limit (nothing is published).
- Also tested: CORS, rate limits across instances, revision pruning (current
  revisions and revisions held by a transfer survive), the maintenance endpoint
  secret, `EVENTS=off`, and the PostgreSQL blob store against the same tests as
  the filesystem store.
- Mutation checks, where each break was caught by the tests:
  - the page-limit check, the CORS origin check and the workspace lock (caught
    in the helper's run);
  - letting pruning delete current revisions (5 failures, my own run).
- `quota_exceeded` is 409. Protocol stays 1.0 (additive changes).
- Revisions are only ever deleted by maintenance, through a transaction-local
  flag the immutability trigger checks.
- A retained revision's `parentId` may name a pruned revision, which answers 404.

Part 2 result (2026-10-23) ✅: the sign-in broker, to the contract in
`docs/protocol/sign-in.md`.
- `pnpm check` 942/942; `pnpm test:server` 198/198 (49 sign-in tests against a
  local OIDC test issuer and a fake GitHub, both in-process).
- ID tokens are verified with `node:crypto` (no new dependency).
  - Asymmetric algorithms only; `none` and `HS*` are refused.
  - Tested and rejected: expired, wrong audience, wrong issuer, wrong nonce,
    unsigned, HS256 with the client secret, unknown key.
  - A rotated key is picked up by refetching the JWKS once.
- Rejected with tests:
  - a replayed code (also revokes the first session);
  - a PKCE mismatch (burns the code);
  - redirect URI and client mismatches;
  - an expired code;
  - refresh-token reuse (revokes the whole family, so old access tokens give
    401);
  - bad redirect URIs (400 page, never a redirect);
  - a replayed or unbound callback.
- Identity is (provider, subject): the same email at Google and GitHub gives
  two accounts.
- The account cap and the per-IP sign-up limit refuse new accounts but not
  existing ones.
- Web refresh tokens are only in an `HttpOnly; Secure; SameSite=Strict`
  cookie, used only from an allowed `Origin`.
- No secret, code, token, state, verifier or nonce appears in any log line or
  page (captured at trace level).
- Mutation checks:
  - helper's run: the PKCE comparison, reuse family revocation, the audience
    check, the binding cookie;
  - my run: the session check on access tokens, `localhost` redirects, expired
    codes.

  Each was caught.
- Deviations: listed in `apps/server/README.md` (open points 10–11).
- Not yet built:
  - deleting inactive accounts (`users.last_seen_at` is kept for it);
  - the clients' side: Part 3 for desktop, Phase 2c for web.

AC:

- Every trial limit is tested at the boundary (limit − 1 succeeds; the limit
  gives `quota_exceeded`, with nothing written), including concurrent creates.
- Tests against a local OIDC test issuer: valid, expired, wrong-audience,
  wrong-issuer, wrong-nonce and unsigned ID tokens; key rotation.
- Sign-in broker: a replayed code, a PKCE mismatch, a redirect URI mismatch and
  refresh-token reuse are all rejected; a reused refresh token revokes the
  whole token family.
- Desktop and web complete a PKCE login against the test issuer (e2e).
- Every trial limit returns a clear protocol error at the limit and never
  loses data; limits appear in `GET /capabilities`.

**Part 3 — Desktop connects to servers (2026-10-23 plan).** Any server
works, not only the trial: self-hosted servers with personal access tokens,
self-hosted servers with their own Google/GitHub/OIDC, and the hosted trial
(owner, 2026-10-23: the trial is only a demonstration).

Design:
- **The Rust host is the client.** Server list, sign-in, token storage and
  every API request live in the Rust host (`crates/thoth-host`, module
  `remote`). The webview calls `server.*` and `api.call` commands and never
  holds an access or refresh token.
  - The only exception: a personal access token the user types in is passed
    once to `server.useToken`.
  - Two side benefits: the CSP keeps `connect-src` to IPC only, and
    self-hosters need no CORS setting for the app.
- **Sign-in** (RFC 8252). The host:
  1. binds `127.0.0.1:0`;
  2. opens the system browser through a `Browser` port (Tauri: opener; tests:
     an event);
  3. runs PKCE S256 and `state` against the server's advertised endpoints;
  4. checks `state` and `iss` on `/callback`, which is single use and times out
     after 5 minutes;
  5. exchanges the code.

  Refresh tokens and personal access tokens go to a `SecretStore` port: the
  macOS Keychain or another OS keychain via `keyring`, and memory in tests.
  Refreshes run one at a time per server.
- **`api.call`** checks every request before it leaves:
  - **Path:** only `/api/v1/...`.
  - **Method and headers:** from an allow-list.
  - **Redirects:** never followed, so the bearer token cannot leak.
  - **Body:** capped in size.
  - **Expired access token:** after a 401, it refreshes once and retries.
- **Addresses:** `https`, or `http` only on a loopback host. The sign-in
  endpoints must be on the same origin as the server address the user added.
- **`packages/workspace-client`:** a typed client over a `send(request)`
  function, shared with the web client (2c). It covers capabilities, me,
  workspaces, tree, page get/put with `If-Match` and 412 conflicts, the change
  feed and search.
- **UI:**
  - Settings → Servers: add a server, sign in with Google/GitHub or with a
    token, sign out, remove.
  - The sidebar lists each signed-in server's workspaces under the Private
    Space.
  - Workspace pages open in the same Blocks/Plain editor. A stale save shows
    the conflict dialog.
  - Open workspaces poll the change feed while the window is visible.
  - Moving or copying pages between spaces is Phase 3.
  - Wikilinks and backlinks are local only for now: in a workspace page,
    links are not resolved and there is no backlinks panel.
  - The save and conflict state machine is shared through a `PageStore`
    seam (`vaultPageStore`, `workspacePageStore`). A server checks the
    revision itself, so a remote change under local edits is met at the next
    save (412) rather than at once.

AC:
- Against the real server and its test OIDC issuer, through the Rust host
  harness:
  - add server, sign in, list workspaces, read and write a page;
  - refresh after the access token expires;
  - sign out revokes the session on the server and removes the keychain entry.
- A personal access token sign-in works against a server with no provider
  configured.
- Refused, with tests:
  - a wrong `state` or `iss` on the loopback callback;
  - a second callback;
  - a sign-in that times out;
  - endpoints on another origin;
  - plain `http` to a non-loopback host;
  - `api.call` outside `/api/v1`;
  - a redirect from the server (not followed, no token sent).
- No token reaches the webview: the stdio and IPC replies are checked.
- Playwright: add a local server, sign in through the fake provider, open a
  workspace page, edit it, see a 412 conflict from a concurrent edit and keep
  both.

**Part 3 result (2026-10-24) ✅**
- **Checks:** `cargo test --workspace` (host 22 + 12 integration, desktop 5),
  clippy clean, `pnpm check` 980/980, `pnpm test:server` 205/205 (including
  `desktop-host.test.ts` against the real server through the harness),
  `pnpm e2e` 6 passed (`workspace-server.e2e.ts` runs).
- **Mutation checks**, each caught by at least one test:
  - state check, same-origin endpoints, single-flight refresh (both paths);
  - the `..` path filter, following redirects;
  - `authorization` allowed from the webview, `set-cookie` passed to it;
  - sign-out without revocation, a rotated refresh token not stored;
  - a rejected personal access token left signed in.
- **Deviations:**
  - **System browser:** opened with `open` / `rundll32 url.dll` / `xdg-open`
    (one argument, `http(s)` only), not with the opener plugin, so the
    webview gets no opener permission.
  - **keyring 3.6.3, not 4.x:** 4.x ties the macOS store to D-Bus Secret
    Service on Linux. Linux uses kernel keyutils, which do not survive a
    reboot, so Linux users sign in again after a restart.
  - **Refresh failures:** a refused refresh (4xx) signs the server out; a 5xx,
    a 429 or a network failure keeps the secret (`SERVER_UNREACHABLE`), so an
    outage does not sign anyone out.
  - **Headers:** headers outside the allow-list are refused
    (`BAD_ARGUMENT`), not dropped.
  - **`iss` is required** on the callback (RFC 9207); Thoth servers send it.
  - **Bodies:** `api.call` bodies are UTF-8 text. Attachments (binary) need a
    bytes variant when they reach the client.
  - **Tauri permission names:** they keep the contract's camelCase
    (`allow-server-signIn`).
- **Owner decisions (2026-10-24), built:**
  - **Starter server:** the owner's demo server is suggested in Settings →
    Servers ("Add Thoth demo server"). The app contacts it only after the
    user adds it.
  - **Caution:** the demo server shows one short line ("A free demo … keep
    anything important in your Private Space"), not a big warning. Other
    servers show none.

**2c — Website and web client (2026-10-24 plan, ADR-0015).** Owner
decisions:
- The web client connects only to the trial server.
- The site is in English and Thai.
- A showcase video with motion and sound, made by us.
- GA4 runs after consent, anonymously in the web client.
- The site is built for SEO, AEO and GEO.
- Legal pages follow Thai law (PDPA).

Work streams, each in its own worktree:

1. **Web client + first-run fix** (`apps/web`, `/app`).
   - **First-run gap found 2026-10-24:** a new account has no workspace (the
     protocol cannot create one, and sign-up does not). Fix:
     - On an account's first sign-in through the broker, the server creates
       one workspace owned by it, named "<display name>'s workspace" (or
       "My workspace"). This applies to both profiles, and it counts toward
       the trial limit.
     - Workspaces in the desktop app and the web client get **New page**,
       which creates the page with `If-None-Match: *`.
   - The editor, page session, conflict dialog and workspace store are shared
     with the desktop app through a package, not copied. There is no
     behaviour change on the desktop: its tests stay green.
   - Sign-in uses `thoth-web`: a top-level redirect to `/auth/authorize`,
     `/app/callback`, the refresh-token cookie, and the access token in memory.
     Silent refresh on load, sign-out with revoke.
   - Browse the tree, open, edit and autosave in both editor modes, 412
     conflicts with Keep both, search, change-feed polling while visible, and
     the trial caution and limits.
   - English and Thai UI.
2. **Landing site** (`apps/site`): static HTML per page in English (`/`) and
   Thai (`/th/`).
   - Pages: home (hero, video, features, how it works, Private vs Workspace,
     self-host, FAQ), privacy, terms.
   - Download and self-host say "coming soon" until the repository is public.
   - SEO, AEO and GEO: JSON-LD, `hreflang`, a sitemap, `robots.txt` and
     `llms.txt`.
   - GA4 consent: a banner with Consent Mode v2, defaulting to denied.
   - Legal pages under PDPA. The deploy merges the site with the web
     client's build under `/app`.
3. **Showcase video** (`design/video/` sources, renders in
   `apps/site/public/media/`).
   - About 60 to 75 s. Footage is recorded by Playwright from the real UI
     with demo data. Motion titles in English and Thai.
   - An original soundtrack and interface sounds are generated in the repo.
     There is no voice.
   - Outputs: MP4, WebM, a poster and WebVTT captions per language. The
     whole video rebuilds from one script.

AC:
- **First run:** a new account signs in and finds its own workspace, then
  creates, edits and reopens a page (server test, plus Playwright in the web
  client).
- **Web client** (Playwright, against the real server and the test issuer):
  - sign in;
  - open a page;
  - edit it in Blocks and in Plain;
  - a stale write shows the conflict dialog, and Keep both works;
  - reload, and the user is still signed in (cookie refresh);
  - sign out, and the server revokes the session.
- **No token in storage:** after sign-in, `localStorage`, `sessionStorage`,
  `document.cookie` and the DOM hold no `thoth_at_` / `thoth_rt_`.
- **Network:**
  - before consent, the site and the client make no request outside their
    own origin, except to the trial API;
  - after Decline, still none;
  - after Accept, only `googletagmanager.com` and
    `*.google-analytics.com`;
  - analytics payloads contain no page title, ID, search text or email
    (checked by intercepting the requests in Playwright).
- **Accessibility:** Lighthouse accessibility ≥ 95 on the English and Thai
  home pages. The Lighthouse SEO score is 100.
- **SEO checks:**
  - every page has a title, a description, a canonical URL and
    `hreflang` pairs;
  - the JSON-LD is valid;
  - `/app` is `noindex`.
- **Video:** it plays muted on load, plays with sound on demand, and has
  captions. `prefers-reduced-motion` shows the poster. The video rebuilds from
  its script.
- **Security:** the web build cannot reach the local filesystem or spawn
  processes (§14.11). CSP: `connect-src` lists only self, the trial API and
  the GA4 hosts.

**Stream 1 result (2026-10-24): web client + first-run fix.**
- **Checks:** `pnpm check` 1013/1013, `pnpm test:server` 212/212,
  `pnpm e2e` 7 passed (`web-client.e2e.ts` included).
- **First run:** the broker gives a new account one owned workspace in the
  same transaction (`docs/protocol/sign-in.md` §4). Desktop and web get
  **New page** (editors and owners; `If-None-Match: *`).
- **Shared, not copied:** `packages/app-ui` holds the editor (Blocks, Plain,
  `PageFrame`, page session, conflict dialog), the workspace state
  (`ServerDirectory` over a `Servers` port, workspace store, tree, limits,
  starter), the UI primitives and the English and Thai strings. The desktop
  keeps the vault side (`vaultPageStore`, wikilinks from the index,
  backlinks) and its English text is unchanged.
- **`apps/web`:** `thoth-web` sign-in, the access token in memory only,
  silent refresh, sign-out with revoke; analytics hooks through
  `window.thothAnalytics` only (no GA code in the bundle).
- **Deviations:**
  - the CSP `<meta>` adds `frame-ancestors 'none'` but browsers ignore it
    there: the static host must also send the policy as a header
    (docs/deploy/trial.md §6);
  - the meta adds `referrer` `no-referrer`;
  - fonts: `@fontsource-variable/inter` and `noto-sans-thai` 5.2.8 (OFL),
    Latin and Thai subsets only.

**Follow-ups from the video recording (2026-10-24)** (`design/video/README.md`,
"UI notes", items 2, 3, 4 and 6):
- **Desktop Thai UI.** The desktop follows the system language (`th*` →
  Thai, else English, from the webview's `navigator.languages`). Settings →
  Language offers System / English / ไทย, kept in localStorage like the default
  editor mode. Its own text is in `apps/desktop/src/strings` (`en.ts`,
  `th.ts`, same shape, checked by a test). The shared editor and workspace
  text comes from `packages/app-ui` in the same language. `Info.plist`
  declares `en` and `th`, so macOS hands the webview a Thai system language.
- **Bundled fonts.** Inter (latin, latin-ext) and Noto Sans Thai (thai), the
  same Fontsource woff2 files as the web client and video, committed in
  `apps/desktop/src/fonts` with their OFL texts, which the build copies to
  `dist/fonts/`. About 156 KB in total. The desktop puts Noto Sans Thai straight
  after Inter in its font stack.
- **Server name.** `SERVER_NAME` (trimmed, 1–64 characters, no control
  characters) is sent as `server.name`. It defaults to the host name of
  `PUBLIC_URL`, else "Thoth server". The trial's is "Thoth demo server".
  Clients fall back to the host name. This is additive in protocol 1.0 (§3).
- **Private Space folder.** Settings shows `~/…`, shortened in the middle to 48
  characters, with the full path as a tooltip. It adds a Show in Finder / File
  Explorer / Files button through a new host command, `vault.reveal`, which
  takes the vault's handle and never a path. Onboarding's Recent list also
  shows `~`.
- **Checks:** `pnpm check` 1071/1071, `cargo test --workspace` 42, clippy
  clean, `pnpm test:server` 212/212, `pnpm e2e` 20 passed
  (`desktop-language.e2e.ts` included).
- **Deviations (no locked decision changes):**
  - The fonts are committed files, not an npm dependency of the desktop app,
    so the desktop gets no new dependency. They are byte-identical to the
    web client's Fontsource 5.2.8 files.
  - On the desktop, Noto Sans Thai comes before the system font
    (`--thoth-font-sans` is overridden in `apps/desktop/src/fonts/fonts.css`),
    so Thai looks the same on every machine. `packages/ui/src/tokens.css` is
    unchanged.
  - Thai keeps "Private Space" as a name, as the Thai website does.

### Phase 3 — Transfer engine

- `packages/transfer`: the ADR-0006 state machine with durable
  `.thoth/operations/<id>.json` records, the reference classification from
  §9.3, and ID mapping persisted to `.thoth/sync/`.

AC:

- Private→Workspace copy and move, then Workspace→Private move back, with
  verified hashes, attachments and link mapping.
- Fault injection at every state boundary; the source survives each one.
- `destination_committed_source_cleanup_pending` is reported correctly.
- The server's export restriction is enforced.

### Phase 4 — Agent Hub

- `packages/agent-core` plus the Claude Code CLI adapter first, then Codex.
  Flags must be verified against the installed CLI's `--help` and official
  docs. Execution happens in a scoped temp directory.
- Changes are reviewed as diffs and applied only through CAS writes.

AC:

- Detection of a missing or present CLI.
- Start, stream and cancel.
- Only the selected context is present in the working directory.
- Proposed changes are never applied without approval.
- Browser contexts cannot spawn processes or read files without the local
  bridge (§14.11).

### Phase 5 — MVP end-to-end (§14)

All twelve steps of spec §14 as one automated scenario.

## 4. Deviations and clarifications (none change a locked decision)

1. **Durable sync metadata outside SQLite.** `external_locations` and
   `sync_state` are listed in §6.3 as index tables. They cannot be derived from
   Markdown, so ADR-0001 adds durable `.thoth/sync/` JSON records and treats the
   tables as projections. This preserves "index loss ≠ content loss".
2. **Thai search.** §2 locks SQLite + FTS5. `unicode61` cannot segment Thai, so
   a second FTS5 table uses the `trigram` tokenizer. It is still FTS5, but
   storage roughly doubles.
3. **Import adds identity frontmatter.** `thoth_id` and `thoth_source` are
   added to imported pages by default (the `addIdentityFrontmatter` option),
   per ADR-0003 and ADR-0010. This is a small tension with §7.3's "preserve
   original syntax where conversion is not needed". The edit is a pure append
   with no other byte changes. Pages with malformed frontmatter are left
   untouched.
4. **Notion databases.** Both `Name.csv` and `Name_all.csv` are imported
   verbatim as files. Row pages are imported as ordinary pages. There is no
   table or collection model yet; `Database` stays reserved (§6.1).
5. **Notion callouts and toggles** stay as verbatim HTML blocks and are
   reported (`html_block`). They are not converted to native callouts.
6. **Block IDs.** The `blocks` table has no persisted block IDs. Only explicit
   `^anchor` IDs exist (ADR-0002). Persisting implicit block IDs would require
   writing markers into user Markdown.
7. **Unverified Notion format details** are listed in
   `docs/architecture/import-formats.md` (VERIFIED/INFERRED). Fixtures follow
   the best-supported reading. The importer should be re-validated against a
   real current export before release.

## 5. Independent review (2026-10-21) — status

An adversarial review of Phases 1a/1b reproduced 4 critical/high and 4 more
high issues that the original 77 tests did not catch. Fixed and covered by
regression tests (`pnpm check`: 92 tests):

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 (critical) | Archive entries could land in `.thoth/` (wrapper or case variants) and a forged journal made recovery `rm -r` user files | `isReservedPath` checks every segment case-insensitively; journal entries must be UUIDv7-named and may only name their own `.thoth/tmp/<id>.tmp`; recovery never deletes anything else | `forged journal…` (verified failing without the fix), `never imports .thoth/ metadata…` |
| 2 | One bad file (undefined YAML alias, alias bomb, unreadable) made `Vault.open` throw | Frontmatter parsing is total; reconcile isolates per-file errors | `opens and indexes the rest…` |
| 3–4 | Non-UTF-8 bytes corrupted / BOM dropped on edit and import | Lossless `decodeText`/`encodeText`; non-UTF-8 pages are read-only (`NotEditableError`); untouched imported pages are staged from original bytes | `refuses to edit non-UTF-8…`, `copies UTF-8 BOM pages…` |
| 5 | Same-title Notion pages merged children into one folder | Destinations assigned per directory by Notion ID; title-only attachment folders bind to their page | `keeps same-title Notion pages…` |
| 6 | Obsidian directory import stripped a real top-level folder | Wrapper stripping only for ZIP adapters | `keeps a single real top-level folder…` |
| 7 | File/folder name conflict made an import permanently stuck | Detected at plan time, skipped with `file_folder_conflict` | `skips a file that conflicts…` |
| 8 | No-replace rename required hardlinks | Exclusive-copy fallback on `EPERM/ENOTSUP/EXDEV/…` | `falls back to an exclusive copy…` |
| 9 | Code span in a link label hid the link | Bracket matcher skips code spans | `tracks and rewrites links whose label…` |
| 10 | Many medium entries bypassed the ratio check | Archive-wide ratio limit | `rejects many medium entries…` |
| 12 | Duplicate-ID owner flipped after rebuild; stale warnings | Owner chosen from paths only (`claimOwner`); warnings recomputed | `keeps duplicate thoth_id ownership stable…` |
| 14 | Schema-version drop skipped `search_content` | Drop all tables | (covered by rebuild path) |
| low | Duplicate frontmatter keys; mixed line endings; NUL in search | Treated as malformed; fence-local EOL; control chars stripped | content/vault tests |
| 11 (fixed 2026-10-21) | Nested ZIPs and all page text held in memory during planning | STORED parts read in place through a range-bounded reader; compressed parts stream to a private 0700 temp dir that is removed on success, failure, cancel and close; planning streams hashes and keeps only references and metadata; every item is re-read and hash-verified at convert time; new `maxNestedArchiveBytes` limit (1 GiB) | `tests/import/streaming.test.ts`, `memory-smoke.test.ts` (312 MiB export: peak 110 MiB, versus 628 MiB before) |

**Still open (tracked, not fixed):**

- **13 (medium) Narrow overwrite window:** an external edit made between the
  final hash re-check and `rename()` can be replaced. Closing it fully needs
  OS-level compare-and-swap. Mitigation in Phase 1c: the watcher re-verifies
  after each write and surfaces any lost-update as a conflict copy.
- **Residual from item 11:**
  - One file at a time still passes through memory, because `VaultFs.writeFile`
    takes bytes.
  - Database CSV checks parse each CSV whole.
  - `reconcile()` keeps every parsed page in memory.
  - A SIGKILL during extraction can leave a `thoth-import-*` temp directory
    behind; a startup sweep is still to do.
- **Phase 1c review fixes:**
  - `Vault` serializes reconcile, rebuild and writes on its single SQL connection; overlapping transactions used to throw.
  - `Vault.close()` drains in-flight work before closing.
  - Both are covered by regression tests.
- **Desktop (ADR-0008), still open:**
  - Linux opens the vault root without `O_NOFOLLOW_ANY`.
  - SQLite opens its file by path, not anchored to a directory fd.
  - The webview can exhaust resources with SQL against its own index; this is bounded by a 120 s deadline and a 256 MiB result cap.
  - The CSP allows inline styles.
- **Low:** APFS folds `ς`/`Σ` but `collisionKey` does not, which gives a
  reported failure, not data loss. Folder imports do not detect hardlinked
  source files (`nlink > 1`). There is a small TOCTOU window between the
  ancestor symlink check and `open()`.

## 6. Open blockers needing an owner decision

1. ~~ADR-0008: desktop hosting model.~~ Decided 2026-10-21: Rust-hosted ports.
2. ~~ADR-0011: license and contributions.~~ Decided 2026-10-22: Apache-2.0,
   DCO sign-off.
3. **Larger real Notion exports.** One small real export was checked on
   2026-10-22 (import-formats.md §1.0). Multi-part exports, images, toggles and
   title truncation are still unconfirmed.
4. ~~Bundle identifier.~~ Decided 2026-10-22: `io.github.creaml4tt3.thoth`
   (no owned domain yet; the product name may still change, see
   `apps/desktop/src-tauri/README.md` for what a later change costs).
5. ~~Logo and accent.~~ Decided 2026-10-22: Moon Ibis mark, lunar orange accent.
   The first SVG was a hand-drawn approximation that did not match concept A;
   on 2026-10-22 it was replaced by a trace of concept A itself
   (`design/concepts/logo-directions-sheet.png`), and the app icons were
   regenerated.
6. ~~Trial hosting, limits, sign-in providers.~~ Decided 2026-10-22 (ADR-0014):
   - hosting on Vercel + Neon at `thoth.creaml4tt3.me` / `api.thoth.creaml4tt3.me`;
   - limits of 1 workspace, 10 members, 200 pages and 20 MB per workspace;
   - Google first, then GitHub.

   Region Singapore and contact `creaml4tt3@gmail.com` confirmed the same day.
7. ~~Product name.~~ Decided 2026-10-22: **Thoth**. Buying a domain is still
   open; moving to it is a configuration change (ADR-0014).
