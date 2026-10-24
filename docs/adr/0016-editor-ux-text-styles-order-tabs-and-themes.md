# ADR-0016: Text styles, page order, folders, tabs and themes

- **Status:** Accepted
- **Date:** 2026-10-24
- **Deciders:** project owner
- **Refines:** ADR-0002 (content model and serialization), ADR-0004 (workspace protocol), ADR-0012 (Blocks
  and Plain modes).
- **Refined by:** ADR-0017 (rule 3: servers may publish the folder marker as a page `kind`).

## Context

On 2026-10-24, while testing the web version, the owner asked for nine changes to the desktop app and the web
client (implementation plan, Phase 3b). Four of them touch the file format or the protocol, so they need
decisions:

1. Text colour and highlight must be stored in plain Markdown files that other apps can still read.
2. Workspaces (the web version) have no folders: a page can only contain other pages.
3. Drag and drop needs an order that people choose, not only A–Z.
4. Tabs need a rule for when a page opens in a new tab.

The other five changes are about how the app looks and works: more of the accent colour, light/dark/system themes,
a keyboard shortcut for everything, folders that look like folders, and renaming in the web version. They follow
the existing design tokens and need no format change.

## Decision

1. **Text styles in Blocks mode.** A floating toolbar on selected text, with shortcuts, offers bold, italic,
   underline, strikethrough, inline code, link, text colour and highlight. Fonts are out of scope for now.
   Stored as:
   - bold `**x**`, italic `*x*`, strikethrough `~~x~~`, code `` `x` `` (as today);
   - highlight `==x==` (Obsidian's syntax). There is one highlight style, in the accent colour; it is not
     customizable;
   - underline `<u>x</u>`;
   - text colour `<span data-color="NAME">x</span>`, where NAME is one of a fixed palette of eight names
     (gray, brown, orange, yellow, green, blue, purple, red). Each name has a light and a dark value, so text stays
     readable in both themes. The colour is not stored as a raw CSS value, so a file never carries styling that
     breaks in another theme. Any other `<span>` stays raw HTML, unchanged.
   - Untouched text round-trips byte for byte (ADR-0002 rule 1). Plain mode shows the Markdown, and its preview
     renders `==x==`, `<u>` and colour spans.
2. **Highlight shortcut:** Cmd/Ctrl+Shift+H toggles highlight on the selection, the same as Notion and Google Docs.
3. **Folders in workspaces** are pages that hold pages, as in Notion. "New folder" creates a page that the tree
   shows with a folder icon, marked by `thoth_kind: folder` in its frontmatter. Any page can still hold sub-pages.
   No server or protocol change. In a transfer, a Private Space folder becomes a folder page and a folder page
   becomes a folder.
4. **Page order.**
   - **Workspaces:** a page has an optional `position` (a fractional index string). It is a new optional field in
     `PageSummary` and `putPage`, so the protocol change stays backwards compatible. Moving a page is a metadata
     update that creates no new revision of its content. Without a position, pages sort A–Z after the positioned
     ones.
   - **Private Space:** the order lives in `.thoth/order.json`, so files and folders keep their names; renaming a
     file would break links and other apps. A missing or broken order file falls back to A–Z, because order is not
     content.
   - Drag and drop reorders and moves pages into folders, in both places. Moving a page into a folder in the Private
     Space is a file move inside the vault, which updates links like any other move.
5. **Tabs** work like a browser:
   - click opens in the current tab;
   - Cmd/Ctrl+click, middle-click or Cmd/Ctrl+Enter opens a new tab;
   - Cmd/Ctrl+T opens a new tab, Cmd/Ctrl+W closes one, Ctrl+Tab and Ctrl+Shift+Tab switch, Cmd/Ctrl+1–9 jump to a
     tab;
   - Settings opens as a tab;
   - open tabs come back on restart (desktop: per vault; web: per browser, without page titles in storage).
6. **Themes:** Light, Dark and System, chosen in Settings and with a shortcut. System follows the OS.
   - The tokens already have `data-theme="night"` and `"system"`.
   - **Desktop:** the choice is stored with the other preferences.
   - **Web client:** the choice is stored in `localStorage` under one key that holds only the theme name.
     ADR-0015 rule 1 keeps sign-in data out of `localStorage`; this key is not sign-in data.
   - The website keeps its fixed dark design.
7. **Keyboard.** Every command can be reached without a mouse:
   - a command palette (Cmd/Ctrl+K, which already opens search, gains commands with a `>` prefix);
   - a shortcuts list (Cmd/Ctrl+/);
   - the tree, tabs and dialogs work by keyboard;
   - shortcuts never take over what the OS or browser keeps (for example Cmd+Q, or Ctrl+W in Firefox without
     focus). Where the web cannot have a shortcut, it uses an alternative and the list says so.

## Consequences

- Positive: files stay readable Markdown. A colour degrades to plain text in apps that ignore HTML, and a highlight
  degrades to `==x==`.
- Positive: workspaces gain folders and order with only one optional protocol field.
- Negative: `==x==` is not CommonMark. Other renderers show the equals signs. Accepted, because Obsidian and most
  note apps support it.
- Negative: the order file in the Private Space is Thoth-only; other apps show A–Z.
- Follow-up:
  - a migration adding `pages.position` on the server, the protocol schema and OpenAPI, and the conformance suite;
  - editor serialization tests;
  - the plan, Phase 3b.

## Alternatives considered

- **Any colour from a colour picker.** Rejected by the owner, because colours chosen in light mode can be
  unreadable in dark mode.
- **A separate folder type on the server.** Rejected: it needs a protocol change and a transfer mapping, for little
  gain over folder pages.
- **Order by renaming files with number prefixes.** Rejected: it breaks links and changes the user's files.
- **Every page opens a new tab.** Rejected by the owner in favour of browser behaviour.

## Spec references

Section 2 (Markdown as the source of truth), 6.2, 7 (editor), 13 (web client).

## Open questions

None.
