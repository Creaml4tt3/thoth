# Import formats: Notion and Obsidian (research notes)

Status: research, 2026-10-20. Supports ADR-0010 and spec sections 7 and 17.
Re-check before implementing; the source formats can change.

Legend:
- **VERIFIED**: seen in official docs, or in the open-source Obsidian Importer
  source code (MIT, github.com/obsidianmd/obsidian-importer).
- **VERIFIED-2**: seen in a reputable third-party tool's README/tests, not in
  official docs or Obsidian's own code. Treat as strong evidence, not proof.
- **INFERRED**: assumption or recollection. Confirm against a real export.

Important caveat: until 2026-10-22 no real Notion export was available; section 1.0 records the one small real export seen since. The Obsidian Importer
reads Notion's **HTML** export, not Markdown, so its code confirms ID, ZIP and
attachment conventions but not Markdown link or property syntax. Markdown
details rest on third-party tools (VERIFIED-2) or inference.

## 1. Notion "Markdown & CSV" export

### 1.0 Observed in a real export (2026-10-22)

The owner supplied one small, real workspace export (20 entries, 26 KiB). Only
its structure is recorded here. Its content is private and is not committed.
These observations override the matching INFERRED rows below.

| Observation | Status |
|---|---|
| The download is named `<uuid>_Export-<uuid>.zip`. Inside, everything sits under one `Export-<uuid>/` folder. No `ExportBlock-` prefix, no nested `Part-N` ZIPs at this size. | OBSERVED |
| Top-level folders below the wrapper are sidebar sections: `Private & Shared/` and a teamspace folder `<Owner>'s Notion HQ/<32hex>/` whose second level is an ID-only folder. | OBSERVED |
| Uploaded files are not next to the page. They sit in a root-level `attachments/<uuid>/<file name>` folder and are linked as `../attachments/<uuid>/<url-encoded name>`. | OBSERVED (contradicts the per-page folder layout in 1.6 for this export) |
| Entry names are UTF-8. Thai names set the ZIP UTF-8 flag (0x800); ASCII-only names do not. | OBSERVED |
| A database page is a short `.md` (H1, a link to its CSV, then plain-text `filters:` / `sort:` lines). Only the `_all.csv` variant was present; no view-only `.csv`. | OBSERVED |
| CSV files are UTF-8 **with a BOM**, RFC 4180 style, header row first. | OBSERVED |
| Row pages: H1, blank line, then `Key: Value` property lines, no YAML frontmatter. | OBSERVED |
| Links to child databases are URL-encoded relative paths with literal `(` `)` left unencoded (`Sheet%20(TR)/Name%20<id>_all.csv`). Parentheses in attachment names are encoded (`%28` `%29`). | OBSERVED |
| Callouts are `<aside>` HTML blocks; in this export without an icon `<img>`. Code blocks are fenced; tables are pipe tables. | OBSERVED |

Import result with the current importer: completed, 15 pages, 1 attachment,
4 databases, 0 failed, 5 of 5 internal links resolved, 8 external links left
unchanged. Fix made from it: the default destination folder no longer copies
the `<uuid>_Export-<uuid>` name (`importFolderName`). Not covered by this
sample: large multi-part exports, images, toggles, comments, `notion.so` links
to pages outside the export, and title truncation.

Sources:
- N1 https://www.notion.com/help/export-your-content (official)
- N2 https://github.com/obsidianmd/obsidian-importer/blob/master/src/formats/notion.ts
- N3 https://github.com/obsidianmd/obsidian-importer/blob/master/src/formats/notion/notion-utils.ts
- N4 https://github.com/obsidianmd/obsidian-importer/blob/master/src/formats/notion/parse-info.ts
- N5 https://github.com/obsidianmd/obsidian-importer/blob/master/src/formats/notion/convert-to-md.ts
- N6 https://github.com/obsidianmd/obsidian-importer/blob/master/src/formats/notion/clean-duplicates.ts
- N7 https://obsidian.md/help/import/notion (official Obsidian docs)
- N8 https://github.com/bitbonsai/notion2obsidian (README and test file)
- N9 https://github.com/2002Bishwajeet/journal/issues/595 (issue text only)

### 1.1 ZIP layout

| Fact | Status | Source |
|---|---|---|
| Export is a ZIP with CSV for databases and Markdown for pages. Non-database pages export as `.md`; full-page databases export as CSV plus a Markdown file per subpage. | VERIFIED | N1 |
| "Include subpages" toggle exports contained pages as separate files. | VERIFIED | N1 |
| Notion creates nested folders for subpages. "Create folders for subpages" can be unchecked to flatten everything into one folder (Windows 260-char path limit workaround). A flat export therefore has no folder to infer parentage from. | VERIFIED | N1 |
| Large exports may be delivered by email link (valid 7 days; workspace exports can take up to 30 hours). | VERIFIED | N1 |
| Large exports can contain nested ZIPs. The inner archives are named `Export-{uuid}-Part-N.zip`, inside an outer `{uuid}.zip`. | VERIFIED | N7 (official Obsidian docs): "import the nested `Export-{id}-Part-1.zip` files" |
| Importer only recurses into a nested ZIP when it is at the ZIP root (`entry.parent === ''`); deeper ZIPs are user attachments and must be treated as ordinary files. | VERIFIED | N2 `processZips` |
| Some exports wrap everything in a synthetic root folder `Export-<uuid>/` (8-4-4-4-12 hex). | VERIFIED | N2 `stripSyntheticNotionExportRoot` |
| Notion's own help page never mentions splitting into several ZIPs or the `Part-N` names; that comes from N7 and N2 only. | VERIFIED (absence) | N1 |
| Exact name of the outer ZIP and whether `ExportBlock-...` appears in any current export. The string was not found in any source. | NOT VERIFIED | none |
| Exports may include `__MACOSX` and hidden files when re-zipped on macOS. | VERIFIED-2 | N8; N2 `hiddenZipPath` skips hidden entries |
| An `index.html` summary exists in the HTML export (not Markdown). | VERIFIED | N2 |

### 1.2 Filenames, IDs and sanitisation

| Fact | Status | Source |
|---|---|---|
| Notion IDs are 32 characters, at the end of file/folder names, separated by a space: `Page Title <32hex>.md`. | VERIFIED | N3 comment: "Notion UUIDs come at the end of filenames/URL paths and are always 32 characters long"; regexes `/[ -]?[a-z0-9]{32}(\.\|$)/` and `/([a-z0-9]{32})(\?\|\.\|$)/` |
| Folders for child pages carry the same suffix: `Page Title <32hex>/`. Parent IDs are derived from ancestor folder names. | VERIFIED | N3 `parseParentIds`; N8 |
| The importer matches IDs with `[a-z0-9]{32}` (looser than hex) after removing `-`. A strict `[0-9a-f]{32}` is safe for real IDs but dashed UUIDs may appear in URLs. | VERIFIED | N3 |
| Notion truncates long titles in filenames and can "chop words in half"; Obsidian Importer therefore reads the full title from HTML `<title>`. In Markdown the full title is the first `# H1`. | VERIFIED (HTML); INFERRED (H1 is complete) | N4 |
| For some Unicode characters Notion destroys the attachment filename completely ("a Notion bug"). Do not assume non-ASCII attachment names survive. | VERIFIED | N4 comment |
| Attachment filenames are URL-encoded on export and must be decoded (`decodeURIComponent`). | VERIFIED | N4 |
| Title sanitisation used by the importer when writing notes: NFC, `/` `\` to `-`, remove `? < > : * \| "`, strip control chars, strip trailing dots/spaces, avoid Windows reserved names, replace `[ ] # \| ^` (link breakers), limit to 240 bytes, empty becomes `Untitled`. This is Obsidian's policy, not Notion's. | VERIFIED | `src/util.ts` in obsidian-importer |
| Notion's own filename sanitisation rules (which characters it replaces). | NOT VERIFIED | none |
| Collisions after stripping IDs are common (one tool reports 865 duplicates in one export). Obsidian Importer resolves with a case-insensitive reserved-path set and suffix ` 1`, ` 2`. | VERIFIED | N6; N8 |

### 1.3 Links

| Fact | Status | Source |
|---|---|---|
| Page links in Markdown are standard Markdown links to a URL-encoded relative path including the ID: `[Meeting Notes](Meeting%20Notes%20<32hex>.md)`. | VERIFIED-2 | N8 README and tests |
| Links to child pages include the parent folder: `Projects/Tasks%20<id>.md`; links upward use `../`. Anchors appear as `Doc%20<id>.md#section-2`. | VERIFIED-2 | N8 tests |
| In the HTML export the importer decodes the href with `decodeURI`, strips leading `../`, and matches by ID. `.html` targets with an ID are relations; targets matching an attachment path are attachments. | VERIFIED | N5 |
| Links to pages not in the export are not relative paths; they are `https://www.notion.so/...-<32hex>` URLs (or dashed UUIDs). | INFERRED | none |
| Percent-encoding is complete (`%20`, `%E0...` for Thai, `%28` `%29` for parentheses). | VERIFIED-2 (parens, spaces); INFERRED (non-ASCII) | N8 tests |

### 1.4 Databases and CSV

| Fact | Status | Source |
|---|---|---|
| Database exports as `<Name> <32hex>.csv`; a second variant `<Name> <32hex>_all.csv` also appears (all rows rather than current view). | VERIFIED-2 | N8 tests (`Tasks abc..._all.csv`); N9 |
| When both exist, third-party tools keep `_all.csv` and drop the other. Whether `_all.csv` appears for every database or only when the view is filtered is unknown. | VERIFIED-2 / NOT VERIFIED | N8 |
| Notion's help says only "the current view and the default view" can be exported. | VERIFIED | N1 |
| Row pages are Markdown files in a folder named after the database (`<Name> <32hex>/`). | VERIFIED-2 | N8 README; N9 |
| Obsidian Importer skips `.csv` files with IDs in HTML mode; it never imports CSV. | VERIFIED | N2 |
| CSV encoding (UTF-8, BOM or not), quoting, and how relation columns serialise (page title, or title plus URL-encoded path). | NOT VERIFIED. INFERRED: UTF-8, RFC 4180 quoting, relations as page title with encoded path in parentheses. | none |
| Relations, rollups, formulas, views and filters are not reconstructable. | VERIFIED | N1 (spec 7.2); ADR-0010 |

### 1.5 Page properties and body syntax

| Fact | Status | Source |
|---|---|---|
| In the HTML export properties are a `table.properties` with row classes `property-row-<type>`. | VERIFIED | N5 |
| In the Markdown export, properties of a database row page appear under the H1 as plain `Key: Value` lines, with a blank line after the H1 (no YAML frontmatter). | VERIFIED-2 for one line (`Status: In Progress` in a test fixture); INFERRED for the rest (dates, multi-select joined by commas, relations as links) | N8 test file |
| Callouts export as HTML `<aside>` containing an icon `<img src="https://www.notion.so/icons/<name>_<color>.svg" width="40px" />` followed by text. | VERIFIED (statement: "Callout blocks will be exported as HTML") and VERIFIED-2 (markup sample) | N1; N8 README |
| Toggles export as `<details><summary>...</summary>...</details>` in HTML. Whether the Markdown export emits `<details>` or flattens the toggle is unknown. | VERIFIED (HTML export); INFERRED (Markdown) | N5 |
| To-dos export as `- [ ]` / `- [x]`; code as fenced blocks; tables as pipe tables; equations as `$$`. | INFERRED (standard Markdown) | none |
| Bookmarks and embeds export as links or HTML. Mermaid code blocks keep a `language-Mermaid` class in HTML. | VERIFIED (HTML) | N5 |
| Notion does not export Markdown-compatible `#tag` text; it does not escape `#`. | INFERRED | none |

### 1.6 Images and attachments

| Fact | Status | Source |
|---|---|---|
| Uploaded files are included in the ZIP. | VERIFIED | N1 ("files you've uploaded") |
| Images and attachments sit in a folder named after the page title **without** ID (for example `Page Title/Untitled.png`), next to `Page Title <id>.md`. Referenced as `![Untitled.png](Page%20Title/Untitled.png)`. | VERIFIED-2 for folder-without-ID paths (as test input strings only); INFERRED for the exact image Markdown | N8 tests (`Better%20performance%20%3D%20better%20design/Untitled.png`) |
| Untitled images are named `Untitled.png`, `Untitled 1.png`, etc. | VERIFIED-2 | N8 tests |
| Callout icons and covers may be remote URLs, not files. Cover images exist in exports. | VERIFIED-2 | N8 README |
| Whether files that are not images are linked as `[name](path)`. | INFERRED | none |

## 2. Obsidian vault conventions

Sources:
- O1 https://obsidian.md/help/links
- O2 https://obsidian.md/help/embeds
- O3 https://obsidian.md/help/callouts
- O4 https://obsidian.md/help/properties
- O5 https://obsidian.md/help/aliases
- O6 https://obsidian.md/help/tags
- O7 https://obsidian.md/help/attachments
- O8 https://obsidian.md/help/configuration-folder
- O9 https://obsidian.md/help/import/markdown
- O10 https://trip2g.com/dev/obsidian_links (third-party write-up)

### 2.1 Links

| Fact | Status | Source |
|---|---|---|
| `[[Note]]` and `[[Note.md]]` are both valid. Non-Markdown targets need the extension (`[[Figure 1.png]]`). | VERIFIED | O1 |
| Heading: `[[Page#Heading]]`; nested: `[[Page#H1#H2]]`; in-note: `[[#Heading]]`; vault-wide heading search `[[## text]]`. | VERIFIED | O1 |
| Block: `[[Page#^block-id]]`; IDs are Latin letters, digits and dashes only; they do not work outside Obsidian. | VERIFIED | O1 |
| Display text: `[[Page\|alias]]`. This is not the same feature as note aliases. | VERIFIED | O1, O5 |
| Markdown links must be URL-encoded (`%20`); characters `# \| ^ : %% [[ ]]` can break links. Paths start at vault root, forward slashes. | VERIFIED | O1 |
| Angle-bracket destinations `[x](<a b.md>)` are accepted. | INFERRED (CommonMark; not on the page) | none |
| Resolution: bare `[[Name]]` is matched by basename, **case-insensitive**; ambiguous names prefer the shallowest path; a full path (`[[folder/Name]]`) disambiguates. Obsidian writes a full path only when the basename is not unique ("shortest path"). Whether the linking note's folder influences the choice is disputed. | INFERRED (O10 and tool sources, not official docs) | O10 |
| Link format setting values: `newLinkFormat` = `shortest` / `relative` / `absolute`; `useMarkdownLinks` toggles Markdown vs wikilinks. | VERIFIED-2 (appear in vault configs and plugin READMEs) | search results; not official docs |

ADR-0010 resolution order (exact path, unique basename, alias) is deliberately
stricter than Obsidian (it reports ambiguity instead of guessing).

### 2.2 Embeds

| Fact | Status | Source |
|---|---|---|
| `![[Note]]`, `![[Note#Heading]]`, `![[Note#^id]]` embed notes or sections. | VERIFIED | O2 |
| Images: `![[img.jpg]]`, width only `![[img.jpg\|100]]`, `![[img.jpg\|100x145]]`. | VERIFIED | O2 |
| PDF: `![[doc.pdf]]`, `![[doc.pdf#page=3]]`, `![[doc.pdf#height=400]]`, combined with `&`. Audio and canvas embeds also exist. | VERIFIED | O2 |
| Inside a table cell the pipe must be escaped (`\|`); the Obsidian Importer emits `\|` in tables. | VERIFIED | N5 |

### 2.3 Properties, aliases, tags

| Fact | Status | Source |
|---|---|---|
| Properties are YAML frontmatter at the top of the file; names unique per note. Types: Text, List, Number, Checkbox, Date, Date & time, Tags. | VERIFIED | O4 |
| Default list properties: `tags`, `aliases`, `cssclasses`. Singular `tag`, `alias`, `cssclass` deprecated in 1.4; support as defaults dropped in 1.9. | VERIFIED | O4 |
| Docs say aliases and tags "should always be formatted as a list". Older notes in the wild use a string (`tags: a, b` or `aliases: Foo`); Obsidian's tolerance for these is not documented. | VERIFIED (docs); NOT VERIFIED (tolerance) | O5, O6 |
| Nested (map) properties are unsupported in the property UI; they stay in YAML source. | VERIFIED | O4 |
| Behaviour on invalid YAML is not documented. | NOT VERIFIED | O4 |
| Tags: letters, digits, `_`, `-`, `/` (nesting), Unicode incl. emoji; no spaces; case-insensitive; must contain a non-numeric character (`#1984` invalid). | VERIFIED | O6 |
| Hashtags in text properties do not create tags; Markdown in properties is not rendered; internal links in properties must be quoted. | VERIFIED | O4 |
| Aliases are offered in link suggestions, but Obsidian writes `[[Real Name\|Alias]]`, not `[[Alias]]`. Whether a hand-written `[[Alias]]` resolves to the note is not stated on the page (it does not resolve for navigation in stock Obsidian per recollection). | VERIFIED (suggestions); INFERRED (alias-only wikilinks do not resolve) | O5 |

### 2.4 Callouts

| Fact | Status | Source |
|---|---|---|
| Syntax: first line of a blockquote `> [!type] Optional title`, body in following `>` lines; nestable; body optional. | VERIFIED | O3 |
| Fold markers directly after the type: `+` expanded by default, `-` collapsed. | VERIFIED | O3 |
| Types: note, abstract (summary, tldr), info, todo, tip (hint, important), success (check, done), question (help, faq), warning (caution, attention), failure (fail, missing), danger (error), bug, example, quote (cite). Case-insensitive; unknown types render as `note`; custom types via CSS/plugins. | VERIFIED | O3 |

### 2.5 Attachments and `.obsidian/`

| Fact | Status | Source |
|---|---|---|
| Default new-attachment location is vault root. Options: vault root, a specified folder, same folder as current file, subfolder under current folder. | VERIFIED | O7 |
| Config key is `attachmentFolderPath` in `.obsidian/app.json`. Values: `"/"` root, `"Attachments"` a fixed folder, `"./"` same folder as the note, `"./sub"` subfolder next to the note. | VERIFIED-2 for the key name and fixed-folder value; the Obsidian Importer treats a leading `./` as note-relative (N6). Official docs do not state the key. | N6; search results |
| The setting only affects where **new** attachments go; existing embeds resolve by name/path, so the importer should not rely on it for resolution. | INFERRED | none |
| `.obsidian/` "contains all the settings files pertaining to your vault"; the page does not list files. Commonly seen: `app.json`, `appearance.json`, `core-plugins.json`, `community-plugins.json`, `workspace.json`, `hotkeys.json`, `plugins/<id>/main.js` + `manifest.json` + `data.json`, `themes/`, `snippets/`. | VERIFIED (existence); INFERRED (file list) | O8 |
| The config folder name can be changed by the user, so `.obsidian` is the default only. | VERIFIED | O8 |
| Templater syntax `<% ... %>` and Dataview ```` ```dataview ```` blocks are plugin syntax, not core. | INFERRED | none |
| Obsidian also writes `.trash/` for deleted files. | INFERRED | none |

## 3. Implications for Thoth importers

1. **Detect Notion by IDs.** Match `/ [0-9a-f]{32}(\.[^.]+)?$/i` on the final path segment of files and folders. Do not require it for attachments (their folders have no ID).
2. **Accept three ZIP shapes:** flat, a single synthetic `Export-<uuid>/` root, and an outer ZIP containing root-level `Export-<uuid>-Part-N.zip` files. Recurse once only at the ZIP root (matches ADR-0010 depth limit 1); deeper ZIPs are attachments. Skip `__MACOSX`, `.DS_Store`.
3. **Identity is the 32-hex ID**, never the title. Titles repeat (two "Meeting Notes" are in the fixture). Strip IDs for destination names, keep `sourceId`, dedupe with a deterministic suffix after NFC plus case-folding.
4. **Link rewriting:** percent-decode hrefs, resolve relative to the containing file, then look up by path (or ID in the final segment). Unresolvable relative links and `notion.so` URLs for IDs absent from the manifest are reported as unresolved, preserved verbatim.
5. **Databases:** keep both `.csv` and `_all.csv` out of the page tree; prefer `_all.csv` as the canonical table, preserve the other as provenance. Parse CSV with a real RFC 4180 parser (embedded newlines, quotes, Thai, optional BOM). Row pages live in the folder named after the database.
6. **Properties:** parse `Key: Value` lines directly after the H1 only until the first blank line followed by non-property content; keep the original text if parsing is ambiguous. Do not guess types.
7. **HTML fallbacks** (`<aside>`, `<details>`) are preserved as raw/html blocks and listed in the compat report (open question in ADR-0010).
8. **Attachments:** decode names, tolerate mangled non-ASCII names, resolve references by decoded path. Non-image attachments are copied and linked.
9. **Obsidian:** build the index (path, basename, alias) first; resolve basename case-insensitively; unique basename wins; ambiguous reported; alias-only `[[Start]]` resolves via alias index (stricter than stock Obsidian, deliberate). Preserve `#heading`, `#^block`, `|alias`, `|100` and `#page=3` fragments verbatim; strip fragments only for lookup.
10. **Frontmatter:** parse leniently. Accept list or string for `aliases`/`tags` and singular `tag`/`alias`. Preserve unknown and nested keys verbatim. On YAML parse failure, import the file byte-for-byte and warn.
11. **Never execute or import `.obsidian/`** (including `plugins/*/main.js`); report it skipped. Templater and Dataview syntax is preserved and reported as unsupported plugin syntax. Do not trust `attachmentFolderPath` for resolution.
12. **Case collisions** (`Readme.md` vs `README.md`) cannot be created on macOS or Windows checkouts; tests generate them inside an in-memory ZIP.

## 4. Open items to verify with real exports

- Outer ZIP and `ExportBlock-...` naming; when `_all.csv` appears.
- CSV encoding and relation/date column serialisation.
- Exact Markdown for properties, toggles, image/file links, bookmarks, equations, and column layouts.
- Percent-encoding of non-ASCII characters in links; Notion's filename sanitisation.
- Obsidian behaviour for malformed frontmatter and string-valued `aliases`/`tags`.
