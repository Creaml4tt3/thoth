# Changelog

All notable changes to the Thoth desktop app, the web app and the server are listed here, newest first. The format
follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The website’s changelog page (https://thothnotes.com/changelog/) and each GitHub release’s notes are made from
this file (`scripts/release-notes.ts`). The Thai page reads `CHANGELOG.th.md`, which lists the same versions, dates
and number of entries. How to update both at a release: `docs/deploy/release.md`.

## [Unreleased]

### Changed

- Moving pages between your Private Space and a workspace: a shorter dialog, with the details folded away and a list of your folders instead of a typed path. Dragging to another space now moves; hold Alt/Option to copy. A moved folder no longer stays behind empty.

### Added

- Open links with Cmd/Ctrl+click or a middle-click: a page link in a new tab, a web link in your browser. Shift+click opens a page link in a new window. Hover a link to see how.

## [0.2.6] - 2026-10-29

### Added

- Right-click the Private Space's header, a folder or the empty area of the tree for New page and New folder. Right-click a page for Open in new tab.
- New page and New folder go into the folder you clicked last, shown in the sidebar. A new page is called Untitled and its name is ready to type, like a new folder.
- Color… in a folder's right-click menu: eight label colors for folders. In a workspace, everyone sees the color.
- Click Thoth at the top of the sidebar to switch to a recent Private Space or a workspace in one step. All Private Spaces is still there.

## [0.2.5] - 2026-10-29

### Added

- Download as Markdown: a button in the page header and an item in a page’s right-click menu save the page as a .md file named after it, in your Private Space and in workspaces. On the desktop you choose where it goes; on the web your browser downloads it. Pictures stay as links. Not offered in workspaces that do not let pages be copied out.

## [0.2.4] - 2026-10-29

### Added

- Delete… in the right-click menu of pages and folders. Thoth asks first. In your Private Space they go to the Trash (the Recycle Bin on Windows), so you can put them back. In a workspace, a page and the pages inside it are deleted for everyone; viewers do not see it.

### Changed

- On the desktop, a new tab shows your recent pages and favorites again. The logo and the house still take you back to your Private Spaces.

## [0.2.3] - 2026-10-28

### Added

- The desktop app can update itself: click Update in the new-version popup, and Thoth downloads the new version, checks that Thoth signed it, installs it and asks before restarting. Turn it off in Settings → Updates to keep the Download button. From 0.2.2 or older, install this version by hand once. Not for .deb installs on Linux.

## [0.2.2] - 2026-10-28

### Changed

- On the desktop, the logo, the tab bar’s house, Alt/Option+Shift+H and “Back to Private Spaces” in the command palette take you back to the Private Space picker, after saving your edits; the space you left is first in Recent and opens again with its tabs. This replaces the Home tab on the desktop; a new tab is now empty. The web app keeps its Home tab.
- Share: a link you made on this device is listed with its address and a Copy button, and the dialog shows the exact date and time a new link would stop working.
- A breadcrumb too long for the page now scrolls sideways on one line, starting at the page itself, instead of cutting its parts short.

### Fixed

- Settings: choosing one of the last sections in the list no longer pushes the whole view up out of reach.
- Share: an active link shows the time it stops working, not only the day.
- A shared page shows SVG pictures instead of a download link; the file still cannot run a script.

## [0.2.1] - 2026-10-28

### Added

- Copy or move pages between two workspaces, on one server or two: from a page’s menu, its header or the command palette, or by dragging it onto the other workspace. Sub-pages, attachments and links between the pages go with them, and a move deletes the originals only after the other workspace has every page.
- A new, empty Private Space starts with Welcome pages that show every kind of block and link and the main shortcuts, then a short tour of the basic tools you can skip (and see again from Settings).
- Send feedback: report a problem, suggest an idea or ask a question from Settings or the command palette in the app, or from the new Support page on the website.
- Split view: two panes side by side, each with its own tabs, on the desktop and the web. Drag a tab to the right edge, or choose Split right (Cmd/Ctrl+Alt/Option+\).
- A Home tab with your recent pages and favorites, opened by the logo, the tab bar’s Home button or Alt/Option+Shift+H.
- Hide the whole sidebar with Cmd/Ctrl+\ or its button for more room to write; Thoth remembers it for each Private Space.
- Show in Finder or File Explorer for a page or folder in your Private Space.
- An Import button in the sidebar and the command palette, and breadcrumbs above a page that you can click.
- Copy or move between spaces from the right-click menu, and a Share… button in a workspace page’s header.
- Settings lists its sections beside the page.

### Changed

- Thoth’s website, web app, demo server and downloads moved to thothnotes.com. The old addresses keep working and lead there.
- The desktop app has a new app ID, com.thothnotes.desktop. It moves your recent Private Spaces, settings, sign-ins and assistant history over by itself, once.
- Because of the new app ID, on macOS and Windows open tabs and the sidebar’s order start fresh once, and macOS asks again for notifications and to open the app.
- Connected apps: apps you set up before this version stop connecting. Copy the setup again from Settings → Connected apps.

### Fixed

- On Windows, an Obsidian vault or Private Space on a USB stick, SD card or other FAT32 or exFAT drive opens again, instead of “The parameter is incorrect”.
- Right-click menus stay inside the window.
- A drag cancelled with Escape no longer opens the tab or folds the section when you let go.
- The highlight and selected rows are easier to see, in light and dark.

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
- The web app at thothnotes.com/app/, which opens workspaces on the free demo server.
- The app in English and Thai, following your system, with a choice in Settings → Language.

[0.2.6]: https://github.com/Creaml4tt3/thoth/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/Creaml4tt3/thoth/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/Creaml4tt3/thoth/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Creaml4tt3/thoth/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Creaml4tt3/thoth/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Creaml4tt3/thoth/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Creaml4tt3/thoth/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/Creaml4tt3/thoth/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Creaml4tt3/thoth/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Creaml4tt3/thoth/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Creaml4tt3/thoth/releases/tag/v0.1.0
