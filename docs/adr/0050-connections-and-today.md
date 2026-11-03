# ADR-0050: Connections and Today

- **Status:** Proposed
- **Date:** 2026-11-03
- **Deciders:** owner (the two features, a panel per page and not a graph, Today on Home from a template; ADR-0045
  step 4); implementation agent (the rest, marked "(this ADR)")
- **Refines:** ADR-0010 (link resolution), ADR-0029 (Home), ADR-0047 (Duplicate), ADR-0049 (workspace links and
  titles of limited pages). First half of step 4 of ADR-0045; Timeline and "Open a folder you already use" are the
  second half and get their own ADR.

## Context

People who move from Obsidian keep two daily habits: they look at what links to a page and what mentions it, and they
start each day on a daily note made from a template. ADR-0045 names Thoth's versions **Connections** (a panel for one
page: its links, its backlinks, and pages that mention it without a link, with one click to add the link; not a
whole-vault graph) and **Today** (on Home, today's page made from a template).

What exists:

- A Private Space page ends with a Backlinks list (`apps/desktop/src/features/editor/Backlinks.tsx`), read from the
  index (`Vault.backlinks`). The index also holds each page's outgoing links (`Vault.outgoingLinks`) and two full-text
  indexes: words (`unicode61`) and trigrams, the second for Thai, which has no spaces between words (`Vault.search`).
- A workspace page has no backlinks: links there name pages by ID (`[[thoth:page/<id>]]`, ADR-0049) and the server has
  no link index. It has search (`POST …/search`, capability `search`): a case-insensitive substring match over titles
  and Markdown that leaves out pages the reader may not see (the same `HIDDEN` rule as the tree).
- Duplicate (ADR-0047) copies a page and rewrites its links so that they reach the same pages from the copy's place
  (`relinked`). "Duplicate structure only" keeps only each page's title.
- Every page write is a compare-and-swap: on the file's hash in the Private Space, on the revision (`If-Match`) in a
  workspace. An open page's pending edits are written by `flushAll`.

## Decision

### Connections

1. **One panel, where Backlinks was** (this ADR). The page's footer becomes **Connections**: a region with three
   parts, each a heading and a list: **Links from this page**, **Backlinks** and **Unlinked mentions**. It replaces the
   Backlinks list (no second list). The Backlinks part keeps its name and its "(n)" count, so it reads as before. The
   panel is shared by the desktop app and the web client (`@thoth/app-ui`); each space gives it its own source.
2. **What is listed** (this ADR).
   - *Links from this page*: the pages this page links to that resolve, once each, in the order of the first link.
     Links to folders, images and files, and links that do not resolve, are not listed (the editor already marks the
     latter).
   - *Backlinks*: the pages that link here, once each, as before.
   - *Unlinked mentions*: places in other pages whose text contains this page's title and is not a link. One row per
     place, with a few words around it and the title marked. A page that already links here is not searched for
     mentions; one link from a page is enough.
   - Each listed page is a button that opens it (Cmd/Ctrl+click opens a new tab, as on Home).
3. **Unlinked mentions are looked for when asked** (this ADR). The part is a disclosure button ("Unlinked mentions",
   `aria-expanded`), closed when a page opens. Opening it searches; it is searched again when the space changes while
   it is open. This keeps a save from starting a search, and keeps the noise of mentions out of the way until someone
   wants them.
4. **How a mention is matched** (this ADR). `findMentions` in `@thoth/app-ui` (pure, tested):
   - The page's title (the same title Thoth shows: frontmatter `title`, else the file name; a workspace page's title).
     Aliases are not matched yet (open question).
   - Case-insensitive (Unicode simple case folding). Spaces in the title match one or more spaces or tabs, never a
     line break, so the link can be written on one line.
   - **Word edges.** Where the title starts or ends with a letter or digit of a script written with spaces (Latin,
     Cyrillic, Greek…), the character next to it must not be a letter or digit: "Atlas" is not found in "Atlases".
     Thai, Lao, Khmer, Myanmar, Chinese and Japanese are written without spaces between words, so a title in those
     scripts is found inside a run of text: "ทอธ" is found in "ฉันใช้ทอธทุกวัน". In every script a match never ends right
     before a combining mark (a Thai vowel or tone mark above or below), so a match never splits a character as
     people read it.
   - **Very short titles.** A title shorter than 3 characters is not looked for; the part says so. Shorter titles
     find far more noise than mentions, and the Private Space's Thai search needs 3 characters (trigrams).
   - **Not a mention:** text inside a link of any kind (wikilink, Markdown link, autolink, image), inline code, code
     blocks, HTML, and the frontmatter. Matching is done on the Markdown source of plain text runs, so the replaced
     text is exactly what was matched. A title split by formatting ("Project *Atlas*") is not found.
   - **False positives** are expected (a common word as a title, a Thai word inside a longer word). Nothing is changed
     without a click on that one mention, so a false positive costs a glance, not an edit.
5. **One click links one mention, through the normal save path** (this ADR). Each mention row has a "Link" button
   (accessible name "Link the mention in <page>"). It:
   1. writes every pending edit of open pages first (`flushAll`); if one cannot be written, nothing happens;
   2. reads the other page afresh, finds the same mention again (same place and text; else the same occurrence of that
      text), and replaces only those characters;
   3. writes with compare-and-swap on what it just read (`expectedHash` / `If-Match`). If the page changed in between
      (a conflict), it reads it once more and tries again; a second conflict, or a mention that is no longer there,
      writes nothing and says so ("<Page> changed; nothing was written. Try again.", or "The mention in <page> is no
      longer there."). Nothing is ever overwritten.
   4. When the other page is open in an editor with edits typed after the flush, that editor's next save meets the
      new version as a conflict and shows the usual conflict dialog (ADR-0018): nothing is lost silently.
   - What is written. Private Space: `[[Target]]` when the text is exactly the target's shortest spelling that
     resolves from that page (`Name`, else the path without `.md`, as moves write them), else `[[Target|text as
     written]]`, so the sentence reads the same. When no wikilink spelling resolves (a title with `[`, `]`, `|` or `#`),
     a Markdown link with a relative path. Workspace: `[[thoth:page/<id>|text as written]]`. Inside a table cell the
     `|` is written `\|`, which the parser already reads.
   - After a link, the row leaves the list, a live region says "Linked in <page>.", and focus moves to the next
     mention's Link button, or to the disclosure button when none is left.
   - Viewers of a workspace see mentions but no Link button.
6. **Private Space source** (this ADR). Links and backlinks from the index. Mentions: the index's full-text search for
   the title (words, then trigrams, as search does) gives at most **50 candidate pages**; each is read from disk and
   matched. At most **100 mentions** are listed; past that the part says only the first 100 are shown. The panel reads
   the index again when the space's revision changes.
7. **Workspace source** (this ADR). Only pages the reader may see, from answers the server already filters:
   - *Links from this page*: the page's Markdown, its `thoth:page/<id>` links that resolve in the reader's tree (which
     leaves out pages they may not see). A link to a page they may not see is not listed and says nothing about it.
   - *Backlinks*: the server's search for `thoth:page/<id>` (IDs are fixed-length, so the substring is exact). Search
     leaves out pages the reader may not see, so a team-limited page that links here never appears to someone outside
     its teams, nor its title (same rule as ADR-0049 option A). At most 50.
   - *Unlinked mentions*: the server's search for the title; at most **20 candidate pages** are read (one request each),
     then matched as above.
   - The label written is the mention's own text, which is already in that page: a link adds no title, so it reveals
     nothing new (ADR-0049).
   - A server without the `search` capability shows only *Links from this page*.
   - The panel reads again when the workspace's tree changes (the change feed).
8. **Keyboard and screen readers** (this ADR). The panel is a `region` named "Connections" with an `h2`; each part has
   an `h3` and a list; every action is a native button reachable with Tab; counts are in the headings. The disclosure
   uses `aria-expanded` and `aria-controls`. "Searching…", results and link outcomes are announced through one polite
   live region. The marked title in a mention uses `<mark>` and is part of the button's text, so it is read in
   context. Colours and targets follow the app's WCAG 2.2 AA rules.
9. **Not a graph** (ADR-0045). No picture of the whole space; ADR-0045's open question (a small picture of one page's
   neighbourhood) stays open.

### Today

10. **A card on Home in the desktop app** (owner: on Home; this ADR: the form). Above Recent, a button-card **Today**
    with the date in the reader's language and "Open today's page" or, when it does not exist yet, "Start today's
    page". Its accessible name says both. The date shown follows the UI language (Thai shows the Buddhist-era year,
    e.g. "วันพุธที่ 4 พฤศจิกายน พ.ศ. 2569"); the file name does not.
11. **Where daily pages live** (this ADR). In the Private Space's top-level folder **`Daily`**, made when first
    needed. The name is the same in every UI language, so switching language never makes a second folder. Not
    configurable in 0.6.0 (open question).
12. **The file name** (this ADR): the ISO date, `Daily/YYYY-MM-DD.md` (`Daily/2026-11-04.md`), so files sort by date in
    the tree, in Finder and in other apps, and Obsidian's default daily-note format reads the same files.
13. **The template** (this ADR). When `Templates/Daily.md` exists, today's page is made from it: its text, with its
    links rewritten to reach the same pages from `Daily/` (Duplicate's `relinked`), a new `thoth_id`, and its title
    (first `# ` heading or frontmatter `title` equal to "Daily") changed to the date. Images it shows are not copied;
    the link to them is rewritten, so every daily page shows the same image file. When there is no template, today's
    page is `# YYYY-MM-DD` and nothing else. Thoth never makes the template itself; the card says where it is read
    from ("Uses Templates/Daily.md when it exists").
14. **When today's page exists** (this ADR) it is opened, never changed or made again. A file of that name that
    differs only in case or Unicode form counts as existing (`collisionKey`). The write is a create
    (`expectedHash: null`): if another window made the page a moment before, the create fails and that page is
    opened.
15. **Time zone and midnight** (this ADR). "Today" is the computer's local calendar date at the moment of the click.
    The card's label updates at local midnight. A page started at 23:59 stays that day's page.
16. **Private Space only in 0.6.0** (this ADR). A workspace would need a choice of workspace, a folder page by ID and a
    template page by ID on each server, which is settings for every workspace; the web client's Home therefore has no
    Today card yet (open question).
17. **Thai UI text** (this ADR, every string marked `// REVIEW`): Today "วันนี้", Open today's page "เปิดหน้าของวันนี้",
    Start today's page "เริ่มหน้าของวันนี้", Connections "การเชื่อมโยง", Links from this page "ลิงก์จากหน้านี้",
    Backlinks "ลิงก์ย้อนกลับ" (as before), Unlinked mentions "ถูกพูดถึงแต่ยังไม่มีลิงก์", Link "ใส่ลิงก์".

## Consequences

- Positive: the per-page view Obsidian users rely on, in both spaces, with no new index, server route or protocol
  change; a mention becomes a link only on a click, through the same compare-and-swap writes as typing.
- Positive: daily pages are plain dated Markdown files in a plain folder, readable by any app.
- Negative: mention search in a workspace costs one search plus up to 20 page reads each time the part is opened or
  the tree changes while it is open.
- Negative: the Private Space finds mention candidates through the full-text index, which matches word prefixes and
  trigrams; a page whose only mention is split by formatting, or a title of 1–2 characters, is not found.
- Negative: the `Daily` folder and `Templates/Daily.md` names are fixed until a setting exists.
- Follow-up: Timeline and "Open a folder you already use" (second half of step 4, own ADR); the folder setting may
  come with the latter, since an Obsidian folder has its own daily-note folder.

## Alternatives considered

- **A second list beside Backlinks**: two lists about the same links; the brief and ADR-0045 ask for one panel.
- **Scan every page for mentions**: exact, but reads every file of a large space (or every page of a workspace) on
  each search; the search index narrows it to a few pages first.
- **Link every mention at once**: faster, but it edits many pages on one click, and a false positive would be written
  without being looked at. Per-mention clicks keep "no silent changes".
- **Show mentions as soon as a page opens**: a search on every page open and every save; behind a disclosure it costs
  nothing until asked for.
- **A server-side link index for workspace backlinks**: exact and fast, but a protocol and server change; search by
  `thoth:page/<id>` gives the same answer for the pages the reader may see.
- **"Duplicate structure only" for Today** (ADR-0045's words): it keeps only the title, so a template's headings and
  checklists would be lost; Today copies the template's text and reuses Duplicate's link rewriting instead. It also
  does not copy images, which Duplicate does, so a template's picture is not copied once a day.
- **The daily folder named in the UI language** ("วันนี้"): a language switch would start a second folder.
- **A date in the file name in another format** (`4 November 2026`): it does not sort and depends on language.

## Spec references

The ADRs it refines; no section of the architecture handoff changes.

## Open questions

- **Template from "Duplicate structure only"?** ADR-0045 says Today is "built on Duplicate structure only". This ADR
  copies the template's text instead (rule 13), since structure only keeps nothing but the title. Owner to confirm.
- **The `Daily` folder and `Templates/Daily.md`**: fixed in 0.6.0. A setting (and reading an existing Obsidian daily
  notes folder) is proposed for "Open a folder you already use". Blocks nothing now.
- **Template placeholders** such as `{{date}}` and `{{title}}` (Obsidian's core templates have them) are not filled
  in. Worth adding if people moving their templates ask.
- **Aliases** as mention text: not matched yet; adding them is a small change to `findMentions`' input.
- **Today in workspaces** (rule 16): needs a per-workspace choice; proposed for after Timeline.
- **A command and a shortcut for Today**: not added in 0.6.0 (the Home card only).
