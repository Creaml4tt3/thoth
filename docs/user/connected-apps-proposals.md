# Connected apps: proposed changes

Apps such as Claude Desktop or Cursor can read the Private Spaces you share with them
(Settings → Connected apps). They can also **propose changes**: a new page, an edit, or
something added to a page. Thoth never writes a proposed change by itself. Each one waits
under the bell until you look at it and choose **Apply** or **Decline**.

## Turn it on

1. Open **Settings → Connected apps** and turn on **Let other apps read my notes**.
2. Tick the Private Spaces apps may read. Only those can get proposals too.
3. Set up the app with **Copy the setup**, and connect it once. Thoth asks
   **Let “app” read your notes?**. Choose **Allow**.
4. The first time the app proposes a change, Thoth asks
   **Let “app” propose changes?**. Choose **Allow proposals**.
   You can also turn on **May propose changes** next to the app in
   Settings → Connected apps. It is off until you turn it on, and you can turn it off at
   any time.

Thoth must be running, with the Private Space open in a window, for an app to read it or
propose a change to it.

## Review a proposed change

When an app proposes something, the bell in the sidebar counts it, and its list starts with
**1 proposed change to review** (or the number waiting). Choose it to open
**Proposed changes**. For each change you see:

- the app's name and when it proposed the change;
- the page, and whether it is a **New page**, a **Change** or an **Addition**;
- the difference: lines taken out and lines added.

Choose **Apply** to write it, or **Decline** to drop it. When one app proposed several
changes, **Apply all from** that app applies them one by one.

Thoth checks each change against the page as it is now:

- If the page changed after the app proposed the change (you edited it, or a sync did),
  nothing is written. Thoth shows the difference against the page as it is now. Choose
  **Apply anyway** to replace that version, or **Decline**.
- A new page never replaces a file. If a file is at that path now, decline the change and
  ask the app for another path.

A change you do not review within 7 days expires. At most 100 changes wait at once. The app
can ask what became of each one: pending, applied, declined, expired or conflicted.

Thoth keeps proposed changes on this computer, in the app's own data folder, never in your
notes folder. The request log (Settings → Connected apps → **Requests**) lists each proposal
with the app, the page and the result, never the text.

## The tools an app uses

| Tool | What it does |
|---|---|
| `search`, `list_pages`, `read_page`, `backlinks` | Read the shared Private Spaces. `read_page` also gives the page's `version`. |
| `propose_create_page` | Proposes a new page: a `path`, or a `title` (and a `folder`), and its `markdown`. |
| `propose_edit_page` | Proposes a change to a page, by `path` or `id`: the whole new `markdown`, or `replacements` (`{ find, replace }`, each `find` exactly once in the page). `expected` is the `version` the app read. |
| `propose_append` | Proposes `markdown` to add at the end of a page, or under a `heading`. |
| `list_proposals`, `get_proposal` | What became of the app's own proposals. |

## Porting skills from another notes app

If you used Claude with Obsidian through an MCP server, your skills call that server's tools
to read and write notes directly. Thoth's tools have their own names, and every write is a
proposal you review. Change the skill's instructions as below.

### `/save`: save a summary of the conversation as a new page

Before (writing a note directly):

> Summarise this conversation and write it as a new note in the `Inbox` folder.

In Thoth:

> Summarise this conversation as Markdown. Call `propose_create_page` with
> `folder: "Inbox"`, a short `title`, and the summary as `markdown`. Tell me that the page
> waits for my review in Thoth, and give me the proposal's id.

To add to an existing page instead, use `propose_append` with the page's `path` (and a
`heading` to add under it). For a precise edit, read the page with `read_page`, then call
`propose_edit_page` with `replacements` and `expected` set to the `version` it gave.

### `/catchup`: read recent pages and summarise them

Before (listing and reading recent notes):

> List the notes I changed this week, read them and summarise what I worked on.

In Thoth:

> Call `list_pages` with `folder: "Daily"` and read the pages from the last 7 days with
> `read_page`. Use `search` for the projects they mention. Summarise what I worked on.
> Don't change anything.

Thoth's tools do not give the date a page was changed. Keep dated pages (such as
`Daily/2026-11-02.md`) or dates in titles, so a skill can find recent pages by name. A
catch-up only reads, so it needs no review.

If the skill used to check whether a write worked, have it call `get_proposal` later: the
status says whether you applied it, declined it, or it is still waiting.
