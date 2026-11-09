# Using Thoth

<!-- repo-only:start -->
> The website publishes this page at `/docs/using-thoth/` and its Thai version (`using-thoth.th.md`) at `/th/docs/using-thoth/`.
> The site leaves out this block (between the `repo-only` markers) and every HTML comment. The `#` heading is the
> page's title; each `##` heading becomes an entry in "On this page", so both versions keep the same `##` headings in
> the same order.
>
> Write only what a released version does, with the app's exact labels (`packages/app-ui/src/strings/`,
> `apps/desktop/src/strings/`). If a label or a feature changes, update this page and its Thai version together.
>
> Links: `https:` and `mailto:` links, and paths on the website such as `/privacy/` or `/docs/workspaces/`.
<!-- repo-only:end -->

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

## Privacy

Your Private Space stays on your computer. The app sends none of your pages
anywhere unless you connect it to a server, and it has no analytics. The update
check sends only the app's version number, and you can turn it off. A link on its own
line can show a preview card, which Thoth fetches from that site; choose **Off** under
Settings → Editor → **Link previews** to stop it. The
[privacy notice](/privacy/) explains what the website, the web app and the demo
server collect.
