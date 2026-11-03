# ADR-0049: "@" to link pages, folders and people

- **Status:** Proposed
- **Date:** 2026-11-01
- **Deciders:** owner (rules 1, 2, 3 and 6 and the aims of 4 and 5); implementation agent (the rest, marked "(this ADR)")
- **Refines:** ADR-0002 (the editor's content model: one new inline node), ADR-0010 (link resolution: folder targets),
  ADR-0012 (Plain mode), ADR-0016 (folders), ADR-0038 rule 4 (opening page links).

## Context

Before this ADR, a link to another page was typed as `[[` and picked from a menu of pages. There was no link to a
folder, and nothing to name a person. In a workspace page every link showed as unresolved and `[[` offered nothing,
because links resolved against the local vault index only (`WorkspacePage` passed `loadLinks={null}`).

The owner asked for:

- `@` to link pages and folders, in both editor modes;
- links to folders that show the folder in the sidebar;
- links that work in workspace pages, and survive renames there;
- `@` to name a workspace's members in workspace pages.

## Decision

1. **`@` opens the link menu** (owner). It works in Blocks and Plain mode and is the same ARIA listbox as `[[`, with
   `aria-controls` and `aria-activedescendant` on the editor and the focus kept in the text. It lists pages and
   folders. In a workspace page it lists the workspace's members too. Its accessible name says what it lists ("Link to
   a page or folder", or "… or person"), and each folder or person row says "Folder" or "Person".
2. **When `@` opens** (owner; the exact rule is this ADR's): only at the start of a word, which means at the start of a
   line, after whitespace, or after `(`, `[` or `{`. It never opens inside an email address or a word (`mail@x`,
   `ชื่อ@x`), after another `@`, inside code, inline code, frontmatter, or inside a link already written. The query
   may hold spaces, because names have them. Escape closes the menu, and it stays closed for that `@`. Typing a space
   when nothing matches also closes it. Enter, Tab or a click picks an item. No space is added after the chip: the
   serializer would have to write a trailing space as `&#x20;` (this ADR).
3. **Ranking** (this ADR). The menu uses the same rules as `[[`: an exact match first, then a prefix, then the start
   of a word. Titles beat names, names beat aliases, and aliases beat paths. Pages come before folders, and folders
   before people. A folder or a person must match from the start of a word, so "ro" never offers "Projects". There
   are 8 rows at most, and the open page is never listed.
4. **The Markdown of a folder link** (owner's preference, confirmed here): the wikilink form with a trailing slash,
   `[[Projects/2026/]]`, which may also take a label (`[[Archive/|old work]]`).
   - Thoth's parser already accepts it: it is an ordinary wikilink whose target ends in `/`, written back byte for
     byte.
   - Obsidian, which this format follows (ADR-0010), shows it as a link. Clicking it there does not open the folder.
     That is acceptable: the text stays readable and nothing breaks (to be checked against Obsidian's current
     behaviour, not assumed beyond that).
   - `LinkResolver` (`@thoth/content`) resolves a target ending in `/` to a folder only, never a page. It tries the
     exact path, then a path relative to the linking file, then a unique path suffix, all case-insensitively when
     that is unique. Its result is the folder's path with the trailing `/`. The folders it knows are the vault's
     folders (`listFolders`, including empty ones) and every folder that holds a file. Two folders with the same name
     make the link ambiguous; the resolver never guesses.
   - The vault index stores a resolved folder link like any other (`target_path` is `Projects/2026/`). When a folder
     or page moves, the link is rewritten to `Name/`, or to the full path when the short form is ambiguous, as page
     links are.
   - The importer leaves folder links as written. It counts one as resolved when the destination vault has that
     folder after the import, and warns otherwise.
   - Transfers do not treat a folder as an attachment. A folder link that goes from the Private Space to a workspace
     stays as written and is flagged unresolved there, like any other path link (ADR-0006).
5. **A folder chip** (owner: "reveals/selects that folder in the sidebar"). A resolved folder link shows a folder mark
   before its name. A click, or Enter, shows the folder in the sidebar: the sidebar comes back if it was hidden, the
   folders above it open, and focus moves to the folder's row. In the Private Space this is the same thing a
   breadcrumb's folder does (`openFolder(…, { openFirstPage: false })`). In a workspace the section expands and
   focuses the row (`requestRevealWorkspacePage`). Cmd/Ctrl, Shift and the middle button do nothing different for a
   folder.
6. **Workspace links name pages by ID** (owner). `[[` and `@` in a workspace page insert
   `[[thoth:page/<id>|Title]]`, the form transfers already write and the share renderer already reads
   (`PAGE_LINK_PREFIX`, `parseThothLink`). The link survives renames and moves. The chip shows the page's current
   title when the link has no label of its own (this ADR). A link with a label shows its label, as in the Private
   Space, and the tooltip shows the current title.
   - A folder in a workspace is a page marked as a folder (ADR-0016 rule 3), so a folder link there is a
     `thoth:page/<id>` link to it. Its chip is a folder chip, and a click reveals it in the tree.
   - The page and folder lists, and what each link resolves to, come from the workspace tree and workspace list the
     client already holds (`ServerDirectory`). No new server route; they update when the change feed changes the
     tree.
   - Path and title links (`[[Roadmap]]`) do not resolve in a workspace. A workspace has no paths.
7. **The Markdown of a person mention** (owner's aim; this ADR's form): `[@Display Name](thoth:user/<id>)`.
   - It is a standard Markdown link, so every other editor shows it as "@Display Name" (a link that does nothing).
   - The ID is the opaque user ID of the protocol's `Member.userId` (URL-unreserved, at most 128 characters), so it
     needs no escaping. The name is escaped like any link text.
   - It is read as a mention only when it is exactly that: one text child starting with `@` and a non-space, no link
     title, and a valid ID. Anything else stays an ordinary link, written back unchanged.
   - In Blocks mode it is a new inline atom node, `mention`, with `id` and `label`. In Plain mode, off the cursor's
     line, it shows as the same chip.
   - The share renderer already turns any `thoth:` link other than a shared page or attachment into its text, so a
     shared page shows "@Name" and no address.
8. **People only in workspaces** (owner). People are offered only after `@` in a workspace page, from the members
   list the workspace list carries (`Workspace.members`; the server sends up to 50). Nothing is offered in the
   Private Space. When the server does not send members, nobody is offered.
9. **Privacy** (owner). A mention stores the display name and the opaque user ID, nothing else: no email, no role.
   The chip opens nothing and looks nothing up.

## Consequences

- One new node, `mention`, in the editor schema. `canonical.test.ts` requires every node in a golden, and the new
  `mentions` golden covers it.
- A link written in a workspace page as `[[thoth:page/<id>|Title]]` is readable in any editor (it shows the label),
  and Thoth can follow it after a rename.
- A workspace with more than 50 members offers only the first 50 the server sends (those with the lowest IDs) after
  `@`.

## Follow-up work

- **Notifications to the mentioned person** are a later step, not part of this ADR. A mention changes nothing on the
  server, and nobody is told they were mentioned.
- Backlinks for workspace pages, and resolving `[[Title]]` links in a workspace, would need the server's link index.
- A mention could show the person's current name instead of the stored one, once the client keeps the full members
  list.

## Alternatives considered

- **A folder link as a Markdown link to a directory (`[Projects](Projects/)`):** other editors treat it as a file
  link and Obsidian does not follow it either. The wikilink form keeps one syntax for every internal link.
- **A folder link to a folder note (`[[Projects/Projects]]`):** that names a page, not the folder, and many folders
  have no such note.
- **A mention as `@[Name](id)` or `<@id>`:** other editors would show the raw syntax, and `<@id>` loses the name
  entirely. A standard link with an `@` in its text reads well everywhere.
- **A mention as plain `@Name`:** that cannot tell people with the same name apart, and it breaks when someone
  changes their name.
- **Workspace links by title (`[[Roadmap]]`):** a rename would break them, and two pages may share a title.
- **A new route to list a workspace's pages and members for the menu:** the tree and the workspace list are already
  on the client.

## Open questions

- None that block this. Owner to confirm the Markdown forms of rules 4 and 7.
