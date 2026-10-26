# Changelog

All notable changes to the Thoth desktop app, the web app and the server are listed here, newest first. The format
follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The website’s changelog page (https://thoth.creaml4tt3.me/changelog/) and each GitHub release’s notes are made from
this file (`scripts/release-notes.ts`). The Thai page reads `CHANGELOG.th.md`, which lists the same versions, dates
and number of entries. How to update both at a release: `docs/deploy/release.md`.

## [0.2.0] - 2026-10-26

### Added

- Codex as a second assistant next to Claude Code. It runs inside Codex’s own sandbox and has no spending limit.
- The Thoth mascot and its prompt bubble (Cmd/Ctrl+J) start assistant runs, with the pages you picked as context.
- A run’s answer appears in the bubble and in the run’s own tab, with Copy answer; the sidebar lists recent runs.
- Ask a follow-up: a run’s tab is a conversation, and each new question is sent with the earlier questions and answers.
- Notifications: a bell with a list in the app, and system notifications while Thoth is in the background.
- Drag a tab to reorder it, or out of the tab bar to open it in a new window on the same Private Space.
- Pasting a web address makes a link, and links can show a preview card fetched by the app.
- A notice when a new desktop version is out, checked at start and once a day. Nothing is downloaded by itself.
- Connected apps: a read-only MCP server that AI tools can use to search and read your pages, off until you switch it on.
- Public read-only share links for workspace pages, which you can revoke at any time.
- Workspace members and invite links: change roles, remove members, leave, and join with a link.
- Several workspaces per account: create, rename and delete them, and restore a deleted one for 30 days. The trial allows 3 per account.
- Drag pages between the Private Space and a workspace to open the copy and move dialog.
- The sidebar can be resized, and its sections can be reordered and folded. A section’s drag handle shows only while you hover over its header.
- Favorites: star a page to keep it in the sidebar’s Favorites section, in the Private Space and in workspaces.
- Pinned tabs stay at the start of the tab bar, compact, and are not closed by Cmd/Ctrl+W.
- Add an image to a page from the / menu, by pasting or by dropping a file; it is copied next to the page. Its alt text can be edited.

### Changed

- The Agent Hub tab is gone: the mascot starts runs, and Settings → Thoth assistant holds providers, history and permissions.
- Tabs are 202 pixels wide, and a dragged tab shows the new order while you drag.

### Fixed

- Pages in the sidebar can be dragged again, and a drop lands where the line is drawn.
- A moved page keeps its open tabs.
- The window no longer scrolls as a whole; only the page area scrolls.
- Closing one window no longer closes the others.
- An unknown share link no longer logs a server error behind its “not found” page.
- Images in pages show, including SVG files and the images of imported pages; a missing image names its file, and web images show as a link.
- The mascot’s bubble no longer cuts off the start of a long question or answer.
- An assistant’s answer names your pages by their paths in the Private Space, not by the run’s private copy.

## [0.1.3] - 2026-10-25

### Added

- The desktop app for Windows x64, as an installer (.exe) and an MSI package.
- On Windows, the Private Space refuses symbolic links and junctions, handles long paths, and finds names copied from a Mac.
- Claude Code on Windows: Thoth finds it from the native installer, WinGet or npm, and Cancel ends every process it started.
- Show in File Explorer opens your Private Space folder on Windows.

## [0.1.2] - 2026-10-25

### Added

- The Agent Hub runs the Claude Code CLI you installed on the pages you pick, in a private folder that holds only those pages.
- Every change Claude Code proposes is shown as a diff, and nothing is written until you choose Apply.
- A page edited while the run was going becomes a conflict, with the option to keep the agent’s version as a copy.
- Pick single pages, a folder, the whole Private Space, or workspace pages as read-only reference.
- A spending limit and a time limit for each run, and a history of runs kept on your computer only.

## [0.1.1] - 2026-10-25

### Added

- Copy or move pages between your Private Space and a workspace, with a preview of what will travel before anything is sent.
- Drag and drop in the sidebar to reorder pages and move them into folders, with Alt+Shift+Up/Down and Move to… from the keyboard.
- Rename with F2, and New folder (Cmd/Ctrl+Shift+N) in the Private Space; rename and folders in workspaces too.
- A text style toolbar in Blocks: bold, italic, underline, strikethrough, code, link, eight text colours and highlight.
- Light, Dark and System themes, in Settings and in the command palette.
- Browser-like tabs above the editor, restored when you restart; Settings opens as a tab.
- A command palette (Cmd/Ctrl+K) and a list of every shortcut (Cmd/Ctrl+/), so everything works from the keyboard.
- Gentle motion for folders, tabs and menus, switched off when your system asks for reduced motion.

### Changed

- The accent colour marks the selected item, the active tab, buttons, focus and links, with AA contrast in both themes.
- Folders look like folders, with an open and closed icon and an item count.
- Workspace folders show without downloading each page, on servers that support it.

### Fixed

- Signing in to the web app returns you to the app instead of a “not found” page.
- The sidebar’s buttons fit on one line, with Settings as a labelled icon.

## [0.1.0] - 2026-10-24

### Added

- The first public release of the desktop app, for macOS (Apple silicon and Intel) and Linux (AppImage and .deb).
- A Private Space: a folder of Markdown files on your computer that works offline, with no account.
- Two editors for the same file: Blocks, with a slash menu, block handles and toggles, and Plain, with a live preview.
- Type [[ to link to another page, in both editors.
- Import a Notion export or an Obsidian vault, as a folder or a ZIP, with a report of anything that could not come across.
- Connect to a Thoth server and open its shared workspaces, with owner, editor and viewer roles and a conflict check on every save.
- The web app at thoth.creaml4tt3.me/app/, which opens workspaces on the free demo server.
- The app in English and Thai, following your system, with a choice in Settings → Language.

[0.2.0]: https://github.com/Creaml4tt3/thoth/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/Creaml4tt3/thoth/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Creaml4tt3/thoth/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Creaml4tt3/thoth/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Creaml4tt3/thoth/releases/tag/v0.1.0
