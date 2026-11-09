# Backlog

Ideas, requests and deferred work that have **not shipped**, checked against `main` on 2026-11-09 (after 0.9.0, with
0.9.1 in release). One place to look before planning a version. Sizes are rough: S = days, M = 1–3 weeks, L = more.

Sources: the 2026-10-28 note-app pain-point research, the owner's requests in past sessions, the ADRs' "Open
questions" and "Follow-up" sections, `docs/architecture/implementation-plan.md` and the other project threads.

**Keeping it current:** when something here ships, delete its line in the same pull request. When the owner decides
something ("later", "no", "yes, next"), write it on the line. New ideas go in the right section.

## Next

- **Installable web app (PWA), trial-only (M).** Manifest, icons, service worker for the app shell, install on phones.
  The web app stays trial-only (ADR-0015 decision 1), owner 2026-11-09. Goes with ADR-0045 step 5 (make the web app
  work on a phone).
- **Later, remembered: choose your own server in the web app.** Self-hosters point the web app at their own server at
  run time instead of building it with `VITE_DEFAULT_SERVER` (today's workaround: `docs/deploy/self-host.md`, "A web
  client for your server"). Changes ADR-0015 decision 1, so it needs the owner's decision first.

## Owner said later

- Live co-editing (CRDT, shared cursors), "project B" of ADR-0041 (L). Option A shipped in 0.5.0.
- Notifications for @ mentions of people (M), ADR-0049 follow-up.
- Native mobile app, or capture-only first (L). The web app on phones comes first (ADR-0045).
- An OS-level sandbox for agent runs (L), ADR-0007: "ship without it, but keep it in mind".
- Embedding a page in a page, `![[Note]]` and `![[Note#Heading]]` (M), ADR-0051 and ADR-0010.
- Attachments tied to pages: team visibility and cleanup (M), ADR-0042 rule 8.
- Agent memory parts left out of 0.9.0 (L), ADR-0052: memory through a server, importing and tidying memories,
  changing the memory folder after the first choice.
- Agent Hub context beyond single pages (M), ADR-0007.

## Ideas not decided yet

**Writing and editing**
- Thai word-by-word cursor moves and deletion in both editors with `Intl.Segmenter` (S–M). Check CodeMirror #686 first.
- Remember each page's Blocks/Plain choice after a restart (S); today it is kept in memory only (`editor/mode.ts`).
- Editing one list item or table cell rewrites the whole list or table in canonical form (M), `packages/editor/src/serialize.ts`.
- "New page from template" command (S), ADR-0051. Duplicate page in the web command palette (S), ADR-0047.
- Shrink pictures before upload (S), ADR-0044.

**History, export and sync**
- Page history for workspace pages: list, diff, restore (M). The server has `GET …/pages/:pageId/revisions`; no client uses it.
- Local version history for Private Space pages (M), kept in the app data folder (ADR-0046), not the notes folder.
- Export a whole workspace as a Markdown ZIP with its attachments (M); download a page with its pictures, or a folder, as a ZIP (S), ADR-0036.
- Workspace → Private Space transfers carry attachments (M); today they warn `attachments_stay_in_workspace`.
- A tested guide for keeping a Private Space in Syncthing or iCloud (S), or sync through your own server (L).
- Offline workspace pages: cache opened pages and queue edits (L), ADR-0005.

**Search**
- Folder, tag and workspace filters; workspace pages in desktop search; better ranking on the server (M).

**Workspaces and teams**
- Live change hints over SSE in the desktop app instead of polling every 5 s (M), ADR-0041 rule 13.
- Presence that says "is editing" rather than "has it open" (S), ADR-0041.
- Today (daily note) in workspaces (M), ADR-0050.
- Share pages in the reader's language and share-link extras (M), ADR-0023. Workspace management extras (M), ADR-0024 and ADR-0025.
- Link previews in the web app, cards for bare URLs (M), ADR-0020.
- Account linking: the same email through Google and GitHub makes two accounts (M), ADR-0014.
- A table view of a folder's frontmatter, like Notion databases (L). Not asked for; "no databases" is the current position.

**Connected apps (MCP)**
- Connected apps on Windows: a named-pipe transport (M), `crates/thoth-host/src/mcp/socket.rs`.
- The Linux AppImage path: the setup points at a path that changes each run (S), ADR-0021.
- Proposals for workspace pages, re-run after a conflict, `list_changed`, peer credentials (M), ADR-0048 and ADR-0021.

**Desktop app**
- Clicking a system notification opens the item (S), ADR-0018. Notification plugin 2.5.1 → 2.8.0 (S).
- Window size and place restored at start, macOS Window menu items (M), ADR-0019.
- Split view extras and a "start on Home" setting (M), ADR-0029 and ADR-0030.
- Linux keeps server sign-ins only until a restart (keyutils); a Secret Service backend needs a decision (S).
- Startup transfer recovery does not retry after signing in (S), `VaultHost.tsx`.
- A startup sweep for leftover `thoth-import-*` temp folders (S).
- Import speed and memory: batched commits, streaming CSV (M), implementation-plan.md.
- A first-run tour in the web app (S), ADR-0032.
- A neighbourhood graph picture in Connections (M), ADR-0045.

**Privacy and security**
- A "Where your data goes" section in Settings and the user docs: agent runs, Connected apps, memory (S).
- Log redaction: `app_location` should keep only `/assets/` paths and refuse `..` (S), `crates/thoth-host/src/diagnostics.rs`.
- Desktop security residuals from the 2026-10-21 review (M), implementation-plan.md §5.
- The search-index cleanup and a privacy note about the index in the app data folder (S), ADR-0046.

**Quality**
- A benchmark with 10k and 50k-page Private Spaces and a CI budget; a bundle-size budget; a typing-latency test (M).
- Checks in a real window that no person has done yet (S), listed in the ADRs and implementation-plan.md.
- Inline suggestions as you type (bring your own key) (M): researched, no decision.

## Waiting on the owner

- Apply to SignPath (Windows signing, free); Apple signing later (`docs/deploy/signpath.md`).
- Open GitHub Sponsors, then add `.github/FUNDING.yml`.
- A larger real Notion export, to test the importer (and Notion HTML import).
- A native read of the Thai text (`// REVIEW`, `<!-- REVIEW -->`), the AUR account, the winget CLA.
- Accept the ADRs still marked Proposed (`docs/adr/README.md`).
- Decisions in the content-model ADRs' open questions (ADR-0001 to 0006, 0008).
- Issue templates and an automatic DCO sign-off check (S) after a yes.
