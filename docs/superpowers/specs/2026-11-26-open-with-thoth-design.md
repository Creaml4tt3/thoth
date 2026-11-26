# Open With Thoth: open any Markdown file

- **Date:** 2026-11-26
- **Owner's request (2026-11-25):** right-click a `.md` file, Open With → Thoth, and read it. Today Thoth is not in the
  menu, and forcing it opens Thoth without the file. Ships first, as **0.12.3**, before the second-brain work.
- **Owner's choice:** a file outside the Private Spaces opens in its own window where it can be read *and edited*
  (option A below).

## Why it fails today

- The bundle declares no file types (`tauri.conf.json` has no `fileAssociations`), so the OS does not offer Thoth.
- The app never handles the file it is given: no `RunEvent::Opened` (macOS) in `apps/desktop/src-tauri/src/lib.rs`
  `.run(…)`, and no path read from the start arguments (Windows, Linux).
- The host opens only folders the user picked (`vault_allowed`), and opening one writes `.thoth/` into it.

## Goals, non-goals, anti-goals

- Goal: any `.md` / `.markdown` file opens in Thoth in about a second, from Open With, a double-click (when the user
  made Thoth the default) or a drop on the Dock icon.
- Non-goals: making Thoth the default `.md` app; other file types; resolving `[[links]]` or showing relative images
  in a loose file (they show as unresolved links and image placeholders; later, if asked).
- Anti-goals: writing `.thoth/`, an index or anything else next to a loose file; letting the window read any file
  other than the one the OS handed over; losing an edit when another app changes the file.

## Approaches

- **A, picked: a window for just that file.** Thoth's page view and editor (Blocks or Plain), saving back to the same
  file; a button "Open its folder as a Private Space". Nothing is written beside it.
- B: open the file's folder as a Private Space. Least code, but one file from Downloads indexes all of Downloads and
  leaves `.thoth/` there.
- C: A, read-only. Smaller, but editing is the next thing anyone tries.

## Design

1. **Show up in Open With.** `bundle.fileAssociations`: extensions `md`, `markdown`; name "Markdown document";
   role Editor; rank Alternate on macOS (offered, never the default unless the user picks it). Windows gets the same
   from the installer's registry entries.
2. **Receive the file.**
   - macOS: handle `RunEvent::Opened { urls }` (file URLs only). It can arrive before the first window exists;
     paths wait in a queue until the host is ready.
   - Windows and Linux: read paths from the start arguments, and add `tauri-plugin-single-instance` so a second
     launch hands its arguments to the running app instead of starting another.
   - Each path is canonicalised and must be an existing regular file ending in `.md` / `.markdown`, at most the
     size the vault already allows for a page. Anything else is ignored (logged by count, never by path).
3. **Route it.**
   - Inside a Private Space Thoth has opened before (`host.recent()`, prefix match on canonical roots, deepest root
     wins): open it as a tab in the window that has that Space, or in a new window on that Space (the existing
     `window_open` with `tabs`), and focus it.
   - Anywhere else: a **file window**.
   - The same loose file twice focuses its existing window.
4. **The file window.**
   - A new window kind, label `file-<n>`, page `index.html?window=file-<n>&file=<token>`. The **host** maps the token
     to the path; the page never names a path, so it can never ask for another file.
   - Host commands for that window only: `file.read(token)` → `{source, hash, editable, mtimeMs}` and
     `file.write(token, source, expectedHash)` (compare-and-swap, atomic replace like page writes). That is the
     whole `PageStore`: `writeCopy` writes `<name> (conflict <date>).md` next to the file, the only other file it
     may create, and only when the user picks Keep both.
   - The page renders `PageFrame` with that store, `loadLinks: null`, no media, crumbs `[folder name, file name]`,
     the Blocks/Plain switch (mode remembered per path). Changes made elsewhere are checked when the window gains
     focus (`checkTick`); a conflict opens the existing conflict dialog.
   - Header action **Open its folder as a Private Space**: the folder joins the allowed roots as if picked, and
     opens in this window as a Space with this file's tab (the usual first-open questions apply).
   - Closing the window forgets the token. Counts toward `MAX_WINDOWS`.
5. **Docs and decision record.** ADR-0057 "Opening Markdown files from the system" (amends the host's "only picked
   folders" rule: one OS-given file, read and written through a token, nothing else). User docs: a short "Open a
   Markdown file" section in English and Thai. The second-brain ADR moves to 0058.

## Left to the builder

- Exact window size and header look (follow PageView and Papyrus Black).
- Test shape; at minimum: path checks (non-file, wrong extension, symlink to outside, too big), routing (inside a
  known Space, deepest root, loose), token scope (a token from one window refused in another), the CAS write, and a
  desktop test that the file window renders and saves.
- Manual check on macOS (Finder Open With, Dock drop, cold start and while running) and on Windows if a machine is
  available; say plainly if Windows is untested.

## Release

0.12.3, a feature-sized patch the owner asked for; the owner approves the release as usual.
