# Getting started

<!-- repo-only:start -->
> The website publishes this page at `/docs/getting-started/` and its Thai version (`getting-started.th.md`) at `/th/docs/getting-started/`.
> The site leaves out this block (between the `repo-only` markers) and every HTML comment. The `#` heading is the
> page's title; each `##` heading becomes an entry in "On this page", so both versions keep the same `##` headings in
> the same order.
>
> Write only what a released version does, with the app's exact labels (`packages/app-ui/src/strings/`,
> `apps/desktop/src/strings/`). If a label or a feature changes, update this page and its Thai version together.
>
> Links: `https:` and `mailto:` links, and paths on the website such as `/privacy/` or `/docs/workspaces/`.
<!-- repo-only:end -->

Thoth is a notes app. Your notes are Markdown files in a folder on your computer. You can also write with
other people in workspaces on a Thoth server. These pages describe the desktop app, version 0.9.0.

## Install

Download Thoth from the download section of the website. There are versions for
macOS (Apple silicon and Intel), Windows (x64, as an .exe installer or an .msi
package) and Linux (an AppImage and a .deb package).

Thoth is not signed with an Apple or Microsoft developer certificate yet, so your
system warns you the first time:

- **macOS** may say it can't check the app for malicious software. Open System
  Settings → Privacy & Security and choose **Open Anyway**. You only do this once.
- **Windows** SmartScreen may warn about an unknown publisher. Choose
  **More info → Run anyway**.
- **Linux**: make the AppImage executable, then run it. Install the .deb with your
  package manager.

You can also try Thoth in your browser at https://thothnotes.com/app/. The web app
opens workspaces on the free demo server. It has no Private Space.

## Your Private Space

A Private Space is a folder of Markdown files on your computer. It works offline,
with no account.

When Thoth opens, choose **Start a new Private Space** and pick or create an empty folder, or choose **Open a folder
you already use**, for example an Obsidian vault. Both open the folder where it is: nothing is copied. Before a
folder that already has notes opens, Thoth says what it does there. It changes a file only when you edit it, keeps a
small `.thoth` folder there for its own records, and never changes Obsidian's settings, so Obsidian can keep using
the same files.

Every page you write is a Markdown file in that folder, so other apps can open the same files. Thoth keeps its search
index on this computer, not in the folder. The index can always be rebuilt from your files (Settings → Private Space
→ **Rebuild index**).

To open another Private Space or a workspace, click Thoth at the top of the sidebar and pick one, or choose **Open a
folder you already use…**. **Back to Private Spaces** (Alt/Option+Shift+H) saves your edits and goes back to the
list of Private Spaces.

## The welcome pages

A new, empty Private Space starts with a few pages in your app's language:
"Welcome to Thoth" shows every kind of block, "Linking pages" shows links, and
"Getting started/Keyboard shortcuts" lists the main shortcuts. Change them or
delete them when you are done. They do not come back.

A short tour of the sidebar, search, the editor and tabs follows. Choose
**Skip tour** to skip it. To see it again, open Settings → Help and feedback →
**Show the tour again**.

## Blocks and Plain

Every page has two modes. Both edit the same Markdown file.

- **Blocks**: formatted blocks, like Notion. Type `/` on an empty line for the
  block menu. Drag the handle at the left of a block to move it.
- **Plain**: Markdown text with a live preview, like Obsidian.

Switch with the toggle above the page, or press Ctrl/Cmd+Shift+E. Choose the mode
new pages open in under Settings → Editor → **Default editor mode**.
