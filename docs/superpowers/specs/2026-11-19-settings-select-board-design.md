# Settings pages, Thoth select, and Board: design

- **Date:** 2026-11-19
- **Owner decisions:** in the conversation of 2026-11-19 (Main Thread). Calls the Main Thread made are marked
  "(our call)".
- **Ships in:** 0.12.0, together with OCR (`docs/architecture/ocr-plan.md`), which gets its own design. Order of work:
  Settings + select → Board → OCR.
- **Not in this release:** moving the marketing website to Astro. The site is already static (home page ≈15 KB
  compressed, ≈5 KB of JS in total); Astro would not make it faster. Revisit only if the site grows into many
  hand-edited pages. The Head of Marketing thread owns the site and is told.

## Why

The owner wants Thoth to look and feel finished before OCR lands, and wants a "second brain" that is fast,
reliable and smart (see the 2026-11-19 brainstorm and the Game Pasut posts: people want to *see* how their ideas
connect, like Obsidian's graph, and Thoth has none). Three parts:

1. **Settings** is one long page with a 160 px list that scrolls to sections. It feels cramped and endless.
2. **Dropdowns** are the operating system's own (17 `<select>`s in 8 files). They are the one control that looks
   like macOS or Windows instead of Papyrus Black.
3. **Board**: a visual view of notes and how they connect. Like a detective's board: sticky notes pinned up,
   joined by string. It should make Thoth look good and be satisfying to use, and it must be Thoth's own, not a copy of
   Obsidian's floating dots.

## Part 1: Settings as separate pages

### Owner decisions

- Each section becomes its own page, like a game's settings menu. No long scrolling page.
- The side list gets wider, and each section gets an icon.

### Design

- `SettingsLayout` (`packages/app-ui/src/ui/SettingsLayout.tsx`) keeps its props (`sections`, `children`) but shows
  **one section at a time**: the chosen section's `<section>` is shown, the others are `hidden`. The list is a
  vertical tab list (`role="tablist"`, `aria-orientation="vertical"`, arrow keys move, Enter/Space choose, roving
  tabindex), each section a `role="tabpanel"` labelled by its tab. (our call: tabs, because exactly one panel shows)
- Side list width 220 px (from 160 px) (our call). Below the existing narrow breakpoint it stays above the content, as
  today, as a horizontal scrolling row of tabs.
- Each `SettingsSectionLink` gains `icon: IconName`. New icons are drawn in `Icon.tsx` in its style (24 grid, 1.8
  stroke, round caps). Mapping (our call): Appearance → palette/half-moon, Editor → pen, Private Space → folder,
  Today → sun, Import & export → import (exists), Servers → server/cloud, Agents → sparkle (exists), Connected apps →
  plug, Notifications → bell (exists), General → gear (exists), Help & feedback → speech bubble.
- **Search** stays above the list and still searches every section, including hidden ones: while the box has text,
  the layout shows every matching part of every section (today's filter, unchanged), grouped under section headings.
  Clearing the box returns to the chosen section. A click on a result's section heading chooses that section. (our call:
  search-all is the reason a long page had value; keep it)
- **Deep links keep working.** `openSettings({ section })` (tab target `{ kind: "settings", section }`) opens that
  section's page. Today's sections `servers | agents | import | today` keep their names. The last chosen section is
  remembered for the session only (our call), and Appearance is the default.
- The web app's `SettingsView` (`apps/web/src/SettingsView.tsx`) uses the same layout and gets the same behaviour.
- Tests: the existing settings tests are updated (scroll-to-section → choose-tab); new tests cover keyboard moves,
  deep links, and search across hidden sections.

## Part 2: Thoth select (replaces native dropdowns)

### Owner decision

Use Thoth's own dropdown instead of the operating system's, for a consistent look. The owner asked for a
recommendation. **Recommendation, accepted:** one shared component, built in-house, no new library.

### Design

- `Select` in `packages/app-ui/src/ui/Select.tsx`: a button showing the current value plus a chevron, which opens a
  listbox on the raised surface (`--thoth-bg-container`, outline, menu radius and shadow). Same visual language as the
  existing menus: neutral `--thoth-bg-active` highlight, a check mark on the chosen option, no Moon wash (ADR-0053
  amendment).
- The WAI-ARIA "select-only combobox" pattern: `role="combobox"` button with `aria-expanded`, `aria-controls`,
  `aria-activedescendant`; `role="listbox"` with `role="option"` + `aria-selected`.
  Keys: Enter/Space/Alt+Down open; Up/Down/Home/End move; typing letters jumps (type-ahead, Thai included); Enter
  chooses; Escape closes without changing; Tab chooses and moves on. Focus stays on the button. It opens upward when
  there is no room below and is clamped to the window.
- API close to `<select>` so call sites change little: `value`, `onChange(value)`, `options: { value, label,
  description?, disabled? }[]`, `aria-label` / `aria-labelledby`, `disabled`, `id`, `name`.
- Reduced motion: no open animation. Forced colours: system colours, as the other menus.
- Replace all 19 native `<select>`s (desktop and shared: AgentSettings ×4, Bubble ×4, TransferDialog ×3, SettingsView ×2,
  MemoriesView, MoveToDialog, TimelineView, MembersDialog; web: LanguageSwitch, ThemeSwitch). Any test that drives a native select (`selectOptions`) moves to the new
  roles.
- `contrast.test.ts` gains the select's pairs (option text on container, highlighted option, disabled option).

## Part 3: Board

### Owner decisions

- **A new view, separate from Connections.** The Connections panel (ADR-0050) stays as it is. ADR-0045 says Thoth
  has "no graph view"; a short amendment (in the new ADR below) allows a Board as its own view and keeps Connections as
  the panel.
- **Both an Overview and the user's own boards** (option C).
  - *Overview:* every page of the Space, laid out by Thoth, for spotting clusters and stray notes.
  - *Boards:* cases the user builds ("OCR research"). The user pins the notes they choose and places them by hand,
    and they stay put. Pages linked to the board but not pinned show as faded "pin?" suggestions.
- **Drawing string between two notes adds a real link** (option C of the first question).
- **Look:** the paper desk of Papyrus Black (warm paper with a faint dot grid, a soft black board in dark mode) with
  **sticky notes**: square, curled corner, an orange push pin, tag chips in the Moon soft wash. A note's colour is its
  folder's colour from the sidebar (the 8 colours, `colors` from the order record), or the nearest coloured parent
  folder's (our call: `Projects/2026/x.md` takes `Projects`' colour); cream when none has one.
  The selected note's strings turn Moon orange (glowing slightly in dark mode). Mockups:
  `.superpowers/brainstorm/11459-1795092475/content/board-look-v2.html`, option B, light and dark.
- **Boards are `.canvas` files in the Space** (JSON Canvas 1.0, the open format Obsidian uses), next to the notes
  and backed up with them. Obsidian can open them.
- **Rendering:** sticky notes are real DOM elements, strings are one SVG layer, and the whole board is moved by CSS
  transform (pan and zoom). No `<canvas>` drawing. Reason: accessible by default, theme and fonts for free, the look of the
  mockup exactly, about a third of the work of canvas drawing.

### Scope

- Private Spaces only. Shared workspaces have no link index on the server, so Board there comes later (our call).
- Desktop app. The web app is trial-only (ADR-0015) and shows workspaces, so no Board there in this release.

### Where it lives

- A new tab target `{ kind: "board"; path?: string }`: no `path` means the Overview; `path` is a `.canvas` file.
  Opened from a "Board" entry in the sidebar (next to Home and Timeline) and from the command palette. A `.canvas` file
  in the tree opens as a board. (our call)
- A small header in the tab: a board switcher (Overview, then the Space's boards by name), **New board**, zoom
  controls (−, %, +, fit), and on a board, **Add note** (search a page to pin).

### What a note shows

Title (bold), the first line or description of the page (muted, two lines at most), up to three tag chips
(`#idea`), the pin. Size fixed at about 160×120 px on screen at 100 %. Thai text wraps as in the editor.

### Interactions

- **Open:** click (or Enter) opens the page; Cmd/Ctrl+click opens a new tab, as elsewhere.
- **Select:** a single click selects (its strings turn Moon); a click on empty paper clears it.
  *(our call: click = select, double-click or Enter = open, so dragging and drawing don't open pages by accident.
  Cmd/Ctrl+click = open in a new tab.)*
- **Move:** drag a note. It lifts (shadow grows, tilts ~3°) while dragged and settles with a short wobble on drop.
  On a board, the place is saved. In the Overview, positions are not saved; it is Thoth's layout (our call).
  Keyboard: with a note selected, arrow keys move it by 8 px (Shift: 40 px).
- **Pan and zoom:** drag empty paper or the trackpad to pan, pinch or Ctrl/Cmd+scroll to zoom (10 %–200 %), fit
  button, keyboard +/−/0.
- **Draw string (adds a link):** drag from a note's pin onto another note. The string follows the pointer and snaps
  taut on drop. Thoth appends one link to the target on a new last line of the *source* page, spelled by the
  same `linkText` the Connections "Link" button uses (`apps/desktop/src/features/editor/PrivateConnections.tsx`): a
  wikilink when one resolves, otherwise the Markdown link it falls back to. So the string drawn is always a link the
  index resolves. It goes through the same compare-and-swap write; if the page changed meanwhile, it re-reads and
  tries once, then says so. (our call: reuse the proven code) Dropping on the paper or on the same note cancels. Keyboard alternative: on a
  selected note, the context menu's **Link to…** opens the page search.
- **Pin a suggestion:** click a faded note (or its "+") to pin it to the board, placed where it is.
- **Remove from board:** context menu → **Remove from board** (the page itself is never touched).
- **Undo:** Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z on the board undo and redo every board action of this tab: moves, pins,
  removals and drawn links. A drawn link is undone only if its line is still the page's last line and unchanged;
  otherwise Thoth says so and leaves the page. The history ends when the tab closes. (our call)
- **Context menu on a note:** Open, Open in new tab, Link to…, Remove from board (boards only), Reveal in sidebar.
- **Reduced motion:** no lift tilt, wobble, glow or animated string; positions change at once.

### Overview layout

- d3-force (`d3-force`, ≈ 15 KB, ISC licence; added to THIRD-PARTY-LICENSES) for a force layout: links pull, notes
  push apart, unlinked notes drift to the edge. Runs to rest once when opened (in a worker if it takes > 50 ms), then
  stays still; dragging a note nudges its neighbours, but nothing floats on its own. (our call: calm, not wobbly)
- Positions are cached for the session so reopening is instant; not saved to disk.
- **Large Spaces:** below ~40 % zoom, notes draw as small coloured squares with no text (one SVG), so the
  Overview stays smooth to a few thousand pages. Above that, only notes in view are in the DOM.
- Filters in the header: by tag, by folder (our call; cheap with the index).

### Boards (`.canvas` files)

- Format: JSON Canvas 1.0 (`{ nodes: [...], edges: [...] }`). Each pinned page is a `file` node (`file` = the page's
  vault path, `x`, `y`, `width`, `height`, optional `color`). Thoth does **not** store strings as canvas edges: strings
  are drawn from the pages' real links (the index), so they are always true. Edges and other node types (`text`,
  `link`, `group`) written by Obsidian are kept untouched and drawn plainly (text cards as plain cards, groups as a
  labelled frame), so a round trip never loses anything. (our call)
- Thoth writes the file with the vault's compare-and-swap write and keeps unknown fields. A save is debounced (~500 ms
  after the last move). If the file changed meanwhile (Obsidian open on the same board), Thoth re-reads it, re-applies
  only its own changes by node id (moved positions, added and removed nodes) on top of the new file, and writes again;
  everything else in the file wins. A node the other app deleted that Thoth only moved stays deleted. (our call)
- New board: name it, a `<name>.canvas` file is created in the current folder (the sidebar's selected folder, as
  New page does). Starting a board from a page ("Board from this page" in the page menu) pins the page and its
  direct neighbours, laid out around it.
- Suggestions: pages that link to or from any pinned page and are not pinned, at most 12, as faded notes near
  their strongest neighbour.
- When a pinned page is moved or renamed, the vault's move rewrites the `file` path in `.canvas` files the same way it
  rewrites links (`Vault.move`'s rewrite step). A pinned page that no longer exists shows as a grey "missing"
  note that can be removed.

### Data the Board needs (all in the index already)

- Pages: id, path, title, tags (`page_tags`), date, folder.
- Links: `refs` (`source_page_id`, `target_path`, `resolution = 'resolved'`).
- New: one `Vault.graph()` read that returns every page (id, path, title, tags, first line) and every resolved link
  as pairs, in two queries, so the Overview is one call. The first line of a page comes from the stored snippet or
  the FTS text (builder picks the cheapest that exists).
- Folder colours: the order record the sidebar already reads.

### Accessibility

- The board is a `role="application"` region with a label and short instructions (arrow keys, Enter, context menu
  key); notes are focusable buttons (`aria-label` = title, tags, number of links); Tab walks notes in reading order
  (top-left to bottom-right); a "List view" toggle shows the same notes and links as a plain list for screen readers
  and keyboard users who prefer it. (our call)
- Strings have no focus of their own; a note's links are announced through its label and the Connections panel.
- Contrast: note text on every folder colour (light and dark) passes 4.5:1; tested in `contrast.test.ts`.

### ADR

ADR-0056 "Board" (ADR-0055 is reserved for OCR): records the Overview + boards, the `.canvas` format,
links-not-edges, DOM + SVG rendering, Private Spaces first, and amends ADR-0045's "no graph view".

### Strings

English and Thai for every new label (Board, Overview, New board, Add note, Link to…, Remove from board, Pin to
board, List view, zoom controls, missing note, empty states). Thai marked `// REVIEW`.

## Goals

- Settings feels roomy and easy to find your way around; every dropdown looks like Thoth.
- Board: opening the Overview of a few hundred notes feels instant and looks beautiful; building a case board and
  linking two notes by string is satisfying and safe.

## Non-goals

- Board in shared workspaces or the web app (later).
- Free-text cards, images or groups *created* in Thoth on a board (only kept if Obsidian made them).
- A live, constantly floating physics graph.
- Astro for the website.

## Anti-goals

- A string drawn on the board must never overwrite a change the user made in the page meanwhile, and must never
  write anything other than one link line.
- A `.canvas` file Thoth saves must still open in Obsidian with nothing lost.
- The new dropdown must never be harder to use from the keyboard or a screen reader than the native one was.

## Left to the builder

Exact icon drawings, spacing and motion timings within the existing tokens; the d3-force parameters; how to
virtualise notes outside the view; test layout.
