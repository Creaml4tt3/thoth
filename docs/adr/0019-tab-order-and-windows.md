# ADR-0019: Tab order and windows

- **Status:** Proposed
- **Date:** 2026-10-25
- **Deciders:** project owner (to accept)
- **Refines:** ADR-0016 rule 5 (tabs). Builds on ADR-0001 (compare-and-swap writes, the journal), ADR-0007 (agent
  runs) and ADR-0008 (the Rust-hosted ports, the capability).

## Context

The owner asked (Track 5, 2026-10-25) for tabs that can be dragged to a new place, and on the desktop dragged out into
a new window on the same Private Space, with the whole shell. Each window keeps and restores its own tabs, and an edit
in one window shows in the others. The web client gets reordering only: a browser window per tab is the browser's job.

Tabs today (ADR-0016 rule 5) are a list per window, stored per Private Space in the webview's localStorage
(`thoth.desktop.tabs.<root>`) and per browser on the web. The list is already ordered; nothing could change the order.

What the desktop runtime does today, checked in the code before deciding:

- There is one `Host` per app process (`crates/thoth-host`), shared by every webview. Its state is keyed by opaque
  handles, not by window. Each `vault.open` makes a new handle with its own SQLite connection (WAL, 5 s busy timeout)
  and its own watcher. Two opens of one folder are not merged and take no lock.
- The domain runs in the webview (ADR-0008 option (a)). `Vault`, the reconciler, `AgentHub`, `TransferEngine` and the
  import service are built once per webview, in `VaultHost`.
- Several start-up steps assume they are the only session on a folder:
  - `Vault.open` runs journal recovery, which deletes every `.thoth/tmp/*.tmp` and clears the journal;
  - `AgentHub.recover` marks every unfinished run it does not run itself `interrupted`;
  - `TransferEngine.recover` rolls back or finishes every unfinished transfer;
  - the import wizard offers every unfinished job for resume.

  Run in a second window while the first is working, each of these would break the first window's work in flight.
- Compare-and-swap writes (ADR-0001 rule 5) check the hash, write a temp file, check again and rename. Between the
  last check and the rename there is a small window. ADR-0001 accepts it for editors outside Thoth. Two Thoth windows
  saving one page could both pass the check, and the second rename would replace the first: a lost write.
- The capability (`capabilities/main.json`) grants Thoth's commands to the window `main` only. A test refuses any
  permission that is not a Thoth command or event listening, so the webview cannot get Tauri's window permissions.
- No code handles a window closing. The host shuts down (watchers stopped, agent runs killed and deleted) only when the
  app exits. The macOS menu has no Close Window item, so Cmd+W reaches the page and closes a tab (ADR-0016 rule 5).

## Decision

### Tab order

1. The order of a window's tabs is the order of its stored tab list (the ADR-0016 storage, unchanged), saved on every
   change and restored with the tabs. Moving a tab keeps the current tab current and keeps every tab's id.
2. **Pointer.** A press on a tab that moves 5 px becomes a drag, with mouse or pen only (touch scrolls the bar).
   - The tab stays in place, faded, and a picture of it follows the pointer, as in the page trees. (A tab that
     followed the pointer itself would hide the line where it lands.)
   - An accent line (`--thoth-drop-indicator`) shows where it will land.
   - An overflowing bar scrolls when the pointer nears one of its ends.
   - Escape, a cancelled pointer or the window losing focus puts the tab back.
   - On release, the tabs that changed place slide there (FLIP). Only `transform` animates, over `--thoth-dur-fast`
     with `--thoth-ease-out`. There is no motion under reduced motion.
3. **Keyboard.** Alt/Option+Shift+Left/Right moves the focused tab one place. It stops at the ends and does not wrap.
   Focus stays on the tab.
   - The key is in the shortcut table, in a new scope, `tabs`. It is not global, because Option+Shift+Left/Right
     selects by word in text.
   - The tab's menu (right click, the Menu key, Shift+F10) has Move tab left, Move tab right, Move tab to new window
     (desktop only) and Close tab.
   - The palette has Move tab left and Move tab right, and on the desktop Move tab to new window.
   - Moves made with the keyboard never animate.
   - Every move is announced in a polite live region.

### Windows on one Private Space

4. **One host, one handle per window.** Every window is a full shell (sidebar, tabs, mascot) with its own `Vault` over
   its own handle to the same folder. That means its own index connection and its own watcher, in the one host
   process. The files stay the truth. Each window's watcher triggers its own reconcile, so an edit made in one window
   shows in the others.
5. **Recovery runs for the first window only.** `vault.open` answers `shared: true` when another handle has the folder
   open. A shared window skips:
   - journal recovery (`Vault.open({ recover: false })`);
   - agent-run recovery and the sweep of run folders;
   - transfer recovery.

   Recovery is for what a crash left. With another window open, what it would recover is that window's work in flight.
   In practice the first window opens at start, so ADR-0001 rule 7 ("on startup") holds as before.
6. **Index transactions take the write lock up front** (`BEGIN IMMEDIATE`). One window's transaction then waits for
   the other's, within the 5 s busy timeout, rather than failing on a stale snapshot. The index stays a cache that can
   be rebuilt from the files.
7. **Compare-and-swap is one step in the host.** `fs.rename` takes an optional `replaceHash`. The host replaces the
   target only while its bytes still have that hash, and checks and renames under one host-wide lock. Otherwise it
   answers `CONFLICT` and nothing moves. `writeFileAtomic` uses it, and a conflict is a `ConflictError`, shown by the
   existing conflict dialog. Two windows saving the same page therefore give one write and one conflict, never a lost
   write. Editors outside Thoth keep the narrow window that ADR-0001 accepts.
8. **Each window owns what it starts.**
   - **Agent runs.** A run belongs to the window whose mascot started it, which streams it, reviews it and applies it.
     The host records which window created each run. Agent safety is unchanged: the same argument policy, staging,
     review and compare-and-swap apply.
   - **Imports.** An import belongs to the window that started it. An unfinished import is offered for resume only
     while the window is the only one on its Private Space (`vault.shared`), since it may still be running in another.
   - **Transfers.** A transfer belongs to the window that started it. A window closed during a transfer is treated
     like a crash of that window, and recovery settles the transfer the next time the Private Space opens alone
     (ADR-0006 §7).
   - **Other windows.** They see the results through the files and the index: pages, run records in the history, the
     tree. They do not see live progress.
9. **A window takes its own with it.** The host records which window opened each vault handle and created each agent
   run. When a window is destroyed, the shell calls `Host::release(window)`:
   - that window's handles close, and so do their watchers;
   - its agent runs are cancelled and their folders deleted, as quitting does for all of them.

   Other windows' handles and runs are untouched.

### Window lifecycle

10. **Thoth's own windows only.** The first window is `main`. Every other window is `space-` followed by 1 to 32
    lowercase letters or digits.
    - The shell's own command `window_open` makes such a window only on a Private Space in the host's recent list.
    - It always loads the app's own page, `index.html?window=…&root=…&tabs=…`, with the values escaped.
    - It places the window at the drop point when there is one.
    - The capability names `main` and `space-*`, with the same Thoth-only permissions, including `window_open` and
      `window_close`.
11. **Dragging out** (desktop only) is a release 48 px or more below the bar, or outside the window.
    - The new window opens there with that tab, and the tab leaves the first window only once the window has opened.
    - The current tab's edits are written first.
    - A window's only tab cannot leave.
    - After a move from the keyboard or the menu, focus goes to the tab that is now current.
12. **Restore.**
    - Each window saves its tabs under its own key (`thoth.desktop.tabs.<root>#<id>`; `main` keeps the old key).
    - The app keeps a list of the windows it opened on each Private Space (`thoth.desktop.windows`).
    - When the main window opens a Private Space and no other window has it open, it reopens the listed windows, each
      with its own tabs.
    - A window the user closes while the app runs is forgotten, with its tabs: the shell sends `thoth:window-closed`
      to the others, but not while the app quits.
    - Quitting forgets nothing, so the windows open at quit come back. Nothing opens a Private Space by itself at
      start (as before): the windows come back when the user opens it.
13. **Closing.**
    - Cmd/Ctrl+W closes the current tab. On a window's last tab it closes the window when another window is open, and
      leaves an empty tab in the last window, as before, since closing the last window quits the app.
    - The window's close button always closes it.
    - When the main window is closed this way, it is saved with one empty tab.
    - A new window gets the focus.

## Consequences

- Positive:
  - Two windows can safely be open on one folder. The rules above make every start-up step and every save safe with
    more than one window.
  - The compare-and-swap is now stronger for every write that goes through the host, with one window or many.
  - No locked decision changes.
  - The webview still gets no Tauri window permission: windows are made by the shell, under its own rules.
- Negative:
  - Every window indexes and watches the folder itself, so a change is reconciled once per window.
  - A big first reconcile in one window can make another window's write wait, and fail after the 5 s busy timeout.
  - Closing a window that is running an agent ends that run, as quitting does.
  - Unsaved typing in a window closed with its close button (at most the autosave delay, 1 s) is lost, as when
    quitting today.
  - Window sizes and positions are not restored.
  - A window does not see another window's live agent run, import or transfer progress.
  - A webview that crashes on its own leaves its in-flight work until the Private Space is next opened alone.
- Follow-up:
  - `Host::call_as` and `Host::release`, plus the shell commands `window_open` and `window_close`
    (`apps/desktop/src-tauri/src/lib.rs`) and the host command `vault.shared`.
  - `fs.rename` with `replaceHash` in both port implementations and the port contract.
  - `tests/ports/two-windows.test.ts` (Node and Rust hosts), `crates/thoth-host/tests/multi_window.rs` and the shell
    tests.
  - The bridge's windows (`packages/platform/src/http.ts`) so e2e can drive a second window.

## Alternatives considered

- **One `Vault` per Private Space, other windows as its clients.** This is preferred in principle: one index
  connection, one watcher, one owner of recovery. But the domain lives in the webview (ADR-0008 option (a)), so it
  would need one of:
  - a message bridge between webviews for the whole `Vault`, `AgentHub`, transfer and import API, with the main window
    as a server that other windows break when it closes;
  - moving the domain into the Rust host, which reopens ADR-0008.

  Neither is cheap. It becomes the better choice if the domain ever moves into the host.
- **A second app process per window.** Two hosts would mean two agent policies, two recent lists and two keychain
  users, with no shared lock for compare-and-swap.
- **HTML5 drag and drop, as the page trees use.** A drop outside the window ends with `dragend` and no useful point in
  WebKit, and the browser's own drag picture cannot say "new window". Auto-scroll and the line need the same events
  anyway. Pointer events give all of these. The trees keep HTML5 drag and drop.
- **Global Alt+Shift+Left/Right for the current tab.** Refused: in the editor it selects by word.

## Spec references

Section 2 (Markdown as the source of truth, compare-and-swap writes), 6.2, 7 (editor and tabs), 10 (agents), 13 (web
client), 14.11 (browser contexts spawn nothing).

## Open questions

1. **Owner acceptance** of the whole ADR, in particular rule 4 (one handle per window) over one shared `Vault`.
   Blocks: nothing built; it is in place behind the desktop shell.
2. **Closing a window with a running agent.** Should it ask first? Today the run ends, as at quit. Blocks: nothing.
3. **Window sizes and positions** on restore (Tauri's window-state plugin, pinned). Not done.
4. **macOS menu.** Should there be "New Window" and "Close Window" items and a window list in the Window menu?
   Cmd+N is New page and Cmd+W must stay the page's key. Not done.
5. **Live state across windows.** Should one window show another window's running agent, import or transfer? Today
   each window shows its own.
6. **Not yet checked in a real window:**
   - that WKWebView delivers the pointer release outside the window (the e2e suite drives Chromium);
   - the drop point on a second display;
   - the look and feel of the drag in light and dark;
   - the Thai strings marked `REVIEW`.
