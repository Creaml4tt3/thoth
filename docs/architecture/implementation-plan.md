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
| Workspace protocol / server / web (P2) | **Contract drafted (2026-10-21)**; server and web not started | `packages/workspace-protocol` route registry → `protocol/openapi.yaml` (drift-checked); `docs/protocol/README.md`; `protocol/conformance` runner and CLI, tested against good and deliberately broken fixture servers. ADR-0004, ADR-0005 and ADR-0009 are still Proposed. |
| Transfer engine (P3) | Not started | ADR-0006 is Proposed. The state enum and `operation_journal` table are reserved. |
| Agent Hub (P4) | Not started | ADR-0007 is Proposed. |
| Licensing | **Decided (2026-10-22)** | Apache-2.0 (ADR-0011). `LICENSE` added; dependency audit clean. DCO vs CLA still open. |

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
- No editor toolbar, slash menu or wikilink autocomplete.
- Import performance is about 13 ms per file on Rust ports. Most of it is fsync (two per file) and IPC round trips. Batch staging and commits before importing exports with tens of thousands of files.

### Phase 2 — Workspace protocol + reference server

- `protocol/openapi.yaml` (OpenAPI 3.1) generated from shared Zod schemas, with
  RFC 9457 errors, cursors, ETag/If-Match and Idempotency-Key.
- `apps/server` (Fastify + PostgreSQL, filesystem blob store with an S3
  adapter) and Docker Compose.
- `protocol/conformance/` suite that can run against any server URL.

AC:

- The conformance suite is green against the reference server.
- Server-side authorization tests cover every resource type, including search,
  revisions, attachments and change feeds.
- A stale write returns 412 `revision_conflict`.
- Missed SSE events are recoverable from the cursor.

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
2. ~~ADR-0011: license.~~ Decided 2026-10-22: Apache-2.0. Still open: DCO vs
   CLA, which blocks accepting outside contributions.
3. **A real Notion export sample**, needed to confirm the INFERRED format
   details before release.
4. **Bundle identifier.** `app.thoth.desktop` is provisional. It must be fixed
   before the first build anyone else installs, because changing it later moves
   the app data directory (recent vaults list).
5. ~~Logo and accent.~~ Decided 2026-10-22: Moon Ibis mark, lunar orange accent.
