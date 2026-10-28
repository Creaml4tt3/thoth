# ADR-0037: New items from the trees' menus, the target folder, folder colors and the space switcher

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** owner (rules 1, 3, 4 and 5); implementation agent (the rest, marked "(this ADR)")
- **Refines:** ADR-0016 (the trees), ADR-0017 (folder pages), ADR-0029 (Home; amendment of 2026-10-29, 0.2.6).

## Context

The owner's list for 0.2.6:

- a right-click menu on the sidebar's sections and on folders to add pages and folders;
- Open in new tab in a page's menu;
- New page and New folder going into the folder that is selected;
- a label color for folders, from 8 colors;
- a simpler, more compact way to move between Private Spaces and workspaces.

Before 0.2.6:

- New page opened a dialog that took a path.
- New folder went into the folder of the focused row, which a click on a sidebar button had already left.
- The logo left for the full-screen picker.

## Decision

1. **New page and New folder in the menus** (owner):
   - The Private Space section's header has New page and New folder, at the top level. So does the empty area of the
     tree.
   - A Private Space folder has New page inside, New folder inside and Color….
   - A workspace page or folder already had New page inside and New folder inside; a workspace folder gains Color….
   - A page in either tree has Open in new tab first, with the Cmd/Ctrl+Enter hint (as in Favorites).
2. **New page makes "Untitled" at once** (owner):
   - It makes "Untitled" ("Untitled 2"… when taken; never overwriting), opens it and starts its rename in the tree,
     like New folder.
   - The name dialog that took a path is gone (this ADR).
3. **The target folder is the last folder clicked** (owner):
   - Clicking a folder makes it the target and marks it in the tree.
   - Clicking a page makes its folder the target.
   - Clicking beside the rows clears it (the top level).
   - The sidebar's New page and New folder buttons, Cmd/Ctrl+N, Cmd/Ctrl+Shift+N and the palette go there.
   - A focused row still wins, so keyboard use is unchanged: Cmd/Ctrl+Shift+N on a row goes into that row's folder.
   - In a workspace, the workspace row's New page and New folder, and its two buttons, go into that workspace's target
     folder.
   - A target that is renamed or moved follows. One that is deleted falls back to its parent (this ADR).
4. **Eight label colors: the editor's text colors** (owner chose the count; this ADR chose the palette):
   - The colors are gray, brown, orange, yellow, green, blue, purple and red. They already have contrast-checked
     light and dark tokens. None removes the color.
   - A folder's color tints its icon only; the name keeps the text color.
   - The choice is a small dialog with a radio group, showing each color on a folder icon.
5. **Where colors are kept** (owner):
   - **Private Space:** in `.thoth/order.json`, under an optional `colors` map (folder path to color), next to the
     order. Files and folders are never renamed or marked for it.
     - The color follows a rename or a move, with the folders inside.
     - Deleting a folder drops its colors.
     - A record without `colors` still reads.
   - **Workspaces:** in the folder page's own frontmatter (`thoth_color`), so every member sees it on the desktop and
     on the web.
     - Writers set it, as a new revision on top of the one just read (a page changed meanwhile is a conflict, as for a
       rename).
     - An unknown value shows no color.
6. **Folder colors are read from folder pages** (this ADR):
   - With `page-kind`, the tree tells which pages are folders but not their text. So each folder page (never an
     ordinary page) is read once per revision, for its color.
   - The kind still comes from the server. A read that the change feed overtook is dropped.
   - Without `page-kind`, every page is read once per revision, as before, and the color comes with that read.
7. **The space switcher** (owner; ADR-0029 amendment of 2026-10-29, 0.2.6). The logo row shows this Private Space's
   name and opens a menu:
   - the recent Private Spaces (at most 6, this one checked); picking one opens it in this window, after writing
     edits;
   - Open folder…;
   - every workspace the account sees; picking one shows its server's section if it was folded, opens the workspace
     and puts focus on its row;
   - All Private Spaces (the picker, with the Home shortcut's hint).

## Consequences

- People who typed `Folder/Name` in the New page dialog now make the page inside the folder, or move it after.
- A server with `page-kind` gets one read per workspace folder per revision, which it did not before. Ordinary pages
  are still never read for the tree.
- Older apps ignore `colors` in `.thoth/order.json` and `thoth_color` in a folder page. The color is just absent there.

## Alternatives considered

- **A color in the folder's name or a sidecar file in the folder:** changes what other apps see.
- **Colors per device only:** the owner chose that workspace colors are seen by every member.
- **Tabs per space at the top of the sidebar:** more room for one space, but the Private Space and workspaces could no
  longer be seen together, which drag and drop between them needs.
