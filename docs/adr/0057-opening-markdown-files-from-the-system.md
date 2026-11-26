# ADR-0057: Opening Markdown files from the system

- **Status:** Accepted 2026-11-26.
- **Date:** 2026-11-26
- **Deciders:** project owner (asked for it, chose a window that can edit a loose file); the details are this ADR's
  (`docs/superpowers/specs/2026-11-26-open-with-thoth-design.md`).
- **Amends:** the host's rule that only folders the user picked are opened (ADR-0008): one file the system handed
  over is opened too, on its own terms below.

## Context

The owner right-clicked a `.md` file, and Thoth was not in Open With; forcing it opened Thoth without the file. The
bundle declared no document types and the shell never handled a file it was given. Opening the file's folder as a
Private Space would index all of, say, Downloads and leave a `.thoth/` folder there.

## Decision

1. **Offered, never claimed.** The bundle declares `md` and `markdown` (`text/markdown`,
   `net.daringfireball.markdown`), role Editor, rank **Alternate**: Thoth appears in Open With and takes drops, and
   is the default only if the person makes it so.
2. **Received.** macOS: `RunEvent::Opened`. Windows and Linux: the start arguments (read in `main.rs`, so `lib.rs`
   still reads no argument) and `tauri-plugin-single-instance`, which hands a second launch's arguments to the running
   app. Files that arrive before the app is ready wait until `RunEvent::Ready`.
3. **Checked.** A path opens only if, after links are followed, it is an existing regular file named `.md` or
   `.markdown` of at most 16 MiB. Logs carry counts and error codes, never a path or a name.
4. **Routed.** A file inside a Private Space Thoth has opened before (by whole path parts, the deepest Space wins)
   opens as a tab: in the window that has that Space open (event `thoth:open-page`), or in a new window on it. Any
   other file opens in a **file window** (`file-*`). The same file again focuses its window. Windows still stop at
   eight.
5. **A file window holds a token, never a path.** The host maps the token to the file for that window only and drops
   it when the window closes. Its four commands (`opened.stat`, `opened.read`, `opened.write`, `opened.copy`) are
   granted to `file-*` windows only (`capabilities/file.json`), and Space windows are never granted them. `stat` gives
   the folder's *name*, not its path.
6. **Nothing beside the file but a conflict copy.** Writes are compare-and-swap on the file's sha256 and replace it
   through a temporary file in the same folder. Keep both writes one new `.md` file next to it, never over another.
   No index and no `.thoth/` folder.
7. **"Open its folder as a Private Space"** (`file_promote`, shell command, `file-*` only): the window gives back its
   token, the folder is allowed as if picked, a Space window opens on it with that file's tab, and the file window
   closes.

## Consequences

- In a file window `[[links]]` stay unresolved and relative images show placeholders: there is no Space to resolve
  them in. Opening the folder as a Private Space gives both.
- Windows and Linux file opening is built on the plugin's documented behaviour and the start arguments; it was checked
  by tests only, not on a Windows or Linux machine, until someone runs it there.
- The single-instance plugin also stops a second copy of Thoth on Windows and Linux for any launch, as macOS already
  does.

## Open questions

- Resolving relative images next to a loose file (read-only, through the token) if people ask for it.
