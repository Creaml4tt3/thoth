# Open With Thoth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any `.md` / `.markdown` file opens in Thoth from the system (Open With, Dock drop, double-click when Thoth is the default): as a tab when it is inside a Private Space Thoth knows, otherwise in a file window where it can be read and edited, with nothing written beside it.

**Architecture:** The Tauri shell receives file paths (macOS `RunEvent::Opened`; start arguments plus the single-instance plugin on Windows and Linux) and hands them to a new host module `opened.rs`, which checks each path and routes it. Space files open through the existing window launch (a new `page` launch parameter, or an event to the window that already has the Space). Loose files get a `file-<id>` window that knows only a **token**; the host maps the token to the path, and four `opened.*` commands read, stat, write (compare-and-swap) and copy that one file. The window renders the shared `PageFrame` with a `PageStore` over those commands.

**Tech Stack:** Rust (thoth-host crate, Tauri 2.12 shell), TypeScript/React (apps/desktop, packages/platform, packages/app-ui), Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-11-26-open-with-thoth-design.md`

## Global Constraints

- Extensions: `md`, `markdown` (case-insensitive). Nothing else is accepted.
- Thoth is offered in Open With but never claims to be the default: macOS rank **Alternate**, role **Editor**.
- Nothing is written beside a loose file except a conflict copy, and only when the user picks Keep both.
- The page never names a path for a loose file: only its token. A token works only for the window it was given to and dies when that window closes.
- File windows get **only** the `opened.*` commands, `window_close`, `file_promote`, event listening, zoom and theme. No vault, fs, sql, agent, server or MCP commands.
- Logs never contain a path or file name: counts and error codes only (as `handle` already does).
- Largest file accepted: **16 MiB** (my call; the vault's 1 GiB `MAX_FILE_BYTES` is far above what the editor handles).
- English and Thai strings; new Thai strings marked `// REVIEW`.
- `MAX_WINDOWS` (8) counts file windows too.
- ADR number: **0057** (the second-brain ADR is 0058).

## Review Focus

1. **A file opened while Thoth is not running** (cold start): the path arrives before the host and first window exist; it must still open, once. → Task 3 test `opened_before_ready_is_queued_then_opened`.
2. **The same file opened twice**: focuses the existing window, never a second one editing the same file. → Task 3 test `same_loose_file_focuses_its_window`.
3. **The file changes or is deleted by another app while open**: conflict dialog on save, "missing" view when deleted, never a silent overwrite. → Task 2 test `write_refuses_stale_hash` and Task 4 test "shows missing after delete".
4. **A path that only looks like Markdown**: a `notes.md` symlink pointing at another file, a folder named `x.md`, a 2 GB file. → Task 1 tests.
5. **A Space whose name is a prefix of another** (`/Notes` vs `/Notes 2`), and nested Spaces: routing picks the deepest real parent. → Task 1 test `route_picks_deepest_root_by_component`.

---

### Task 1: Check and route an opened path (host)

**Files:**
- Create: `crates/thoth-host/src/opened.rs`
- Modify: `crates/thoth-host/src/lib.rs` (add `pub mod opened;`)

**Interfaces:**
- Produces:
  - `pub const MAX_OPENED_BYTES: u64 = 16 * 1024 * 1024;`
  - `pub fn check_opened(path: &Path) -> Option<PathBuf>`: the canonical path when it is an existing regular file, extension `md`/`markdown` (any case) **after** canonicalising, and at most `MAX_OPENED_BYTES`; else `None`.
  - `pub enum Route { Space { root: String, page: String }, Loose(PathBuf) }`
  - `pub fn route(file: &Path, roots: &[String]) -> Route`: `Space` when `file` is under one of `roots` by whole path components (deepest root wins); `page` is the `/`-separated relative path. Hidden or `.thoth` parts in `page` still route to `Space` (the Space decides what it shows).

- [ ] **Step 1: Write the failing tests** in `opened.rs` `#[cfg(test)] mod tests` (temp dirs via `tempfile`, as other host tests do):
  - `check_accepts_md_and_markdown_any_case` (`a.md`, `b.MARKDOWN` → `Some`)
  - `check_refuses_other_extensions_and_folders` (`a.txt` → `None`; a directory named `x.md` → `None`; missing path → `None`)
  - `check_follows_symlink_then_checks_target` (unix only: `link.md` → `secret.txt` gives `None`; `link.md` → `real.md` gives `Some(canonical real.md)`)
  - `check_refuses_files_over_16_mib` (file of `MAX_OPENED_BYTES + 1` via `set_len` → `None`)
  - `route_picks_deepest_root_by_component`: roots `["/x/Notes", "/x/Notes/Work"]`; `/x/Notes/Work/a.md` → `Space{root:"/x/Notes/Work", page:"a.md"}`; `/x/Notes 2/a.md` → `Loose`; `/x/Notes/sub/b.md` → `Space{root:"/x/Notes", page:"sub/b.md"}`
- [ ] **Step 2: Run** `cargo test -p thoth-host opened::` → FAIL (module missing).
- [ ] **Step 3: Implement** `check_opened` (std `canonicalize`, `metadata`) and `route` (`Path::strip_prefix` on `PathBuf::from(root)`, pick the longest matching root).
- [ ] **Step 4: Run** `cargo test -p thoth-host opened::` → PASS.
- [ ] **Step 5: Commit** `feat(host): check and route a file the system opened`

---

### Task 2: Tokens and the `opened.*` commands (host + contract)

**Files:**
- Modify: `crates/thoth-host/src/opened.rs`, `crates/thoth-host/src/lib.rs` (`COMMANDS`, `call_as` arms, `State`, `release`/`detach`)
- Modify: `packages/platform/src/ipc.ts` (contract types), `packages/platform/src/remote.ts` and `packages/platform/src/index.ts` (`Platform.openedFile?`)
- Modify: `apps/desktop/src-tauri/build.rs` `TAURI_COMMANDS` (regenerates `permissions/autogenerated/opened_*.toml`)

**Interfaces:**
- Consumes: `check_opened` (Task 1).
- Produces (host, Rust):
  - `State.opened: HashMap<String, Opened>` with `struct Opened { owner: String, path: PathBuf }`; token from `handles::new_handle("file")`.
  - `pub fn grant_file(&self, owner: &str, path: PathBuf) -> String` and `pub fn file_owner(&self, path: &Path) -> Option<String>` (who already has it open); `pub fn take_file(&self, owner: &str, token: &str) -> Option<PathBuf>` (for `file_promote`, removes it).
  - `detach(owner)` also drops that owner's tokens.
- Produces (contract, `ipc.ts`), every one refused with `NOT_ALLOWED` unless the token's `owner` is the calling window:
  - `"opened.stat": { args: { token: string }; result: { name: string; folder: string; mtimeMs: number; size: number } }` (`folder` = the parent folder's *name* only)
  - `"opened.read": { args: { token: string }; result: Uint8Array }` (raw bytes; reply bytes like `fs.read`)
  - `"opened.write": { args: { token: string; expectedHash: string }; bytes; result: { hash: string } }`: under `self.replace` lock, `CONFLICT` when the file's current sha256 (`hex_digest`) is not `expectedHash` or the file is gone; writes a temp file in the same folder (`.<name>.thoth-tmp-<rand>`, exclusive, `full_sync`), then `rename` over the file; size over `MAX_OPENED_BYTES` → `BAD_ARGUMENT`.
  - `"opened.copy": { args: { token: string; name: string }; bytes; result: { name: string } }`: exclusive create of `name` in the same folder; `name` must be one path segment ending `.md`, no `/`, `\`, `..`, NUL; `EEXIST` when taken.
- Produces (TS): `Platform.openedFile?: { stat(token): Promise<…>; read(token): Promise<Uint8Array>; write(token, bytes, expectedHash): Promise<{hash}>; copy(token, name, bytes): Promise<{name}> }` in `remote.ts` over the four commands.

- [ ] **Step 1: Write the failing host tests** (in `lib.rs` tests next to the vault ones, using the test `Host`):
  - `opened_read_and_stat_for_owner_only`: `grant_file("file-a", p)`; `call_as("file-a","opened.read",{token})` returns the bytes; `call_as("file-b", …)` → `NOT_ALLOWED`; `opened.stat` gives `name` and folder *name*, never the full path (assert the JSON text does not contain the temp dir path).
  - `write_refuses_stale_hash`: write with the right hash → new hash equals `hex_digest(new bytes)`; again with the old hash → `CONFLICT`; file deleted → `CONFLICT`; no `.thoth-tmp-` file left in the folder after either.
  - `copy_is_exclusive_and_one_segment`: `"a (conflict).md"` ok; same again → `EEXIST`; `"../x.md"`, `"x.txt"`, `"a/b.md"` → `BAD_ARGUMENT`.
  - `release_drops_tokens`: after `release("file-a")`, `opened.read` → `NOT_ALLOWED`.
- [ ] **Step 2: Run** `cargo test -p thoth-host opened` → FAIL.
- [ ] **Step 3: Implement** the state, the four arms in `call_as` (add `"opened.write" | "opened.copy"` to `wants_bytes`), `grant_file`/`file_owner`/`take_file`, and the token cleanup in `detach`. Add the four names to `COMMANDS` and to `TAURI_COMMANDS` in `build.rs`.
- [ ] **Step 4: Run** `cargo test -p thoth-host` and `cargo test -p thoth-desktop` (the `contract_name` test covers the new names) → PASS.
- [ ] **Step 5: Write the TS contract** in `ipc.ts`, `remote.ts`, `index.ts`; run `pnpm typecheck` → PASS.
- [ ] **Step 6: Commit** `feat(host): opened.* commands for one file the system handed over`

---

### Task 3: Receive files from the system and open windows (shell)

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (`bundle.fileAssociations`)
- Modify: `apps/desktop/src-tauri/Cargo.toml`, root `Cargo.toml` (`tauri-plugin-single-instance`, exact `=2.x.y` pin like the other plugins, a release at least two weeks old that matches tauri 2.12)
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/capabilities/file.json`

**Interfaces:**
- Consumes: `check_opened`, `route`, `Route` (Task 1); `grant_file`, `file_owner`, `take_file` (Task 2); `Host::recent()`; existing `new_window` checks and `WebviewWindowBuilder` setup (factor the builder into `fn build_window(app, label, page, at) -> tauri::Result<WebviewWindow>` shared by `window_open` and the new code).
- Produces:
  - `static OPENED: Mutex<Vec<PathBuf>>` (queue until the host is set and the main window exists).
  - `fn open_paths(app: &AppHandle, paths: Vec<PathBuf>)`: for each `check_opened` path:
    - `Route::Space{root,page}` → if a window has that root open (`host.owner_of_root(&root)`, a new `Host` helper over `state.vaults`), emit `thoth:open-page` `{root, page}` to that window and focus it; else build `space-<16>` with page `index.html?window=space-…&root=<root>&page=<page>`.
    - `Route::Loose(path)` → `file_owner(path)` → focus that window; else build `file-<16>` with `index.html?window=file-…&file=<token>` after `grant_file`.
    - Over `MAX_WINDOWS`: skip and log the count only.
  - `RunEvent::Opened { urls }` (macOS): `file://` URLs → `to_file_path()` → `open_paths`.
  - At setup: `std::env::args_os().skip(1)` (not macOS) → queue. `tauri_plugin_single_instance::init(|app, argv, _cwd| open_paths(app, argv[1..] as paths))` registered first, `#[cfg(not(target_os = "macos"))]`.
  - New shell command `file_promote` (in `SHELL_COMMANDS`): for the calling `file-*` window, `take_file` → parent folder joins `picked_vaults` (new `Host::allow_root(path)`), builds a `space-*` window with `root` and `page` = file name, then closes the caller.
  - `is_window_label` accepts `file-` + 1–32 `[a-z0-9]`.
  - `capabilities/file.json`: windows `["file-*"]`; permissions only `core:event:allow-listen`, `core:event:allow-unlisten`, `core:webview:allow-set-webview-zoom`, `core:window:allow-set-theme`, `allow-opened-stat`, `allow-opened-read`, `allow-opened-write`, `allow-opened-copy`, `allow-window-close`, `allow-file-promote`. `main.json` does **not** gain `opened-*`.
  - `tauri.conf.json`: `"fileAssociations": [{ "ext": ["md", "markdown"], "name": "Markdown document", "role": "Editor", "rank": "Alternate", "mimeType": "text/markdown" }]` (check field names against `gen/schemas`; if `rank` is not in 2.12's schema, add `LSHandlerRank` = `Alternate` for the document type in `Info.plist` instead).

- [ ] **Step 1: Write the failing tests** in `lib.rs` tests:
  - `file_window_label_rules` (`file-abc123` ok; `file-`, `file-ABC`, `files-a` refused).
  - `file_capability_is_least_privilege`: parse `capabilities/file.json`; windows exactly `["file-*"]`; every permission in the allowed list above; none starts with `allow-vault`, `allow-fs`, `allow-sql`, `allow-agent`, `allow-server`, `allow-api`, `allow-mcp`. And `main.json` has no `allow-opened-`.
  - `file_associations_offer_md_without_owning_it`: `tauri.conf.json` has `md` and `markdown`, role `Editor`, and is not `Owner`/`Default` rank.
  - `opened_before_ready_is_queued_then_opened` and `same_loose_file_focuses_its_window`: test `fn plan_opens(paths, recent, open_roots, open_files) -> Vec<Action>` (a pure function `open_paths` calls; `enum Action { Focus(String), Emit{window, root, page}, NewSpace{root, page}, NewFile(PathBuf) }`): a queued path yields one action once; a path already open yields `Focus`.
- [ ] **Step 2: Run** `cargo test -p thoth-desktop` → FAIL.
- [ ] **Step 3: Implement** `plan_opens`, `open_paths`, the queue (drained at the end of `setup` and on `RunEvent::Ready`), the single-instance and `Opened` handlers, `file_promote`, `build_window`, the capability and the config.
- [ ] **Step 4: Run** `cargo test -p thoth-desktop` and `cargo clippy -p thoth-desktop -- -D warnings` → PASS.
- [ ] **Step 5: Commit** `feat(desktop): open Markdown files from the system`

---

### Task 4: The file window and opening a page from launch (web side)

**Files:**
- Modify: `apps/desktop/src/app/windows.ts` (`Launch` gains `file: string | null`, `page: string | null`; `readLaunch` accepts `file-` ids with a `file` token)
- Modify: `apps/desktop/src/main.tsx` (a `file-*` launch renders `FileWindow` instead of `App`)
- Modify: `apps/desktop/src/app/App.tsx` (a `space-*` launch with `page` opens that page as its tab once the Space is open; any window listens for `thoth:open-page` and opens `page` when `root` is its Space)
- Create: `apps/desktop/src/features/opened/opened-store.ts`, `apps/desktop/src/features/opened/FileWindow.tsx`
- Modify: `apps/desktop/src/strings/en.ts`, `th.ts` (`opened` group)
- Modify: `packages/platform/src/tauri.ts` (`windows.promoteFile(): Promise<void>` → `file_promote`; `onOpenPage(listener)` over `thoth:open-page`)
- Test: `apps/desktop/test/windows.test.ts` (extend or create), `apps/desktop/test/opened-store.test.ts`, `apps/desktop/test/file-window.test.tsx`

**Interfaces:**
- Consumes: `Platform.openedFile` (Task 2); `file_promote`, `thoth:open-page` (Task 3); `PageFrame`, `PageStore`, `conflictCopyPath` from app-ui; `sha256Hex` from `@thoth/domain`, `decodeText` from `@thoth/content`.
- Produces:
  - `openedFileStore(files: NonNullable<Platform["openedFile"]>, token: string, name: string): PageStore` — `kind: "file"`; `read()` → `{source, hash: sha256Hex(bytes), editable, dates: {updated: mtimeMs}}`, `null` on `ENOENT`/`CONFLICT`-gone; `write(source, expected)` → `files.write(...)`, `expected === null` throws (a loose file always exists); `writeCopy` → `files.copy(token, basename(conflictCopyPath(name, now, attempt)), bytes)` retrying on `EEXIST` up to 50; `isConflict` → error code `CONFLICT`.
  - `FileWindow({ platform, token })`: `PageFrame` with that store, `loadLinks: null`, no `media`, `modeKey: { space: "file", page: token-independent key = name + folder }`, crumbs `[folder, name]`, `checkTick` bumped on window focus, `actions` = button **Open its folder as a Private Space** → `platform.windows.promoteFile()`; window title = file name.
  - Strings (`opened`): `openFolder` "Open its folder as a Private Space" / Thai `// REVIEW`; `missingTitle` "This file is gone"; `missingDetail` "It was moved or deleted outside Thoth."; `readOnly` "This file can't be edited here (it isn't UTF-8 text)."

- [ ] **Step 1: Write the failing tests**:
  - `windows.test.ts`: `readLaunch("?window=file-abc&file=tok")` → `{id:"file-abc", file:"tok", root:null, tabs:null, page:null}`; `?window=file-abc` without `file` → main; `?window=space-a&root=/r&page=a/b.md` → `page:"a/b.md"`.
  - `opened-store.test.ts` (fake `openedFile`): read gives the sha256 of the bytes; write passes `expectedHash`; a `CONFLICT` error is `isConflict`; `writeCopy` retries after one `EEXIST` and returns the second name; read after a `NOT_FOUND` gives `null`.
  - `file-window.test.tsx` (render with a fake platform, as `open-edit.test.tsx` does): shows the file's heading text and the crumbs `[folder, name]`; typing then saving calls `write` once with the read hash; **shows missing after delete** (fake read starts returning `NOT_FOUND`, focus event → missing title); the Open-folder button calls `promoteFile`; no `vault.*` or `fs.*` call is ever made (fake throws on them).
  - `App` test (extend `open-edit.test.tsx` or `editor-views.test.tsx`): an `onOpenPage` event for this window's root opens that page as the active tab; one for another root does nothing.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/test/windows.test.ts apps/desktop/test/opened-store.test.ts apps/desktop/test/file-window.test.tsx apps/desktop/test/open-edit.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the launch fields, `openedFileStore`, `FileWindow`, the `main.tsx` switch, the App `page` launch and `onOpenPage` listener, the strings and the tauri platform methods.
- [ ] **Step 4: Run** `pnpm vitest run apps/desktop` and `pnpm typecheck` and `pnpm check` → PASS.
- [ ] **Step 5: Commit** `feat(desktop): a window for one Markdown file`

---

### Task 5: Decision record, docs, backlog, manual check

**Files:**
- Create: `docs/adr/0057-opening-markdown-files-from-the-system.md` (context: the bug; decision: the five rules from Global Constraints plus routing; consequences: links and relative images not resolved in a file window; Windows untested unless checked)
- Modify: `docs/adr/README.md` (index line)
- Modify: `docs/user/using-thoth.md` and `docs/user/using-thoth.th.md` ("Open a Markdown file": Open With → Thoth; inside a Space it opens there; elsewhere it opens on its own, nothing is added next to it; the Open its folder button; how to make Thoth the default, if wanted, through Finder's Get Info / Windows' Open with → Choose another app)
- Modify: `docs/backlog.md` (delete the "Open a `.md` file with Thoth" entry)

- [ ] **Step 1:** Write the ADR, docs and backlog change.
- [ ] **Step 2: Manual check on macOS** with a dev build (`pnpm --filter @thoth/desktop tauri build --debug`, then run the built `.app` so Launch Services sees the document types): Finder → a `.md` in Downloads → Open With → Thoth (cold start, then while running); the same file again focuses; a `.md` inside a known Space opens as a tab there; Dock drop; edit and save, then change the file in another editor and save again → conflict dialog; nothing new in Downloads except a conflict copy after Keep both. Note each result in the PR body. Windows: say plainly untested unless a machine is available.
- [ ] **Step 3: Run the full checks**: `cargo test --workspace`, `pnpm test`, `pnpm typecheck`, `pnpm check` → PASS.
- [ ] **Step 4: Commit** `docs: opening Markdown files from the system (ADR-0057)`

---

## Release (not part of the tasks)

Version 0.12.3 bump, changelog and tag follow the usual release steps **after** the owner approves; nothing is pushed, merged or tagged without asking.
