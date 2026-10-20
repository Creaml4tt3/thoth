# Import fixtures

Plain-text directories. Tests ZIP them programmatically (no `.zip` files are
checked in) or read them as directories. All text is UTF-8 with LF endings.
Format background and sources: `docs/architecture/import-formats.md`.
Spec references: section 7.5 acceptance bullets, ADR-0010.

The fixtures were written by a one-off script; the PNGs are real 1x1 images.
Notion IDs are synthetic (valid 32-hex, not real page IDs). Where the real
Notion format could not be verified (see import-formats.md section 4), the
fixture uses the best-supported guess; update it when a real export is
available.

## obsidian-vault/

| Path | Tests (spec 7.5 bullet) |
|---|---|
| `.obsidian/app.json` (`attachmentFolderPath: "Attachments"`), other config | Config is skipped and reported, never imported |
| `.obsidian/plugins/evil-plugin/main.js` (`throw new Error("must never execute")`) | No code execution: importing must not load or run it |
| `Home.md` | Frontmatter with `aliases` list, `tags`, unknown `cssclasses`, `publish`, nested `custom` map preserved verbatim; wikilinks with path+alias, `#Heading`, `#^block`; missing link; embeds `![[diagram.png]]`, `![[diagram.png\|100]]`, `![[Café]]`; Markdown link with `%20`; `> [!tip]-` callout; tasks incl. custom `[/]`; inline `#tag`/`#area/research`; `[[Not A Link]]` in code; ```` ```dataview ```` as unsupported syntax |
| `Projects/Alpha.md` and `Archive/Alpha.md` | Duplicate titles; `Meeting Notes.md` links `[[Alpha]]`, which is ambiguous and must be reported, not guessed |
| `Projects/Beta.md` | Block ID `^summary` target |
| `Projects/Spec Doc.md` | Legacy singular `tag`, comma-string `tags`, string `aliases`; embeds `![[report.pdf]]` and `![[report.pdf#page=1]]` |
| `Meeting Notes.md` | `## Decisions` heading target |
| `Welcome.md` (`aliases: [Start]`) | Alias-only link: `Home.md` and `Meeting Notes.md` link `[[Start]]` |
| `บันทึก/การประชุม 🚀.md`, `Café.md` | Thai folder and filename, emoji, NFC; links back to `[[Home]]`; `Home.md` links `[[การประชุม 🚀]]` by basename |
| `Broken Frontmatter.md` | Malformed YAML (`title: [unclosed`): import verbatim and warn |
| `Templates/Daily.md` | Templater `<% tp.date.now() %>`: preserved, reported as plugin syntax |
| `Attachments/diagram.png` (real PNG), `Attachments/report.pdf` (text placeholder) | Attachments copied; embeds rewritten only when necessary |

Not stored (generated at test time, see below): `notes/Readme.md` and
`notes/README.md`.

## notion-export/

Extracted contents of a Notion Markdown & CSV export. The top-level entries are
what the ZIP root contains; tests also wrap it as (a) a single synthetic
`Export-<uuid>/` root and (b) an outer ZIP holding `Export-<uuid>-Part-1.zip`
(nested-ZIP form, ADR-0010 depth 1). Both wrappers are built at test time.

```
Thoth Handbook <id>.md                    top-level page, links to all children
Thoth Handbook <id>/
  Meeting Notes <id>.md                   same title as the Engineering one
  Engineering <id>.md
  Engineering <id>/
    Meeting Notes <id>.md                 same title, different parent and ID
    Deep Dive <id>.md                     second-level child
  Project Atlas <id>.md                   properties, <aside>, <details>, to-dos, code, table
  Project Atlas/                          asset folder (no ID suffix)
    diagram.png  notes.pdf  ไฟล์แนบ.txt
  บันทึกการประชุม 🚀 <id>.md               Thai + emoji title
  Tasks <id>.csv                          database, current view
  Tasks <id>_all.csv                      database, all rows (BOM, quoted fields)
  Tasks <id>/                             row pages
    Write importer <id>.md
    ทดสอบ import <id>.md
```

Tests:
- Nested pages (2 levels), repeated titles ("Meeting Notes" x2, never merged), Markdown links as URL-encoded relative paths with IDs, images, CSV (spec 7.5 first bullet).
- `Project Atlas` page: `Key: Value` property lines under the H1, `<aside>` callout and `<details>` toggle as HTML fallback, unsupported database semantics via the relation-like `Related page` column and formula-like `Days open`/`Created` columns (second bullet).
- Broken/missing links: `Thoth Handbook` links to `notion.so/...-0f1e2d3c...` and to a relative path of a page not in the export (third bullet).
- Unicode/Thai/emoji names in files, folders, links (percent-encoded), attachment and CSV cells.
- CSV edge cases: BOM, embedded comma, embedded newline, doubled quotes, Thai text, empty row.
- The CSV relation cell uses a root-relative encoded path; real Notion may serialise relations differently (unverified).

## Generated at test time (do not check in)

| Case | Why it is not a file |
|---|---|
| Case collision pair `notes/Readme.md` + `notes/README.md` (Obsidian) and an equivalent Notion pair | Cannot coexist on macOS/Windows checkouts, and a case-insensitive filesystem would silently merge them in git. Build them in an in-memory ZIP (or on a case-sensitive tmpdir) and assert deterministic suffixing plus a warning. Also add an NFC/NFD pair (`Café` composed vs decomposed). |
| Path traversal entries (`../evil.md`, `/abs.md`, `C:\x`, `a\..\..\x`, NUL in name) | Extraction tools and zip libraries normalise or refuse them; many VCS/editors strip them. Must be hand-built with a raw ZIP writer. Assert nothing is written outside the staging root. |
| Symlink entries (ZIP external attrs) and directory symlinks in a scanned folder | Git and some filesystems mangle symlinks; they must be created in a tmpdir, and a symlink to outside the root must never be followed. |
| Zip bomb / high compression ratio (e.g. 1 GiB of zeros) and entry-count bomb | Too large to check in; generate streamed with low default limits injected via config so tests stay fast. |
| Huge single file over the per-entry limit | Same; use a lowered limit rather than writing gigabytes. |
| Malformed ZIP (truncated, bad central directory, wrong CRC, encrypted entry) | Derived by truncating or corrupting the generated valid archive; a checked-in corrupt file would be flagged by tooling. |
| Nested ZIP deeper than depth 1, and a root-level ZIP treated as an attachment | Constructed by zipping the fixtures in memory. |
| Duplicate and interrupted/resumed imports | Behavioural: run the importer twice and kill it mid-job against a tmp vault; fixtures only supply input. |
| Offline import | Run with network access disabled or fetch stubbed to fail; assert no remote `<img src>` is fetched. |

## Rules for editing fixtures

- Keep them small and deterministic. Never add real personal data.
- Do not add executable behaviour beyond the inert `evil-plugin` stub.
- Do not normalise filenames: `Café.md` is NFC and the Thai/emoji names are intentional.
