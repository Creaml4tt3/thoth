# Thoth user guide

<!-- repo-only:start -->
> The website publishes this file at `/docs/` and the Thai version (`guide.th.md`) at
> `/th/docs/`. The site leaves out this block (between the `repo-only` markers) and every
> HTML comment. Each `##` heading becomes an entry in the page's table of contents, so
> both versions keep the same `##` headings in the same order.
>
> Write only what a released version does, with the app's exact labels
> (`packages/app-ui/src/strings/`, `apps/desktop/src/strings/`). If a label or a
> feature changes, update this guide and its Thai version together.
>
> Links: `https:` and `mailto:` links, and paths on the website such as `/privacy/`.
<!-- repo-only:end -->

Thoth is a notes app. Your notes are Markdown files in a folder on your computer.
You can also write with other people in workspaces on a Thoth server.
This guide covers the desktop app, version 0.9.0.

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

## First steps

### Your Private Space

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

### The welcome pages

A new, empty Private Space starts with a few pages in your app's language:
"Welcome to Thoth" shows every kind of block, "Linking pages" shows links, and
"Getting started/Keyboard shortcuts" lists the main shortcuts. Change them or
delete them when you are done. They do not come back.

A short tour of the sidebar, search, the editor and tabs follows. Choose
**Skip tour** to skip it. To see it again, open Settings → Help and feedback →
**Show the tour again**.

### Blocks and Plain

Every page has two modes. Both edit the same Markdown file.

- **Blocks**: formatted blocks, like Notion. Type `/` on an empty line for the
  block menu. Drag the handle at the left of a block to move it.
- **Plain**: Markdown text with a live preview, like Obsidian.

Switch with the toggle above the page, or press Ctrl/Cmd+Shift+E. Choose the mode
new pages open in under Settings → Editor → **Default editor mode**.

## Home and Today

**Home** shows your **Recent** pages, your **Favorites** and the **Today** card.

Today's page is one page per day, a daily note. Choose **Open today's page** on Home, press Alt/Option+Shift+T, or
use the command palette. The first time each day it is made, at `Daily/YYYY-MM-DD.md` unless you choose otherwise,
from `Templates/Daily.md` when you have one.

In Settings → Today you choose, for each Private Space, the **Folder**, the **File name** (for example
`YYYY/MM/YYYY-MM-DD`, with a preview of today's) and the **Template**. `{{date}}`, `{{time}}` and `{{title}}` in the
template are filled in when the page is made, also with a format such as `{{date:dddd D MMMM}}`. The setting is saved
in the folder, so it comes with it. When you open a folder that Obsidian's daily notes already use, Thoth asks once
whether Today should use the same folder, file name and template.

## Pages and folders

- **Create**: choose **New page** (Cmd/Ctrl+N) or **New folder**
  (Cmd/Ctrl+Shift+N). You can also right-click the Private Space's header, a folder
  or the empty area of the sidebar. A new page goes into the folder you clicked
  last. It is called Untitled, and its name is ready to type.
- **Rename**: press F2, or choose **Rename** in the right-click menu.
- **Move**: drag a page or folder in the sidebar. From the keyboard, use
  **Move to…** or Alt+Shift+Up/Down.
- **Duplicate**: in a page's or folder's right-click menu, choose **Duplicate**, **Duplicate structure only** (each
  page keeps only its title, handy for templates) or **Duplicate to…**. Cmd/Ctrl+Shift+D duplicates the selected
  item. A folder is copied with everything in it, and links between the copied pages point at the copies. A copy
  never replaces anything.
- **Colours**: right-click a folder and choose **Color…**. There are eight colours.
  In a workspace, everyone sees the colour.
- **Delete**: right-click and choose **Delete…**. Thoth asks first. In your Private
  Space, the page or folder goes to the Trash (the Recycle Bin on Windows), so you
  can put it back from there.
- **Pictures**: a picture written as `![[photo.png]]` shows as a picture in both modes. `![[photo.png|300]]` sets
  its width.
- **Download as Markdown**: the button in the page header, or the item in a page's
  right-click menu, saves the page as a .md file.

Pages open in tabs. Right-click a tab to pin it, or to split it to the right.
Star a page with **Favorite** to keep it in the sidebar's Favorites.

## Links and Connections

Type `[[` or `@` and pick a page to link to it. This works in both modes. `@` also links a folder: the link shows that
folder in the sidebar. In a workspace page, `@` can also name a member; nobody is notified. Links keep working after a
page is renamed or moved. Cmd/Ctrl+click a link to open it in a new tab.

**Connections**, under every page, lists:

- **Links from this page**: the pages it links to.
- **Backlinks**: the pages that link to it.
- **Unlinked mentions**: pages that name this one, or one of its aliases, without a link. Choose **Link** to turn a
  mention into a link. The other page is written only if it has not changed in the meantime.

In a workspace, Connections lists only the pages you may see.

## Search and the command palette

Press Cmd/Ctrl+K to search the pages of your Private Space by title and text.

Type `>` first to run a command by its name, for example `> new page`. Every
command can be reached from the keyboard. Press Cmd/Ctrl+/ for the list of
shortcuts.

In Settings, type in **Search settings** to see only the settings that match.

Cmd/Ctrl + and − zoom the window, and Cmd/Ctrl+0 resets it. F6 moves the focus between the sidebar and each pane.

## Timeline

**Timeline** in the sidebar, on Home or in the command palette lists the pages of one space by date, newest first,
under a heading per day. Choose the space at the top.

- **Edited** places each page on the day it was last changed.
- **Dated** places a page on the date it names: a `date: 2026-11-09` line at the top of the page (add it in Plain
  mode), or the name of a daily note. Pages without a date stay on the day they were edited. If no page in the list
  has a date, Timeline says so, and the list looks the same as Edited.
- Choose tags to see only the pages that have all of them.

A workspace shows tags and dates when its server runs Thoth 0.7.0 or later.

## Import from Notion and Obsidian

Choose **Import from Notion or Obsidian** in Settings → Import notes, the Import
button in the sidebar, or the command palette. The import only reads your originals.

- **Notion**: in Notion, export your workspace as Markdown & CSV. Pick the ZIP, or
  the folder once extracted.
- **Obsidian**: pick a vault folder, or a ZIP of one. To keep using the vault in both apps instead, open it with
  **Open a folder you already use**.

Thoth shows a preview of what will and will not carry over. Then you choose a
folder in your Private Space and start the import. At the end, a report lists
anything that could not come across. Notion does not recreate your workspace from
an export, so expect a best-effort migration. Obsidian settings and plugin code are
not imported.

## Workspaces on a server

A workspace holds pages you share with other people on a Thoth server.

### Sign in

Open Settings → Servers. Choose **Add Thoth demo server**, or enter a server's
address and choose **Add server**. Then choose **Sign in with** and your provider,
and finish signing in in your browser. You can also sign in with a personal access
token. Thoth keeps your sign-in in the system keychain.

The demo server is free, with limits. Accounts unused for 90 days are deleted, and
the demo may be reset, so keep anything important in your Private Space.

Workspaces appear in the sidebar. To make one, choose **New workspace…**. You
become its owner.

### Members and invites

Each member has a role:

- **Owner**: everything a manager does, plus making owners and renaming or deleting the workspace.
- **Manager**: manages members, invite links, teams and the Trash, and sees every page.
- **Editor**: reads and edits pages.
- **Viewer**: reads pages.

Open a workspace's menu and choose **Members…**. Owners and managers can change roles, remove members and choose
**Invite people**. Only an owner can make someone an owner, or change or remove an owner. Pick the role, how long the
link works and how many people can join with it, then **Create invite link**. Copy it at once: the link is shown only
once.

To join, open the link in your browser, or paste it under **Join with an invite
link** in Settings → Servers.

To leave, choose **Leave workspace** in the members dialog.

### Teams

Owners and managers can group members into teams under **Teams** in **Members…** (**Create team**). Then right-click a
folder or page, choose **Visible to…** and **Only these teams**. Pages inside a limited folder are limited too.
Members in none of those teams cannot see those pages, search them or open their share links. Owners and managers see
every page.

### Working together

A workspace page shows who else has it open, for example "Ana is also here", when the server supports it. When someone
changes a page you have open, the page says so ("Updated by Grace just now.") instead of reloading silently. If you
have unsaved edits at that moment, Thoth asks which version to keep. A save never overwrites someone else's change.

### Share a page publicly

Owners and editors can right-click a workspace page and choose **Share…**. Anyone
with the link can read the page and the pages inside it, without signing in. They
cannot edit or comment. Choose when the link stops working, then **Create link**.
**Revoke** turns a link off at once.

### Export restrictions

When you create a workspace, you can tick **Do not allow copying or moving pages
out of it**. This cannot be changed later. In such a workspace, members cannot copy
or move pages to their Private Space or to another workspace, download them as
Markdown, or give them to the assistant.

### The workspace Trash

Deleted workspace pages and folders go to the workspace's Trash (**Trash…** in the workspace menu) and stay there 30
days. Owners and managers can **Restore** anything, or **Delete for good…**. Editors can restore what they deleted.

### Deleting a workspace

An owner can delete a workspace from its menu. For 30 days an owner can restore it,
with its pages and members, from **Recently deleted…**.

## Moving pages between spaces

You can copy or move pages between your Private Space and a workspace, or between
two workspaces, on one server or two.

- From your Private Space: right-click a page and choose **Copy to workspace…** or
  **Move to workspace…**.
- From a workspace page: use **Copy to Private Space…** or **Move to Private
  Space…** in the page header, or **Copy to another workspace…** and **Move to
  another workspace…** in its right-click menu.
- Or drag pages onto the other space in the sidebar. Dragging moves; hold
  Alt/Option to copy.

The dialog shows what will travel before anything is sent. Sub-pages, attachments
and links between the pages go with them. A move deletes the originals only after
the other side has every page. A page edited in the meantime is kept.

## The Thoth assistant

The Thoth assistant hands a few pages to an AI tool you already use: Claude Code or Codex, which you install yourself.
It works on copies, and you review every change before anything in your Private Space is written.

Start a task from the mascot in the corner of the window, or press Cmd/Ctrl+J. To give it pages, select them in the
sidebar and choose **Ask Thoth…**. Settings → Thoth assistant holds the tools it can use, earlier runs and
permissions.

## Connected apps (MCP)

AI apps on your computer that speak MCP (the Model Context Protocol), such as Claude Code, Codex, the ChatGPT
desktop app, Claude Desktop or Cursor, can search and read your notes through Thoth. If you let them, they can also
propose changes, which you review before anything is written, and keep a shared memory of what you tell them. It is
off until you turn it on, and it is not available on Windows yet.

1. In **Settings → Connected apps**, turn on **Let other apps read my notes**.
2. Under **Private Spaces apps may read**, tick the ones apps may see. The others stay invisible to apps.
3. Under **Set up an app**, choose **Set up** on the card for Claude Code, Codex and the ChatGPT app, Claude
   Desktop or Cursor. Thoth adds itself to that app's settings, says what it changed, and keeps a backup of any file
   it edits. For another app, choose **Copy the setup** and paste it into the app's MCP settings, or copy the prompt
   under **Any other agent** into the agent and it sets Thoth up from
   [the setup guide](https://thothnotes.com/agents/setup).
4. The first time an app connects, Thoth asks whether it may read your notes. Choose **Allow** or **Deny**. You can
   change your answer later in the list of apps.

Thoth must be running, with the Private Space open in a window, for an app to read it.

- **Memory.** Agents keep what they learn about you as pages in a `Memory` folder of your Private Space, shared by
  all of your agents. You can read and edit them like any page, or choose **Show memories** to see them by kind and
  undo recent changes. Turn off **Agents save memories without asking** to review each one first. With **Let agents
  use my memory folder while Thoth is closed**, agents can still recall and save memories while Thoth is closed.
- **Skills.** A folder in `Skills/` with a `SKILL.md` page is a skill your agents can list and follow. Turn on **Use
  this Private Space's skills in Claude Code and Codex** to use them there too. Agents change a skill only by
  proposing it for your review.
- **Team memory.** Tick a workspace under **Team memory**, and agents can recall and save memories in its `Team
  memory` folder, as you, with your role. Each memory they save there waits for review, unless an owner or manager
  turns review off.
- **Proposed changes.** An app may change pages only when you turn on **May propose changes** for it. Each change
  waits under the bell until you apply it.
- **Requests.** **Show requests** lists every request of the last 30 days: when, which app, what it asked for and
  which pages. It is kept on this computer only, and never holds what a page says or what was searched for.

### First steps with your agent

Your agent's memory starts empty. Once the app is connected, try these two prompts in it:

- "Connect to Thoth and tell me what you remember about me."
- "Ask me 5 short questions about who I am, how I work and what I'm working on, then save my answers to Thoth."

The first one checks the connection; Thoth asks you to allow the app if you have not yet. The second one fills in the
start of your profile, which every agent then reads.

<!-- UNRELEASED: setup-card instructions, remove this comment when the feature ships
To have your agent use its Thoth memory every time, choose **Add the instructions** on the Claude Code or Codex card.
It adds a few lines to `~/.claude/CLAUDE.md` (Claude Code) or `~/.codex/AGENTS.md` (Codex) telling the agent to
recall and save memories in Thoth, after keeping a backup of the file. For Claude Desktop and Cursor, choose **Copy
the instructions** and paste them into the app's own instructions.
-->

## Updates

Thoth checks for a new version when it opens and once a day. When one is out, a
notice appears. Choose **Update**: Thoth downloads the new version, checks that
Thoth signed it, installs it, and asks before restarting. Your changes are saved
first.

In Settings → Updates you can:

- turn off **Tell me when a new version is out**, so Thoth never checks;
- turn off **Download and install updates in the app**, so **Download** opens the
  downloads page instead;
- choose **Check now**.

In-app updates do not work for the Linux .deb. Install a new .deb by hand.

## Getting help and sending feedback

Open Settings → Help and feedback and choose **Send feedback…**. It is also in the
command palette. Choose **A problem**, **An idea** or **A question**, and write your
message. Add your email only if you would like an answer.

Only what you type is sent, and these if you leave them on:

- **Include the app version and system**: you see exactly what is added.
- **Include recent app log**: Thoth shows every line before it is sent. File paths,
  links and email addresses are removed. Check that nothing private is left.

Feedback goes to the demo server, or to another server you are signed in to that
accepts it. If none can take it, write to support@thothnotes.com. The website's
support page at https://thothnotes.com/support/ has the same form.

The app keeps a small log of errors and app events on your computer. It leaves out
page text and titles. To turn it off, untick **Keep an app log on this computer**
in Settings → Help and feedback. Turning it off deletes the log. **Save
diagnostics…** saves the same log to a file.

## Self-hosting

Anyone can run their own Thoth server, with their own sign-in, for their own
workspaces. The desktop app connects to it the same way as to the demo server. The
[self-hosting guide](https://github.com/Creaml4tt3/thoth/blob/main/docs/deploy/self-host.md)
explains the setup step by step.

## Privacy

Your Private Space stays on your computer. The app sends none of your pages
anywhere unless you connect it to a server, and it has no analytics. The update
check sends only the app's version number, and you can turn it off. A link on its own
line can show a preview card, which Thoth fetches from that site; choose **Off** under
Settings → Editor → **Link previews** to stop it. The
[privacy notice](/privacy/) explains what the website, the web app and the demo
server collect.
