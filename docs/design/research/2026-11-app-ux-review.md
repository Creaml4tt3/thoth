# What good note apps share, and where Thoth stands

Research for the Thoth redesign. Date: 2026-11-16.

## How to read the numbers

Each number has a tag:

- **[M]** I measured it. That means pixels in a screenshot (PIL), or computed CSS read from a live DOM with Playwright (`getComputedStyle`).
- **[S]** I read it in a primary source. That means the app's own shipped CSS, its docs, its blog, or Apple's HIG.
- **[K]** It comes from my own knowledge of the app and I did not check it here. Treat it as approximate.

Where a site shows its app as a scaled image, I say so. Only ratios and colours from those images can be trusted, not absolute sizes.

### Sources

- **Obsidian:** `app.css` taken from the installed app at `/Applications/Obsidian.app/.../obsidian.asar`. This is the real shipped theme, about 668 KB. I also read the live HTML mockup on obsidian.md.
- **Linear:** the live HTML mockup on linear.app. It is real DOM at 1:1 scale, styled with Linear's own tokens. I also read the blog posts "How we redesigned the Linear UI (part II)" (linear.app/now/how-we-redesigned-the-linear-ui) and "A calmer interface for a product in motion" (linear.app/now/behind-the-latest-design-refresh), plus the docs pages search.md and account-preferences.md.
- **Notion:** the live public renderer at notion.notion.site, which is Notion's own page engine. I captured the Media Kit page in light and dark, and opened the real search modal. I also read notion.com/help/navigate-with-the-sidebar, Notion's shipped CSS (`--content-width: 708px`), and the app mockup on notion.com, which is a scaled image.
- **Bear:** the app screenshot on bear.app (a scaled image) and the blog post blog.bear.app/2023/07/bear-2-is-here.
- **Craft:** the app mockups on craft.do (scaled images) and support.craft.do/en/write-and-edit/styling/quick-guide.
- **Raycast:** the window image on raycast.com, which looks 1:1 because the window measures 750 px wide, the real size. I also read manual.raycast.com/search-bar and /new-in-v2.
- **Apple:** the HIG pages for sidebars, toolbars, search fields, typography and colour, read through developer.apple.com's JSON data feed. I also read the Notes for Mac user guide pages "Customize how notes appear" and "Change Notes settings".
- **Arc:** skipped. Raycast, Notion and Obsidian cover command palettes well enough.
- **Apple Notes:** I took no screenshot. Driving the user's Notes.app would expose their notes, and Apple shows no app UI on a public page that can be measured.

### Screenshots (kept locally, not in the repo)

| File | What it shows |
|---|---|
| `linear-app-dark.png`, `linear-app-crop.png` | Linear's app mockup (DOM, 1:1), dark |
| `linear-home.png`, `linear-full.png`, `linear-light.png` | linear.app (the site only ships dark) |
| `obsidian-app-dark.png`, `obsidian-app-crop.png` | Obsidian app mockup (DOM), dark |
| `notion-Media-Kit-….png`, `notion-mediakit-dark.png` | A real Notion page, light and dark |
| `notion-search.png` | Notion's real search modal with results |
| `notion-site-try.png`, `notion-What-s-New-….png` | More Notion public pages |
| `notion-app.png`, `notion-home.png`, `notion-docs.png` | Notion app mockup (scaled image) |
| `bear-app.png`, `bear-home.png`, `bear-full.png` | Bear app (scaled image) |
| `craft-app-crop.png`, `craft-doc.png`, `craft-home.png`, `craft-full.png` | Craft app mockups (scaled images) |
| `raycast-window.png`, `raycast-home.png`, `raycast-full.png` | Raycast window, a list with a detail pane |
| `src/` | Raw HTML and CSS pulled from the sites, and the HIG JSON |
| `obs/app.css` | Obsidian's shipped stylesheet |
| `tools/` | Scripts: `shot.mjs`, `probe.mjs`, `ink.py`, `rule.py`, `hig.py` |

---

## Part 1: App by app

### Linear (dark mockup, DOM at 1:1)

**Sidebar**
- Width 240 px (x 60→300, which includes 8 px of outer padding) [M]. Row width 208 [M].
- Rows are 28 tall on a 30 px pitch, radius 8, padding 0 7 [M].
- Icons are 14 px [M]. They are dimmer than the labels: icons rgb(98,102,109), labels rgb(208,214,224) [M].
- Labels are 13 px, weight 510, Inter Variable [M].
- Group labels ("Workspace", "Favorites") are 12 px, weight 510, in the faint grey rgb(98,102,109), on a 24 px row with a small caret [M]. There is about 14 px of space above each group [M].
- The selected row is a neutral fill, rgb(28,29,30) on rgb(19,20,21). That is about +4 % white. The label stays the same [M].
- The 2026 refresh made the sidebar "a few notches dimmer" so the content wins. Its principle: "Don't compete for attention you haven't earned" [S].

**Top bar**
- 44 px tall, with a 1 px rule rgb(36,36,37) [M].
- Left: the issue ID and title at 12 px weight 510, then a star and a "…" [M].
- Right: "1 / 84" and up/down arrows [M]. Icon buttons are 28×28 pills with a 5 % white inset ring [M].
- The 2026 refresh made tabs "more compact rather than spanning the full width", with smaller text and icons, plus icon-only tabs [S].

**Canvas**
- The content panel is raised one step, rgb(23,24,25), against the darker sidebar rgb(19,20,21) and page rgb(8,9,10). It has a 1 px border rgb(36,37,39) and radius 8 [M]. Linear calls this the "inverted L" chrome [S].
- Issue title: 20 px, weight 590 [M]. Section head: 16 px/28 px, weight 590 [M].
- Body: 14 px/21 px in a muted rgb(138,143,152) [M].
- Inline code: 12 px Berkeley Mono, 5 % white fill, 8 % white border, radius 4 [M].
- Metadata: 12 px/14 px in the faint grey [M].

**Command menu and search**
- `/` opens search. It shows recent searches and recent issues before you type [S].
- Matched terms are highlighted in titles [S].
- `@` builds filters. One-letter scopes (`i`, `p`, `u`, `t`, `l`, `f`, `d`) narrow results [S].
- Results are capped at 500, with sort by relevance or date [S].

**Settings**
- Sections: General, Interface and theme, Desktop application, Automations [S].
- Controls are dropdowns and toggles. The settings page is a separate full view with its own left nav [S, K].

**Colour**
- On the mockup screen, the only non-grey pixels are one yellow status icon and one yellow star [M]. Everything else is a neutral ramp. Text: rgb(208,214,224). Muted: (138,143,152). Faint: (98,102,109). Lines: (36,37,39) [M].
- Themes are generated from 3 inputs (base, accent, contrast) in LCH, replacing 98 hand-set variables [S].
- 2026: they moved from "a cool, blue-ish hue" to "a warmer gray that still feels crisp, but less saturated". They avoided going too warm because "the interface risks looking muddy" [S].
- Borders: "Structure should be felt not seen". There are fewer separators, at softer contrast, with rounded ends [S].
- The refresh also uses fewer and smaller icons, and removed the coloured backgrounds behind team icons [S].

**Dark mode**
- Layers step up a few points of lightness: page 8 → sidebar 19 → frame 21 → panel 23 → selected row 28 → chat panel 27–30 [M].
- Text is never pure white. The brightest text is 247 [M].

### Obsidian (shipped app.css, plus the DOM mockup on obsidian.md)

**Sidebar**
- Nav items: 13 px, line height 1.3, padding 4 8 4 24, radius 8 (4 in the site mockup) [S, M].
- Item colour is `--text-muted` (base-70). The active item turns `--text-normal` [S].
- Active and hover use the same fill: `color-mix(oklch, mono-100 6.7 %, transparent)`. That is a neutral 6.7 % ink pill, with no accent and no weight change [S].
- Mockup [M]: sidebar 200 wide, rows 26 tall on a 25.5 pitch, unselected label rgb(179,179,179), selected rgb(218,218,218) on 6.7 % white.
- The ribbon is 44 px. Nested items are indented 12 px (`--nav-item-children-margin-start`) [S].

**Top bar**
- `--header-height: 40px`. Tab font 13 px. The active tab has a 10 px curve and fills with the editor background; inactive tabs are transparent [S].
- The view header is also 40 px, with 8 px gaps and 0 12 padding [S].
- In the mockup, tabs are 32 tall inside a 38 px strip, radius 6 6 0 0 [M].

**Editor**
- `--file-line-width: 700px`, `--font-text-size: 16px`, `--line-height-normal: 1.5` [S].
- `--p-spacing: 1rem`. Heading spacing is 2.5× the paragraph spacing [S].
- Heading sizes: h1 1.618 em at weight 700, h2 1.462 em at weight 600, h3 1.318 em [S]. The inline title uses the h1 size [S].
- Checkbox: 15 px (= `--font-ui-medium`), radius 4, border `--text-faint`, accent fill when checked [S].
- Callout: tinted with its own colour at 10 %, border 0, radius 4, padding 12 12 12 24 [S].
- Table cells: 1 px border, padding 4 8, bold header, tight line height [S].
- Links use the accent colour with no underline, underlining on hover [S].
- Tags are pills: accent at 10 % for the fill, accent for the text [S].

**Command palette (`.prompt`)**
- Width 700 px, max 80 vw. The top sits at (100vh − 70vh)/2 = **15 vh** [S].
- Radius 12, `--shadow-l` [S].
- Input: 40 px tall, 15 px text, padding 24, no border. Only a hairline below it [S].
- Rows (`.suggestion-item`): 15 px text, padding 6 12, radius 4, selected = the same 6.7 % neutral fill [S].
- Matches are shown in **bold**, with no colour [S].
- Footer hints: 12 px muted, centred, 12 px gaps [S].
- With an empty query, recently used commands appear at the top; pinned commands can sit above them [S].

**Settings**
- A modal with a vertical tab nav: items 13 px, padding 4 8, radius 8. Group titles are 12 px, semibold, faint [S].
- Each setting is a row with name and description on the left and the control on the right (`.setting-item-control { justify-content: flex-end }`) [S].
- Name: 15 px, medium weight. Description: 12 px muted [S].
- Row padding 16, 1 px dividers, groups up to 700 px wide, toggles 34–36 px wide [S].

**Empty state**
- Centred column, title at h2 size and weight, max 280 px tall, text-wrap balance [S].
- A short list of text actions follows: create note, go to file, close [K].

**Colour**
- Light greys run #ffffff → #fcfcfc → #fafafa → #f6f6f6 → #e4e4e4 (borders). Text: #222, muted #5c5c5c, faint #ababab [S].
- One accent, hsl(258 88 % 66 %) purple, used for links, tags, checkboxes and the cursor [S].

**Dark mode**
- Base #1c1c1c. The sidebar is lighter than the editor: rgb(38,38,38) against rgb(30,30,30) [M].
- Text #dadada, not white [S]. Borders #333 [S].

### Notion (public renderer, real modal, docs)

**Sidebar**
- Sections, top to bottom: upcoming events, Recents, Favorites, Agents, Teamspaces, Shared, Private. Help and Trash sit at the bottom [S].
- `+` and `•••` appear on hover only [S]. The sidebar resizes by dragging its edge and collapses with ⌘\ [S].
- Default width about 240 px, rows about 28–30 px, 14 px labels, grey icons, selected row a neutral grey fill [K].
- The mockup is a scaled image: neutral pill rgb(222,220,219) on a near-white sidebar, small grey group labels ("Upcoming events", "Agents", "Teamspaces"), coloured dots only for calendar events [M, scaled].

**Top bar**
- 44 px [M]. Breadcrumb on the left at 14 px. On the right: Share (as text), then comment, info, star and "…" as plain icons [M].

**Canvas** (Media Kit page, default width)
- Column 720 px [M]. Shipped CSS has `--content-width: 708px` / `minmax(auto, 720px)` [S].
- Title 40 px/48 px, weight 700 [M].
- Body 16 px/24 px (1.5), in rgb(44,44,43) [M].
- Blocks sit flush, with a 2–8 px gap between them [M, from block rects].
- Callout: fill rgb(249,248,247) on white. That is about 2.5 % ink [M]. Radius about 6, emoji icon, text inset about 45 px [M].
- Dark mode: page rgb(25,25,25), callout rgb(56,56,54) [M].
- Links: grey ink with a thin grey underline [K]. In the screenshot, the email link is the user's chosen red [M].

**Search (real modal)**
- Opens with no dark scrim; the page behind stays white [M].
- Box: 1006 × 652 at x 217, **y 81** (9 % from the top). That width includes a preview pane; the results list is 572 px [M].
- Radius 20, fill white at 90 %, shadow `0 24px 48px rgba(25,25,25,.24)` [M].
- The input row is about 50 px: a 22 px search icon and about 16 px text, with no visible input border [M].
- A "Search results (85)" label at 12 px/500 grey, with a sort control on the right [M].
- Rows: 14 px/500 title, then a breadcrumb path and edit date at 12 px grey, then a 12 px two-line snippet [M].
- The selected row is a neutral fill at about 5 % ink, radius 12 [M].
- Matches: the matching word in the title is primary ink rgb(44,44,43) while the rest of the title is grey (95,94,89). Matches are darker, not coloured [M].
- Footer: "⌘↵ Open in new tab" at 12 px [M].
- Blue (39,131,222) appears only in workspace names in paths and in the "Popular" tags [M].

**Text ramp** [M]: 44,44,43 (primary) · 95,94,89 · 125,122,117 · 161,158,153 (faint).

**Settings**
- A modal with a left nav. Rows have the label plus a description on the left and the control on the right, with dividers [K].

**Empty and first-run states**
- A new page shows a large grey "New page" title placeholder, a one-line grey hint ("Press '/' for commands"), and a few template suggestions [K].

**Colour**
- Chrome is neutral. Colour on screen comes from emoji, page icons and the one blue primary button [M].

### Bear (bear.app screenshot, scaled image: ratios only)

**Layout:** three panes. A dark graphite sidebar rgb(46,50,53), even in the light theme [M]. A light note list. A white editor rgb(255,255,253) [M].

**Sidebar**
- Rows on a 28 px pitch (in image px) [M]. The selected row is a grey pill rgb(70,70,70), radius about 6 [M].
- Icons are outline glyphs in the same grey as the labels [M].
- Pinned tags sit near the top [S].

**Note list**
- The selected note is a light card rgb(244,245,247) with a **4 px red bar** on its left edge [M].
- Each entry: title in bold, 2 lines of preview in grey, a date in faint grey [M].
- Preview size can be small, medium or large [S].

**Editor**
- Title in bold with an emoji [M].
- Body line pitch is about 1.8× the cap-based font size (lines at 461/488/515 in image px) [M]. That is airier than Notion or Obsidian.
- Markup is hidden by default ("Formatting markup now hides for a cleaner look") [S].
- Table: grey header row rgb(232,232,234), 1 px grid lines, small radius [M].
- Accent red rgb(213,78,82) is used for links and for the note-list bar only [M].
- A floating format bar sits at the bottom of the editor: H, checkbox, list, B, I, highlight, link, table, image [M].
- Top-right toolbar: three plain icons (BIU, info, more) [M].

**Themes:** 6 Pro themes added in Bear 2, including "Dark Notes" [S]. A custom font, Bear Sans, is shared with the tag icons [S].

### Craft (craft.do mockups, scaled images; help centre)

**Sidebar**
- A space switcher at the top, then All Docs, Tasks and Calendar [M].
- Group labels "Starred" and "Folders" are small and grey [M].
- The selected row is a soft grey pill [M]. Icons are monochrome grey [M].

**Documents**
- Title in bold sans, with a hairline divider under it [M].
- Checkboxes are small light-grey squares with a radius of about 3 [M].
- Tags are tiny grey pills [M].
- Docs can also be shown as coloured cards in a grid. Craft is the one colourful app in this set [M].

**Page style:** four fonts (System, Serif, Mono, Rounded), backdrops (colour, gradient or image), separators (Line, Washi Tape, Doodle), and a "low contrast warning" with automatic adjustment [S]. Page width can be Regular or Wide [K, from MacStories].

**Lesson:** Craft gets its look from per-document style, not chrome. The chrome itself stays grey and quiet [M].

### Apple Notes and the HIG

**Sidebar (HIG) [S]**
- Show at most two levels of hierarchy.
- Use "succinct, descriptive labels" for groups. Allow collapse with disclosure controls.
- Let people hide the sidebar, but do not hide it by default.
- "Avoid putting critical information or actions at the bottom of a sidebar."
- On macOS, sidebar icons take the accent colour by default; a fixed colour is used only when it carries meaning (Mail's yellow VIP).
- Row height, text and glyph size follow the system's small, medium or large setting.

**Toolbar (HIG) [S]**
- Use at most three groups.
- "Reduce the use of toolbar backgrounds and tinted controls."
- Keep titles under 15 characters.
- "Notes doesn't title the current note when a single window is open." The first line of the note is the title.

**Search (HIG) [S]**
- Placeholder text should say what can be searched.
- Search as the user types.
- Show recent searches or suggestions before typing.
- Put the most relevant results first and group them by category.

**Colour (HIG) [S]**
- "Refrain from adding color to the background of multiple controls."
- Keep the accent for primary actions and status.

**macOS type ramp (HIG) [S]**

| Style | Size / line height |
|---|---|
| Body | 13/16 |
| Headline | 13 bold |
| Callout | 12/15 |
| Subheadline | 11/14 |
| Title 1 | 22/26 |
| Large Title | 26/32 |

**Notes app**
- Settings include "Default text size", "Group notes by date", "Sort notes by" and "New notes start with" [S].
- Notes can show as a list or a gallery [S].
- Selection is a system accent fill (yellow by default) when the window has focus and grey when it does not. Group labels ("iCloud", "On My Mac") are 11 pt bold and secondary. Checklists use round checkboxes that turn yellow when checked [K].

### Raycast (window image, 1:1)

**Window:** 750 × 488 px, near black rgb(18,18,23), radius about 16 [M]. It sits at a fixed spot in the upper-middle of the screen [K]. With an empty query, it shrinks to just the bar (compact mode) [S].

**Search bar:** about 62 px tall. A back chevron, then placeholder text ("Type to filter entries…") at about 20 px, then a filter dropdown on the right. There is no input box, only a hairline below [M].

**Results**
- Rows on a 38 px pitch. The selected row is 38 tall, 286 wide, with a fill rgb(44,42,47). That is about 10 % white, radius about 8 [M].
- Icons are 20 px. Titles are about 14 px [M].
- The section label "Today" is about 12 px grey [M].
- A detail pane sits on the right, with "Information" rows at 12 px (label on the left, value on the right) [M].

**Footer:** an action bar showing "Copy to Clipboard ↵" and "Actions ⌘K", with key caps [M].

**Ranking:** exact alias, then alias prefix, then fuzzy title, then subtitle and keyword, then frecency [S].

**Colour:** chrome is fully neutral. Colour comes only from content: icons and colour swatches [M].

---

## Thoth today (measured from screenshots of the e2e bridge)

All values are [M] unless tagged. The viewport is 1280×800 at 1×.

**Grounds (light)**

| Surface | Value |
|---|---|
| Canvas | rgb(254,250,243) |
| Sidebar and tab strip | (248,240,226) |
| Sidebar border | 1 px (228,220,207) |
| Body ink | (44,40,33). Contrast against the canvas is about 13:1. |

**Grounds (dark)**

| Surface | Value |
|---|---|
| Canvas | (14,12,11) |
| Sidebar | (23,21,20) |
| Selected row | (41,39,37) |
| Text | up to (219,214,204) |

**Sidebar**
- 260 wide (token `--thoth-sidebar-width` [S]).
- Rows on a 28 pitch. The selected row is 28 tall, x 8→251 (8 px inset), radius about 4–6.
- Selected fill: (230,223,210) on (248,240,226), about 8 % ink. The label turns from (105,100,90) to (43,38,31).
- Labels look like 14 px (token ui 14/20 [S]). Icons are 14 px.
- A second grey fill sits on the expanded folder "Projects" (238,230,217). Two rows are filled at once.
- Folder icons are **orange** (122,46,0); file icons are grey.
- The group header reads "My notes" (12 px), then a checkbox icon, then a "Local" pill.
- A bottom bar holds 5 icons: new page, new folder, import, notifications, settings.

**Tab strip**
- 42 px plus a 1 px rule. The active tab is about 200 wide, filled with the canvas colour, with a **2 px orange top line** (182,66,1).

**Page header row**
- A "Local" pill, then "/ Weekend plan.md" (with the extension) in muted 12–13 px.
- On the right: star, download, and a mode toggle (blocks/plain) in a pill.
- Together with the tab strip, about 100 px of chrome sits above the content. The title's cap top is at y 168.

**Editor**
- Column 720 (x 410→1130).
- Title about 28–29 px (cap 21 px). The token says 40 [S], so the rendered size does not match the token.
- H2 about 20 px. Body 16 px (token 16/1.65 [S]).
- To-do rows sit on a **36 px pitch**. The checkbox is 16 px and **8–9 px lower than the centre of its text line** (box centre y 315.5 against text centre 306.5).
- Checked items: the box fills orange and the text is struck through in grey.
- Callout: a **cool grey** (234,235,232) on warm paper, radius about 10, a round "i" badge, a bold title line, 720 wide.
- Links: blue (72,104,141), underlined.
- Table: 160 wide, a bold grey header, horizontal rules only.
- The mascot (48×83, orange) always sits on the canvas at the bottom right.

**Search**
- A centred dialog 600×260 with its top at y 290 (36 % down), radius about 20, fill (250,239,223).
- A heavy scrim: the canvas behind drops from 254 to about 138, roughly 45 % dark.
- It has a title, "Search", and an × close button.
- The input is 44 tall with a **2 px orange border**.
- Each result: a bold title, the file path in **mono**, and a snippet with **literal brackets and missing spaces** ("Weekend [plan] Weekend [planSaturday] at home…"). The selected row is (232,222,208), radius about 8.

**Settings (in a tab)**
- A left nav 160 wide with a "Search settings" field. The selected nav item is neutral (236,232,226).
- Page H1 "Settings" at about 42 px, then section heads at about 26 px.
- Each label (about 15 px) has help text (12–13 px) **above** a native `<select>` (280×38, filled with the container colour).
- The editor mode choice is two full-width radio cards. The selected card has a peach fill (254,215,201) and an orange border.
- Link previews use three pill radios; the selected one is peach.

**Empty tab**
- Logo, "Welcome back" (about 29 px), "Pick up where you left off.", and a blue "Timeline" link.
- A bordered Today card. Recents rows carry "Local" and "Top level" badges. A Favorites empty line.
- The mascot sits in a 96 px box with an orange border.

**Colour on the blocks screen**
- Saturated pixels all fall in the orange hue band: tab line, folder icon, checkbox, mascot.
- Blue links add a second hue.
- The cool grey callout adds a third temperature.

---

## Part 2: Synthesis

### 2.1 Patterns most of these apps share

They are ranked by how much each one explains why the screens look good.

1. **Colour is almost absent from chrome. One accent hue, in a few small places.**
   - Linear's screen has one yellow icon. Notion uses blue only in paths and tags. Obsidian uses purple only in links, tags and checkboxes. Raycast's colour comes only from content. Bear's red is used on links and one list bar.
   - Typical: 95 % or more of pixels neutral. The accent covers under 1 % of the screen, in 2–3 roles: the caret or focus, a checked checkbox, and one primary button or link. Folder and file icons are grey.

2. **Content is the loudest layer. Navigation recedes.**
   - Linear dimmed its sidebar on purpose. Notion's sidebar is off-white next to a white page. Obsidian draws sidebar labels in `text-muted`.
   - Typical: sidebar labels at about 60 % ink, sidebar icons at about 45 % ink and dimmer than their labels, page body at 85–95 % ink.

3. **The selected row is a neutral pill, from the same family as hover.**
   - Obsidian 6.7 % ink. Linear +4 % white. Notion about 5–8 %. Raycast about 10 % in dark. Bear a grey pill.
   - Typical: 5–8 % ink fill, radius 6–8, inset 6–8 px from the sidebar edges, label weight unchanged, label goes from muted to full ink. No accent, no border, and only one filled row at a time.

4. **A small, dense, regular row grid.**
   - Typical: UI text 13–14 px, rows 26–28 tall on a 28–30 pitch, icons 14–16, icon-to-label gap 6–8.
   - Group labels: 11–12 px, weight 500–600, faint (about 40 % ink), sentence case, on 24 px rows with 12–16 px of space above.
   - Actions on a group (`+`, `…`) appear on hover only.

5. **One readable column with plain, consistent rhythm.**
   - Typical: 700–720 px column, 16 px body, line height 1.5 (Notion, Obsidian) to 1.7 (Bear).
   - Page title 32–40 px bold (Notion 40/48 w700; Obsidian 1.618 em, about 26 px).
   - Blocks sit close together, with 2–8 px gaps. Headings get 1.5–2.5× the paragraph space above them.
   - To-do rows sit on the body line pitch (24–26), not looser.

6. **Thin chrome: one bar of about 40–44 px, plain icons, no fills.**
   - Linear 44, Notion 44, Obsidian 40, Raycast's search bar 62.
   - Typical: the breadcrumb or title on the left at 12–14 px muted; at most 3 action groups on the right (HIG); icon buttons 28 px with no bezel.
   - Notes does not even title the note.

7. **Hairlines and tone instead of boxes.**
   - "Structure should be felt not seen" (Linear). Typical: few 1 px (or 0.5 px) lines at 6–9 % ink.
   - Surfaces differ by 2–4 % lightness. Only floating layers get a shadow, plus a 1 px ring.

8. **The command palette sits near the top and is quiet.**
   - Top at 9–15 % of the viewport (Notion 9 %, Obsidian 15 vh). Width 600–750 (Obsidian 700, Raycast 750, Notion's list 572 plus a preview).
   - Radius 12–20. No title and no close button.
   - Borderless input 40–60 px tall with 15–20 px text, and a hairline under it.
   - Rows 32–40 px: a 16–20 px icon, a 14–15 px title, a 12 px muted path or meta line. The selected row is neutral at 5–10 %, radius 4–12.
   - Matches show as bold or darker ink, never as markup characters.
   - Recent items show on open. Footer key hints at 12 px.
   - The scrim is light or absent (Notion: none).

9. **Settings are rows: label and description on the left, control on the right.**
   - Obsidian, Notion, Linear and Apple all do this.
   - Typical: name 14–15 px at weight 500, description 12 px muted beneath it, control right-aligned. Row padding about 12–16, dividers 1 px, column 640–700 wide.
   - Section heads are small (12–13 px semibold, faint, or a modest 16–20 px). Controls are compact: 28–32 px dropdowns and 34–36 px toggles.
   - The selected state of an option is shown by the control itself, not by a coloured card.

10. **Small radii, matched to size.**
    - 4 for content bits (checkbox, inline code, table, tag), 6–8 for rows, buttons and callouts, 12 for popovers and palettes, 16–20 only for whole windows or very large modals.

11. **Blocks are tinted gently, in the page's own hue.**
    - Callout: Notion 2.5 % ink; Obsidian its own colour at 10 %. Radius 4–6, padding 12–16, a 16–20 px icon inline with no badge.
    - Checkboxes are 14–16 px, centred on the first text line.
    - Tables use 1 px hairlines and a bold or tinted header. Inline code gets a 5 % fill and radius 4.

12. **Dark mode is built as steps, not inverted.**
    - Page near black but not pure (8–30), then +3 to +8 per layer up.
    - Text 85–92 % white (Linear 208–247, Obsidian #dadada). The accent is lightened. Borders are very low contrast.

13. **Empty states are calm and short.**
    - One title line at heading size, one plain sentence, and 1–4 text actions, all on the same type scale.
    - Little or no illustration. Badges and metadata are left out.

14. **One sans family, few weights, a short scale.**
    - Inter or the system font. Weights 400, 500 and 600–700. Sizes 12 / 13 / 14 / 16 / 20 / 28–40.
    - Slight negative tracking on large titles. Mono only for code.

### 2.2 Side by side

| # | Pattern (typical value) | Thoth today (measured) | Gap |
|---|---|---|---|
| 1 | One accent in 2–3 small roles; icons grey | Orange in: tab top line, folder icons, checkbox, 2 px search input border, settings cards and radios, mascot, mascot frame. Blue links. A cool-grey callout. | **Large.** About 7 orange roles and 2 hues. |
| 2 | Navigation recedes: labels about 60 % ink, icons dimmer | Labels (105,100,90), about 60 % ✓. Folder icons darker and orange. File icons (67,61,54) darker than the labels. | Medium: icons are louder than labels. |
| 3 | Selected row: neutral 5–8 % pill, radius 6–8, one at a time | About 8 % pill, 8 px inset ✓. Radius about 4–6. An expanded folder also gets a 5 % fill. | Small: drop the second fill; radius 6. |
| 4 | Rows 26–28 on a 28–30 pitch, 13–14 px text, 24 px group rows, hover-only actions | 28 pitch ✓, 14 px ✓. The header shows a checkbox icon and a "Local" pill all the time. A 5-icon bottom bar. | Small to medium. |
| 5 | 700–720 column, 16/1.5–1.65, title 32–40, to-dos on the body pitch | 720 ✓, 16 ✓. Title about 28 (token 40). To-do pitch 36. Checkbox 8–9 px low. | Medium: the checkbox offset is a visible bug. |
| 6 | One 40–44 bar of chrome | A 42 tab strip plus a 56 header row with a pill and a ".md" path. | Medium. |
| 7 | Hairlines and tone, few boxes | Mostly ✓. Bordered Today card, bordered radio cards, the callout as a solid grey slab. | Small. |
| 8 | Palette top at 9–15 %, 600–750 wide, borderless input, bold matches, light scrim | Centred at 36 %. A title and a close button. A 2 px orange input border. A mono path. Literal [brackets] with missing spaces. About 45 % dark scrim. Radius 20. | **Large.** It is the screen that looks least finished. |
| 9 | Settings as rows: label left, control right, 12 px descriptions, compact controls | Label above control. Native selects 38 tall. Full-width peach radio cards. 42 px H1 plus 26 px section heads. | **Large.** |
| 10 | Radii 4 / 6–8 / 12 / 16–20 | Callout about 10, search about 20, tab and pill radii mixed. | Small. |
| 11 | Callout 2.5–10 % in the page hue, radius 4–6, icon inline | Cool grey about 8 % on warm paper, radius about 10, a round "i" badge. | Medium: the temperature clash is visible. |
| 12 | Dark as steps, text 85–92 %, accent lightened | Canvas 14, sidebar 23, selected 41, text about 86 %, lighter orange ✓. | Small. Already good. |
| 13 | Calm empty state | Logo, title, link, bordered card, 2 badges per recent row, the mascot in an orange frame. | Medium. |
| 14 | One sans family, short scale | Inter ✓. Mono used for file paths in search and backlinks. Uppercase "CONNECTIONS" label. | Small. |

Thoth already matches the leaders on the column width, body size, row pitch, row inset, the inverted-L chrome (tab strip in the sidebar colour), the warm ink-opacity ramp, and the dark-mode steps. Most of the gap is colour spread, plus three screens: search, settings and the to-do/callout blocks.

### 2.3 Changes, most impact first

1. **Cut orange down to three roles: the caret and focus ring, a checked checkbox, and the one primary button per screen.**
   - Folder and file icons become one grey at about 45 % ink: (128,121,110) on paper, (125,120,112) in dark.
   - The active tab loses its orange line. Its canvas fill and full-ink label are enough.
   - Settings option cards lose the peach fill and orange border (see change 3).
   - Expected result: the orange pixel area falls below 1 % of the window.

2. **Rebuild search as a palette.**
   - Position: top at 12 % of the window (about 96 px at 800 high), width 640, radius 12, `--thoth-shadow-modal`.
   - Scrim: 12 % ink in light and 40 % black in dark, or none.
   - No title and no ×; Esc closes it.
   - Input: 52 px row, 16 px text, a 16 px search icon at 16 px from the left, no border, a 1 px hairline at 9 % ink below.
   - Rows: 40 px for one line, 56 px with a snippet. Each row has a 16 px page icon, a 14 px/500 title, and a parent path at 12 px muted in sans (no ".md").
   - Snippet: one line at 12 px muted. The matched words are drawn at weight 600 in full ink, with no brackets and with spaces kept.
   - Selected row: 6 % ink, radius 8, inset 8.
   - Show recent pages before the user types.
   - Footer: 32 px, with "↑↓ to move · ↵ to open · esc to close" at 12 px muted.

3. **Rewrite settings as rows.**
   - Column max 680.
   - Page title 24 px/600, or none, because the tab already says "Settings".
   - Section heads: 13 px/600 in full ink, 32 px of space above, 8 px below.
   - Each row: min height 52, 12 px vertical padding, 1 px divider at 7 % ink. Name 14 px/500 with the description below it at 12/16 muted, max width about 60 % of the row. The control is right-aligned.
   - Controls: custom dropdowns 28–30 px tall with radius 6, 13 px text and a grey chevron; toggles 32×18; segmented controls 28 px tall.
   - The Blocks/Plain choice becomes a dropdown or a 2-part segmented control with the description underneath.
   - Selected states are neutral: a white or raised segment with a 1 px ring.

4. **Fix to-do alignment and spacing.**
   - Centre the 16 px box on the first line box: top offset = (line height − 16) / 2. That is 5 px at 26 px line height.
   - To-do row pitch = body line height plus 2–4 (28–30 px instead of 36).
   - Checked: orange box, text at about 45 % ink, strike-through kept.

5. **Callout in the page's own hue.**
   - Fill at 4 % ink in light (about (243,238,229) on (254,250,243)) and 6 % white in dark.
   - Radius 6, padding 12 16, no border.
   - The type icon is 16 px inline, in the callout's text colour, with no round badge.
   - Title at weight 600 and body size. Drop the cool grey.

6. **One bar of chrome above the page.**
   - Merge the breadcrumb row into a single 40 px bar under the tabs, or into the tab strip area.
   - Breadcrumb: 13 px muted, parent folders plus the page title, with no ".md" and no "Local" pill when only one space is open.
   - Right side: 28 px plain icon buttons in no more than 3 groups.
   - Tabs: strip height 36–38, tab label 13 px, active tab radius 8 8 0 0.

7. **Quieter sidebar.**
   - Width 240 (keep it resizable).
   - Only one filled row: remove the fill from expanded folders.
   - Radius 6.
   - The group header becomes "My notes" at 12 px/500 in about 45 % ink. Show the "Local" badge only when two or more spaces are open. Show the header's actions only on hover.
   - Move New page, New folder and Import into the header's `+` and `…` menus. Keep notifications and settings at the bottom (HIG: no critical actions at the bottom).

8. **Title and heading scale.**
   - Page title 32 px/1.2, weight 700, tracking −0.02 em, 8 px below.
   - H2 22/1.3 at weight 600 with 24 px above. H3 18/1.4 with 16 px above.
   - Body stays 16/1.6. The gap between blocks is 4 px.
   - Make the token and the rendered title agree.

9. **Links: one decision for the second hue.** Option A, the calmest: page links in ink with a 1 px underline at 30 % ink, offset 3 px, which turns full ink on hover (the Notion way). Option B: keep blue, but only for links, and nowhere else on the screen (Notion search shows blue in paths too, so blue must not spread). The owner should pick. The tokens already say "blue is secondary only".

10. **Calmer empty tab.**
    - Recents rows match the sidebar rows (32 px, a 14 px icon, the title, and a parent path in 12 px muted).
    - No "Local" or "Top level" badges.
    - Today becomes a plain row, not a bordered card.
    - The mascot sits without the orange frame.
    - Keep "Welcome back" (about 28 px) and one sentence.

11. **Mascot on the writing canvas.** This is the owner's call; the mascot replaces every mascot by decision. Measured fact: at 48×83 in saturated orange, it is the largest coloured object on the editor screen. A calmer setting: 32 px tall while a page is open, or dim it to 60 % opacity while the user types, and keep it full size on empty and home screens.

12. **Small consistency pass.**
    - Radii: 4 for checkbox, code and tag; 6 for rows, buttons and callouts; 12 for popovers and the palette; 16 only for the onboarding window.
    - Use sans for file paths shown to people. Keep mono for code.
    - Use sentence case for small labels ("Connections", not "CONNECTIONS").

## Limits of this research

- Bear, Craft and Notion's app mockups are scaled marketing images. Treat their sizes as ratios.
- I captured no Apple Notes app UI. Its selection and checklist details are [K].
- Linear's ⌘K palette size, Notion's settings layout and Notion's sidebar sizes are [K]. Linear's public docs do not give them.
- Thoth's title size and to-do pitch come from one 1280×800 capture. I did not check them at other zoom levels or with Thai text.
