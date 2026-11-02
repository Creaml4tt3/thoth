# ADR-0047: Duplicating pages and folders

- **Status:** Proposed
- **Date:** 2026-11-02
- **Deciders:** owner (rules 1, 6 and 7: what is offered, images in the Private Space are copied, team limits are
  warned about, not copied); implementation agent (the rest, marked "(this ADR)")
- **Refines:** ADR-0016 (the trees), ADR-0017 (folder pages), ADR-0028 (images in pages), ADR-0035 (delete),
  ADR-0042 (team limits). Step 2 of ADR-0045 (switching from Obsidian).

## Context

People who come from Obsidian or Notion copy a page or a folder to start a new one from it (a weekly note, a project
template). Thoth had a block-level Duplicate in the editor and cross-space copies (ADR-0006, ADR-0038), but no way to
copy a page or folder in the space it is in. A transfer between workspaces refuses the same workspace, needs a record
store and the `transfers` capability, and has no "titles only" mode, so it is not the tool for this.

## Decision

1. **Three items in a page's or folder's menu** (owner), for anyone who can write there (in a workspace: editors,
   managers and owners; viewers do not see them): "Duplicate", "Duplicate structure only" and "Duplicate to…". The
   command palette has "Duplicate page" for the open page.
2. **Cmd/Ctrl+Shift+D on the focused tree row duplicates it** (this ADR). Cmd/Ctrl+D was asked for, but it is already
   "Add to Favorites" everywhere (and a browser's bookmark key), so the tree uses Shift with it. The keyboard help
   lists it under the page trees.
3. **Where and what** (this ADR). The copy goes right below the original in the same folder, named "<Title> (copy)",
   then "(copy 2)" and so on when taken (Thai "(สำเนา)"). It has the current text (pending edits are written first) and
   the folder color; it does not have earlier versions, share links or team limits. The copy is selected, opened when
   it is a page, and its name is in rename at once; the tree's live region says "Duplicated <Title>". "Duplicate to…"
   makes the same copy in a folder picked with the "Move to…" picker, in the same space, at the end of that folder.
4. **A folder comes with everything in it** (this ADR), keeping its structure and order (the Private Space's
   `.thoth/order.json` lists and colors; a workspace's `position` keys). A folder with pages in it asks first:
   "Duplicate <Folder> and its N pages?". Links between pages of the copied set point at the copies; links to anything
   else keep reaching what they reached. In a workspace this is the transfer rewriting (`classifyBetween`,
   `applyRewrites`, `withOwnId`); in the Private Space each link is resolved from the original's place and written
   again only where the copy's place changes its spelling (for example a `[[Name]]` that is ambiguous once there are
   two).
5. **Structure only** (this ADR): the same copy, but each page keeps only its title; folder pages keep their folder
   frontmatter and color. Meant for templates. In the Private Space no images or other files are copied then.
6. **Images in the Private Space are copied** (owner). An image a copied page shows from outside the copied set
   (ADR-0028 resolution) is copied next to the page's copy under its own name, or `name-2.png`… when taken, and the
   copy's `src` follows. Images inside a copied folder come with the folder. In a workspace the copy points at the same
   attachment (`thoth:attachment/<id>`); nothing is uploaded again.
7. **Team limits are warned about, not copied** (owner). For owners and managers the client asks
   `GET …/pages/{id}/visibility` for the original and, when it is limited from above, for its folders up the tree.
   When the original is limited itself, or the copy goes outside the nearest limited folder, the question says the
   copy will be visible to everyone in the workspace. Editors cannot ask; for them the question says the copy keeps no
   team limits.
8. **Nothing is replaced, nothing half-made is left** (this ADR). Every write is a create: `Vault.writeFileAtomic` with
   `expectedHash: null`, and `PUT …/pages/{id}` with `If-None-Match: *` and a new page id. Before a workspace copy the
   client checks `maxPagesPerWorkspace` against the tree and refuses with the numbers when the copy does not fit. A
   failure part-way removes what was made (workspace: the created pages, newest first; Private Space: the created
   files, then the folders) and shows the error.
9. **No server or protocol change** (this ADR). Everything above uses routes that exist. A server-side copy would be
   atomic and faster for large folders, but it is not needed for this step.

## Consequences

- Positive: a page or folder can be reused as a template in either space, without the transfer dialog; the copies
  never overwrite anything and a failure leaves no partial folder behind.
- Negative: a workspace copy is one request per page (plus one read per page), so a large folder takes a while and a
  lost connection after the last create is not undone. In the Private Space a copied folder makes other pages' bare
  `[[Name]]` links to pages in it ambiguous, as copying the folder in Finder would; the copy's own links are written
  so that they resolve.
- Follow-up: the web client's command palette does not have "Duplicate page" yet (its tree menu does).

## Alternatives considered

- **Reuse the transfer between workspaces**: it refuses the same workspace by design, keeps a durable record and
  needs `transfers`; the extra state buys nothing for a copy that can be undone by deleting what it made.
- **A server-side copy route**: atomic, but a protocol change and a capability for every server; not needed now.
- **Copy team limits for managers**: the owner chose a warning; copying needs a second write that can fail on its own.

## Spec references

The ADRs it refines; no section of the architecture handoff changes.

## Open questions

None.
