# Editor serialization contract (v1)

Implements ADR-0002 section 7 in `packages/editor`. The editor is Tiptap /
ProseMirror; Markdown files stay the source of truth (ADR-0001). Parsing and
serialization run in plain Node and need no DOM.

```ts
const { doc, frontmatter } = markdownToDoc(source);   // frontmatter: BOM + YAML block, verbatim
const markdown = docToMarkdown(doc, { frontmatter }); // === source when nothing changed
```

Block structure comes from `parseMarkdownTree` in `@thoth/content` (mdast +
GFM with source positions). There is no second Markdown parser. The only
extra pass is wikilink recognition (section 5).

## 1. Guarantees

1. **Untouched means byte-identical.** `docToMarkdown(markdownToDoc(s)) === s`
   for any string `s`, including `*` bullets, `__bold__`, setext headings, odd
   spacing, CRLF, a BOM, unclosed fences and text the parser rejects.
2. **Minimal diffs.** Editing a block changes only that block's bytes.
   Deleting, moving or inserting blocks never glues two blocks together.
3. **Canonical output is deterministic and idempotent.**
   `serialize(parse(serialize(d))) === serialize(d)`, and it reparses to an
   equivalent document (text is escaped; section 4).
4. **Nothing is dropped.** What the editor cannot model is a read-only `raw`
   atom (block) or `inlineRaw` atom (inline) carrying its exact source.

## 2. How untouched blocks are preserved

Every top-level block node carries four attributes (`SOURCE_ATTR_NAMES`):

| Attribute | Meaning |
|---|---|
| `mdSrc` | exact source slice of the block |
| `mdSep` | exact text between the previous block (or body start) and this one |
| `mdFp` | fingerprint: the canonical serialization at parse time (`null` when equal to `mdSrc`) |
| `mdIx` | position among the original top-level blocks |

The document node carries `eol` (`"\n"` or `"\r\n"`, from the first line ending
of the file) and `trailer` (exact text after the last block).

Serializing a block:

- **Untouched** (current canonical serialization equals the fingerprint): emit
  `mdSrc`. Comparing canonical forms, not JSON, means an unrelated
  attribute or a ProseMirror normalization does not count as an edit.
- **Edited, new or without source attributes**: emit the canonical form,
  converted to the document's `eol`.

Separators:

- The block's own `mdSep` is reused when it contains a blank line, or when the
  block still directly follows the block it followed originally
  (`mdIx` consecutive). That keeps tight neighbours (`para\n# Heading`) tight.
- Otherwise (first block after a move, insert or delete; unknown separator) a
  blank line in the document's `eol` is used.
- Empty paragraphs and a trailing hard break have no Markdown form and are
  dropped.

**Boundary verification.** After composing the output, the serializer reparses
it with `parseMarkdownTree` and checks that every emitted block is still exactly
one top-level block with the same bytes. A mismatch (an indented block moved
behind a list, two lists made adjacent, a paragraph that became lazy
continuation of a quote) switches the offending block to a blank-line
separator, then to canonical form, and rechecks. Raw, html and math blocks
never switch to canonical form (their source is the model). `verify: false`
disables the check; a test shows it is needed.

Frontmatter and the BOM are not part of the editor document. They are the
`frontmatter` string, emitted as an exact prefix. An empty body is one empty
paragraph.

If the parser's block ranges are unusable (a gap containing non-blank text),
the whole body becomes one `raw` block.

## 3. Canonical choices

| Construct | Canonical form |
|---|---|
| Bullet list marker | `-`. Adjacent sibling bullet lists alternate `-`, `*`, `+` so they do not merge |
| Ordered list | `1.` numbering from the list's `start`, incrementing; adjacent ordered lists alternate `.` and `)` |
| Task item | `- [ ] text` / `- [x] text` |
| List item content | indented by marker width plus one space |
| Tight / loose | `tight` attribute (from the source: a blank line between items or children makes it loose). A list is also written loose whenever an item has two non-list, non-code children, because a tight item cannot hold two paragraphs |
| Heading | ATX `# `..`###### `, no closing hashes, single line. A trailing `#` run is escaped |
| Bold | `**x**` |
| Italic | `*x*` |
| Strike | `~~x~~` |
| Mark nesting order | link, bold, italic, strike, code (outermost first). Whitespace at a mark's edge is moved outside the delimiters |
| Inline code | shortest backtick fence that does not occur in the text; one space of padding when the text starts or ends with a backtick or is space-padded. Newlines become spaces |
| Hard break | backslash then newline (`\` + EOL). Setext/ATX headings and table cells turn breaks into spaces |
| Link | `[text](href "title")`; `<href>` when it has spaces, angle brackets or unbalanced parentheses; title in double quotes. A link whose text equals an absolute URL is `<https://...>` |
| Image | `![alt](src "title")` |
| Code block | backtick fence, at least 3 and longer than any backtick run inside; `~~~` when the info string has a backtick. Info string is `lang meta`. Indented code becomes fenced |
| Blockquote | `> ` prefix on every line; empty lines are `>` |
| Callout | `> [!kind]` + fold marker (`+`/`-`) + ` title`, then the body quoted. When the first child is not a paragraph a `>` line separates it from the head, so it is not absorbed into the title |
| Table | `\| a \| b \|`, delimiter row `---` / `:--` / `--:` / `:-:`, one space padding, no column alignment padding. Rows are padded or truncated to the header width. A cell is inline content on one line; `\|` for pipes |
| Thematic break | `***` |
| Wikilink | `[[Target#Fragment\|label]]`. Pipes become `\|` inside table cells |
| Embed | `![[Target#Fragment\|label]]` |
| Separator between blocks | one blank line (tight list children: one newline for nested lists and code) |
| Line ending | the document's `eol`; trailing text `trailer`, or a single final newline when new |

Callout `kind` is stored as written (case preserved) and the content model
lowercases it, as `@thoth/content` does.

## 4. Escaping

Canonical text is escaped so it reparses to the same characters:

- Always: `\ * ` [ ] < ~ |` get a backslash. `_` is escaped unless between two
  letters or digits. `&` is escaped when it starts a character reference.
- At the start of a line (paragraph and list item text): `#`, `>`, `$$`, `-`/`+`
  followed by space or end, a line of `-` or `=`, and `1.` / `1)` digit runs
  (the delimiter is escaped).
- A leading or trailing space or tab on a line becomes `&#x20;` / `&#x9;`, so
  it is not stripped.
- Blank lines inside a paragraph collapse to one newline; edge newlines are
  dropped (no Markdown form).
- **Autolink literals** (`https://x`, `www.x`, `a@b.c`) cannot be escaped: the
  tokenizer reads them raw, and a backslash stays in the text. The serializer
  tries the run unescaped, then unescaped without trailing-punctuation
  trimming, then every possible start written as a numeric reference, and
  keeps the first form that **reparses to the same text**. The parser side
  keeps literal autolinks as plain text, not links, so they are stable.
  Explicit links (`[x](u)`, `<https://x>`) are real `link` marks.

Tests generate thousands of deterministic metacharacter strings (paragraphs,
headings, list items, quotes, callouts, table cells) and check same text,
same block type, and idempotence.

## 5. Wikilinks and embeds

mdast has no wikilink node. Before the single real parse, `[[...]]` outside
code, HTML and autolink literals (and not preceded by an odd number of
backslashes) is replaced by a placeholder of identical length (private-use
characters, so offsets stay valid). After parsing, placeholders in text nodes
become `wikilink` atoms: `[[T]]`, `[[T|a]]`, `[[T#H]]`, `[[T#^b]]` give
`target`, `fragment` (heading or `^block`) and `label`. A paragraph that is
exactly `![[...]]` is an `embed` block; an embed inside other text is an
`inlineRaw` atom. A wikilink inside a link destination or title makes that link
an `inlineRaw`.

## 6. What falls back to raw

| Construct | Node |
|---|---|
| Link reference definition `[a]: url` | `raw` |
| Footnote definition `[^1]: text` | `raw` |
| HTML block / comment | `html` |
| `` ```math `` fence, `$$...$$` paragraph | `math` (reserved in v1, no behavior) |
| Any container (list, quote) holding a raw, html, footnote, definition or math block | the whole top-level container is `raw` |
| Table row with more cells than the header | `raw` (GFM would drop the extra cells) |
| Unknown mdast node | `raw` |
| Inline: HTML, link or image references, footnote references, inline `![[...]]`, unknown | `inlineRaw` |

Containers fall back whole because the editor schema has no place for a raw
block inside a list item; the byte-exact source is the safe model.

## 7. Known limits

- **Edits inside a block rewrite that block canonically.** An edit to one
  list item rewrites the whole list; one table cell rewrites the table. Only
  top-level blocks are preserved, not individual items.
- **Reformatting by design:** setext to ATX, `__` to `**`, indented code to
  fenced, `*`/`+` bullets to `-`, trailing spaces, odd indentation and table
  column padding all normalize when a block is rewritten.
- Block IDs (`^id`) stay in text: they are plain paragraph text.
- Frontmatter is carried, not modelled; the UI edits it through
  `updateFrontmatter` in `@thoth/content`.
- Mixed line endings in a rewritten block use the first line ending found.
- `docToMarkdown` trusts source attributes: copying a node's attributes onto a
  different node whose canonical form still equals the fingerprint is
  indistinguishable from "untouched".
