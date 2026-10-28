# ADR-0035: Deleting pages and folders from the trees

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** owner (rules 1 and 2); implementation agent (the rest, marked "(this ADR)")
- **Refines:** ADR-0001 (the vault's files), ADR-0008 (host commands granted by name), ADR-0016 (the trees).

## Context

Until 0.2.3 nothing in the app deleted a page or a folder: people did it in Finder or File Explorer, and a workspace
page could not be deleted at all, although the server has had `DELETE /workspaces/{id}/pages/{pageId}` (a soft delete
that keeps the revisions) since Phase 2.

## Decision

1. **"Delete…" in the right-click menu of both trees, asking first** (owner). It is the last item, in the danger
   colour. The question names the page or folder and says what goes with it (how many pages are in a folder); Cancel
   has focus, so Enter alone never deletes. A failure keeps the question open and says why.
2. **The Private Space deletes to the system Trash** (owner): Finder's Trash, the Recycle Bin, the freedesktop Trash.
   People put things back from there; Thoth has no Trash of its own.
3. **The host does it** (this ADR): one new command, `vault.trash { vault, path }`, granted by name. It takes the same
   path checks as `vault.reveal` (inside the open folder, no `..`, no symlink, not in `.thoth/`, must exist, never the
   root) and hands the absolute path to the `trash` crate (exact pin) in the desktop shell. The stdio harness removes
   the entry and reports `vault.trashed`. Pending edits are written first; the tabs on what was deleted close, and
   Recent, Favorites and the tree drop it when the page list is read again.
4. **A workspace page is deleted on the server for everyone** (this ADR), by writers only (viewers have no item). The
   server deletes one page and leaves its children, so the client deletes every page under it first, deepest first,
   each with the revision the tree has (`If-Match`); a page changed meanwhile stops the delete there, with the pages
   still above it untouched. A page that is already gone counts as deleted. A folder page is deleted the same way.
5. **No undo in the app** (this ADR). The Private Space has the system Trash; a deleted workspace page stays on the
   server (soft delete) and a restore can come later.

## Consequences

- A link to a deleted page shows as unresolved, as when the file is deleted outside Thoth.
- A Private Space folder's other files (pictures, attachments) go to the Trash with it.
- One new Rust dependency in the desktop shell; on Windows it shares the `windows` crate the Tauri stack locks.

## Alternatives considered

- **Delete for good** (the vault's journaled `deleteFileAtomic`): no new dependency, but nothing to put back. Not
  chosen by the owner.
- **A Thoth Trash folder in the vault**: would show in other editors and sync tools, and needs its own UI.
- **Typing the name to confirm** (as for a workspace, ADR-0025): too heavy for a page that can be put back.

## Spec references

Section 7 (editor and trees), section 13 (web client).

## Open questions

- Restoring a deleted workspace page from the app (the server keeps it).
