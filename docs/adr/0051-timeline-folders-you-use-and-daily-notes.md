# ADR-0051: Timeline, a folder you already use, and daily notes your way

- **Status:** Proposed
- **Date:** 2026-11-04
- **Deciders:** owner (the scope of 0.7.0 below; option C for an Obsidian daily notes folder; Today in workspaces
  waits); implementation agent (the rest, marked "(this ADR)")
- **Refines:** ADR-0001 (the Private Space folder), ADR-0010 (Obsidian compatibility, "open folder in place"),
  ADR-0046 (what stays in `.thoth/`), ADR-0050 (Connections and Today). Second half of step 4 of ADR-0045.

## Context

ADR-0045 step 4 lists four daily habits. 0.6.0 shipped two, Connections and Today (ADR-0050). This ADR covers the
other two, **Timeline** and **Open a folder you already use**, and the follow-ups ADR-0050 left open, for 0.7.0.

What exists (checked in the code on 2026-11-04):

- **Any folder can already be a Private Space, in place.** The folder picker (onboarding, and "Open folder…" in the
  Space switcher) opens any folder, an Obsidian vault included; `Vault.open` indexes what is there. `.thoth`,
  `.obsidian`, `.git`, `.trash` and `node_modules` are skipped by the scan, the tree and the index
  (`IGNORED_DIRS`, `packages/local-store/src/vault.ts`). Opening a folder writes only `.thoth/` (its layout and
  `config.json`); no page is changed and no `thoth_id` is added until the person does something that needs one
  (starring, a transfer, Duplicate). The index lives outside the folder (ADR-0046). Edits made by another app are
  picked up by the watcher and the reconciler; an open page whose file changed on disk is reloaded or shows the
  conflict dialog, never overwritten.
- **Links:** `[[wikilinks]]` resolve as Obsidian resolves them (exact path, relative path, unique basename or path
  suffix, then unique alias; ADR-0010). **Embeds** `![[…]]` are parsed and resolved, but both editors show them as a
  chip ("embedding is not rendered in v1", `packages/app-ui/src/editor/node-views.ts`), pictures included. A page from
  Obsidian that shows a picture with `![[photo.png]]` shows a chip in Thoth.
- **Aliases and tags** are parsed for every page (frontmatter `aliases`/`alias`, `tags`/`tag`, and inline `#tags`
  outside code) and stored in the index (`page_aliases`, `page_tags`); `listPages()` returns them with `mtimeMs`. The
  index has no frontmatter `date` and no created time. Unlinked mentions match only the title (`findMentions(source,
  title)`).
- **Today** (ADR-0050) is fixed to `Daily/YYYY-MM-DD.md` and `Templates/Daily.md`, opened only from the Home card. The
  template is copied as text, with its links rewritten; `{{date}}` stays `{{date}}`.
- **Workspaces:** the tree (`GET …/tree`) gives each page's `updatedAt`, already without pages the reader may not see.
  The server keeps no tags and the tree has no `createdAt`.
- **Obsidian's daily notes settings** are in the vault's `.obsidian/daily-notes.json` (a folder, a date format and a
  template), and its Templates plugin fills `{{date}}`, `{{time}}` and `{{title}}`. The exact keys, defaults and
  format syntax (Moment.js format strings) **must be checked against Obsidian's own documentation and a real vault
  when this is built**; nothing here relies on details beyond those named.

## Decision

### The scope of 0.7.0 (owner)

1. **In:** Timeline; Open a folder you already use (with pictures shown from `![[…]]`); a daily notes setting; the
   Obsidian daily notes folder taken over once (option C); `{{date}}`, `{{time}}` and `{{title}}` in templates; aliases
   in Unlinked mentions; a command and a shortcut for Today.
2. **Not in 0.7.0:** Today in workspaces (needs a choice of workspace, folder and template on every server; proposed
   for after Timeline, ADR-0050 rule 16). Still not planned: a whole-space graph and plugins (ADR-0045 rules 5 and 9).

### Open a folder you already use

3. **The same action, named for what it does** (this ADR). Onboarding offers two choices: **Start a new Private
   Space** (an empty folder) and **Open a folder you already use** (any folder of Markdown files, in place). The Space
   switcher's "Open folder…" becomes "Open a folder you already use…". Both open the folder where it is; nothing is
   copied, moved or rewritten. Importing (a copy, ADR-0010) stays a separate action.
4. **Said before it opens** (this ADR). When the chosen folder already holds Markdown, a short note says that Thoth
   opens these files where they are, edits a file only when you edit it, and keeps a small `.thoth` folder here for
   its own records (ADR-0046 rule 4). When the folder has `.obsidian/`, it adds that Obsidian can keep using the same
   files and that Thoth never changes Obsidian's settings. Obsidian is named here only (ADR-0045 rule 3).
5. **Thoth never writes `.obsidian/`** (ADR-0045). It reads one file there, once, for rule 11. The file API refuses a
   write into `.obsidian/` the way it refuses `.thoth/` content, so no code path can write it by mistake.
6. **Pictures from `![[…]]` are shown** (this ADR). An embed that resolves to an image attachment (PNG, JPEG, GIF,
   WebP, SVG, AVIF) is drawn as the picture, in both editors, the way a Markdown image is (same size limits, same
   alt text: the label, else the file name). A number after `|` is the width in pixels (`![[photo.png|300]]`), as in
   Obsidian; anything else after `|` is the alt text. The source is never rewritten to Markdown image syntax. An embed
   of a page (`![[Note]]`), of a heading or block, of a PDF or of anything else stays a chip that opens the target;
   showing another page's content inside a page is a later decision.

### Daily notes your way

7. **A daily notes setting, per Private Space** (this ADR). Settings → Today: the **folder** (top level allowed),
   the **file name** pattern and the **template** page (or none). Stored in `.thoth/daily.json`, beside
   `order.json` and `favorites.json`, because it is the person's choice for these pages and travels with them
   (ADR-0046 rule 4). A missing or malformed file means the defaults, `Daily`, `YYYY-MM-DD` and `Templates/Daily.md`,
   which are 0.6.0's, so nothing changes for anyone who never opens the setting. Written with the same compare-and-swap
   as `favorites.json`.
8. **File name patterns** (this ADR). Moment-style tokens: `YYYY`, `YY`, `MM`, `M`, `DD`, `D`, `MMM`, `MMMM`, `ddd`,
   `dddd`, text in `[brackets]` kept as written, and `/` for subfolders (`YYYY/MM/YYYY-MM-DD`). Month and day names are
   English, as Obsidian's are by default. A pattern with any other token is refused in the setting, with the reason, so
   Today never makes a file under a name nobody asked for. The setting shows today's file name as a preview. Dates are
   Gregorian in file names (the UI keeps showing Thai dates in the Buddhist era, ADR-0050).
9. **Today follows the setting** (this ADR). It opens or makes `<folder>/<pattern>.md` for the local date, with
   ADR-0050's rules unchanged otherwise: an existing file in any letter case or Unicode form is opened and never
   changed; a page made from the template gets its links rewritten for its place, its title set to the date and a
   new `thoth_id`; a template that is missing gives `# <date>`.
10. **Placeholders in templates** (this ADR). When a page is made from a template (Today, and "New page from
    template" if added later), `{{date}}`, `{{time}}` and `{{title}}` are filled in, and `{{date:<pattern>}}` and
    `{{time:<pattern>}}` with the tokens of rule 8 plus `HH`, `H`, `hh`, `h`, `mm`, `A`, `a`. Defaults: `YYYY-MM-DD` and
    `HH:mm`. Anything else in double braces is left exactly as written. Nothing runs code: no Templater-style
    `<% … %>`, no scripts. Placeholders inside code blocks and inline code are left alone.
11. **An Obsidian daily notes folder is taken over once, if you say so (owner, option C).** When a Private Space is
    opened that has `.obsidian/daily-notes.json` and `.thoth/daily.json` does not exist yet, Thoth reads that file once
    and asks: "Use <folder> for Today, as Obsidian does?" with the folder, the file name pattern and the template
    shown. **Use it** writes those values into `.thoth/daily.json`; **Keep Thoth's** writes the defaults. Either way the
    question is not asked again for that folder, and the setting can be changed later. Thoth never reads Obsidian's
    file again, so later changes in Obsidian are not followed. A pattern Thoth cannot make (rule 8) is shown with the
    reason and only "Keep Thoth's" and "Choose in Settings" are offered.

### Small follow-ups

12. **Aliases in Unlinked mentions** (this ADR). A page's mentions are looked for under its title and each of its
    aliases (the same 3-character minimum, word edges and Thai rules as ADR-0050 rule 4). A row shows which name
    matched. **Link** writes the link to the page with the words as written as its label
    (`[[Bangkok Office|BKK]]` in the Private Space, `[[thoth:page/<id>|BKK]]` in a workspace). Workspaces have no
    aliases on the server, so there it stays the title only.
13. **Today from anywhere** (this ADR). A command "Open today's page" in the command palette, and the shortcut
    **Alt+Shift+T**, beside Alt+Shift+H for Home. Desktop app only, like Today. Mod+Shift+T is not used: in a browser it
    reopens a closed tab, and people expect the same in an app with tabs.

### Timeline

14. **What it is** (this ADR). A view listing pages by date, newest first, grouped by day ("Today", "Yesterday", then
    dates in the UI language). Each row: title, folder, time, tags. A tag filter (one or more tags; a page must have
    all of them) and a choice of **Edited** or **Dated**. Opened from the sidebar, the command palette ("Open
    Timeline") and Home. It reads only what the index or the server already filters; it never opens files to list
    them.
15. **A page's date in the Private Space** (this ADR). **Edited**: the file's modified time (`mtime_ms`). **Dated**:
    the frontmatter `date` when it is a valid date, else the date in a daily note's name (a file in the daily folder
    whose name matches the pattern), else the modified time. The index gets a `page_date` column (frontmatter `date`,
    parsed on reconcile); the schema version goes up, so the index is rebuilt once (it is a cache, ADR-0046). Created
    times are not used: file systems and sync tools do not keep them reliably.
16. **Workspaces** (this ADR). Timeline lists the pages of the tree, which already leaves out pages the reader may not
    see. **Edited** is `updatedAt`. A new server capability, `page-tags`, adds `tags` (frontmatter and inline, parsed
    with the same `parsePage` rules) and the frontmatter `date` to each tree node; the server stores them per page on
    every write, and a migration fills them for existing pages. A server without the capability gives a Timeline by
    `updatedAt` with no tag filter and no Dated choice, and says so. Hidden pages' tags never leave the server, because
    they ride on tree nodes that are already filtered.
17. **Keyboard and screen readers** (this ADR). The list is a `feed`-like list of links grouped under `h2` day headings;
    the filter is a labelled group of toggle buttons; the count of pages shown is announced politely after a filter
    changes. Colours and targets follow the app's WCAG 2.2 AA rules.

### Language

18. **Thai UI text** (this ADR, each string marked `// REVIEW`): Timeline "ไทม์ไลน์", Edited "แก้ไขล่าสุด", Dated
    "ตามวันที่", Open a folder you already use "เปิดโฟลเดอร์ที่คุณใช้อยู่", Start a new Private Space
    "เริ่ม Private Space ใหม่", Open today's page "เปิดหน้าของวันนี้" (as before).

## Consequences

- Positive: someone with years of Obsidian notes opens the same folder, sees their pictures, keeps one daily folder
  and their templates, and can keep Obsidian open beside Thoth.
- Positive: Timeline, the Today shortcut, the daily setting and aliases help everyone, not only people moving.
- Negative: `.thoth/` appears in the folder; a folder kept in git will show it until the person ignores it. Thoth does
  not edit `.gitignore` for them.
- Negative: a server migration (rule 16), so self-hosters update the server for tags in workspace Timelines.
- Negative: embedded pages (`![[Note]]`) still show as a chip, which Obsidian users will notice.
- Negative: the file name pattern is a subset of Moment.js; a vault using other tokens keeps Thoth's default.

## Alternatives considered

- **Follow `.obsidian/daily-notes.json` every time (option A).** Rejected by the owner: Thoth's behaviour would depend
  on another app's settings file and change when Obsidian changes it.
- **Ignore Obsidian's daily folder (option B).** Rejected by the owner: two daily folders.
- **Rewrite `![[photo.png]]` to `![](photo.png)` on open.** Rejected: opening a folder never changes a page.
- **Timeline by created time.** Rejected (rule 15): not kept reliably by file systems and sync tools.
- **Workspace tags from search instead of a capability.** Rejected: one search per tag, and no way to list a tag's
  pages without its word appearing in the text.

## Open questions

- Showing an embedded page's content inside a page (`![[Note]]`, `![[Note#Heading]]`).
- Other dot-folders some vaults hold (`.stfolder`, `.github`): skip them too?
- Today in workspaces (ADR-0050 rule 16), after Timeline.
- "New page from template" as its own command, now that placeholders exist.
