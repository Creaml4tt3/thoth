# ADR-0036: Download a page as Markdown

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** owner (rules 1, 4 and 5); implementation agent (the rest, marked "(this ADR)")
- **Refines:** ADR-0008 (host commands granted by name), ADR-0009 (export restriction), ADR-0028 (page images).

## Context

People want a page as a plain `.md` file to send or keep elsewhere. A Private Space page already is a file, but finding
it in Finder takes steps, and a workspace page has no file at all.

## Decision

1. **"Download as Markdown" in the Private Space and in workspaces** (owner): a button in the page header and
   "Download as Markdown…" in a page's right-click menu (not a folder's). Viewers can use it too.
2. **The file** (this ADR): named after the page (its title, cleaned to one name every system accepts, at most 120
   characters, `.md`). A Private Space page is its file exactly as on disk, after pending edits are written. A
   workspace page is its current text from the server, after pending edits are written.
3. **The desktop asks the host** (this ADR): one new command, `file.save { name }` with the bytes, granted by name. The
   host cleans the name, shows the system's "Save as" dialog (Markdown filter) and writes only the path the person
   picked; the webview never names or learns a path. Cancelled: nothing is written and nothing is said. The stdio
   harness saves into the folder given by `--pick-save`. The web client downloads through the browser (a Blob and a
   link with `download`); the web CSP needs nothing new.
4. **Hidden where a workspace keeps its pages in** (owner): with the export restriction (ADR-0009) set, neither the
   button nor the menu item is shown. This is a courtesy, not enforcement: whoever can read a page can copy its text,
   and the server has no way to tell a download from reading.
5. **Markdown only** (owner): pictures stay as the links the page has, so they do not show in the downloaded copy. A
   ZIP with the pictures may come later.

## Consequences

- One new host command and no new dependency (the dialog plugin's Rust API is already used for the pickers).
- What happened is announced to screen readers ("Saved Plan.md", or why it failed); nothing is shown on screen.

## Alternatives considered

- **The webview's own download on the desktop**: Tauri's webview does not save a Blob download where the person
  chooses; the host's dialog does.
- **A ZIP with attachments now**: more work, and the owner asked for `.md` first.

## Spec references

Section 7 (editor), section 9.1 (export restriction), section 13 (web client).

## Open questions

- A ZIP with the page's pictures; downloading a folder.
