import { parseMarkdownTree, splitFrontmatter } from "@thoth/content";
import type { JSONContent } from "@tiptap/core";
import type { ListItem, Nodes, PhrasingContent, Root, RootContent, Table, Text } from "mdast";
import { canonBlock, isTight } from "./blocks.ts";
import { MARK_ORDER } from "./inline.ts";
import { findWikilinks, maskWikilinks, parseWikiInner, unmask, type Mask, type Span } from "./wikilinks.ts";

/**
 * Markdown to editor document.
 *
 * The block structure comes from `parseMarkdownTree` (mdast + GFM, with source
 * positions). Every top-level block records its exact source slice, the text
 * that preceded it, and a fingerprint (its canonical serialization right now),
 * which lets the serializer reproduce untouched blocks byte-for-byte.
 */
export interface MarkdownDoc {
  doc: JSONContent;
  /** Everything before the body: BOM and frontmatter, byte-for-byte. */
  frontmatter: string;
}

interface Ctx {
  /** Original body text; offsets in the (identically laid-out) parsed text index into it. */
  src: string;
  mask: Mask | undefined;
}

type MarkJSON = { type: string; attrs?: Record<string, unknown> };
const NON_BLANK = /[^ \t\r\n]/;
const EMBED = /^!\[\[([^[\]\n]+)\]\]$/;
const CALLOUT_LINE = /^\[!([A-Za-z0-9_-]+)\]([+-]?)[ \t]*(.*?)[ \t]*$/;

const posOf = (node: Nodes) => {
  const p = node.position;
  return p?.start.offset !== undefined && p.end.offset !== undefined ? { start: p.start.offset, end: p.end.offset } : undefined;
};
const sliceOf = (node: Nodes, ctx: Ctx) => {
  const p = posOf(node);
  return p ? ctx.src.slice(p.start, p.end) : "";
};
const hasMarker = (s: string | null | undefined, ctx: Ctx) => !!ctx.mask && !!s && s.includes(ctx.mask.marker);

// ---------------------------------------------------------------------------
// Inline

function pushText(out: JSONContent[], text: string, marks: MarkJSON[]): void {
  if (text === "") return;
  out.push({ type: "text", text, ...(marks.length ? { marks: marks.map((m) => ({ ...m })) } : {}) });
}

function pushAtom(out: JSONContent[], node: JSONContent, marks: MarkJSON[]): void {
  out.push(marks.length ? { ...node, marks: marks.map((m) => ({ ...m })) } : node);
}

function inlineNodes(nodes: PhrasingContent[], marks: MarkJSON[], ctx: Ctx, out: JSONContent[]): void {
  const raw = (node: Nodes) => pushAtom(out, { type: "inlineRaw", attrs: { source: sliceOf(node, ctx) } }, marks);
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        for (const piece of unmask(node.value, ctx.mask)) {
          if (typeof piece === "string") pushText(out, piece, marks);
          else if (piece.embed) pushAtom(out, { type: "inlineRaw", attrs: { source: ctx.src.slice(piece.start, piece.end) } }, marks);
          else pushAtom(out, { type: "wikilink", attrs: { target: piece.target, fragment: piece.fragment, label: piece.label } }, marks);
        }
        break;
      case "emphasis":
        inlineNodes(node.children, [...marks, { type: "italic" }], ctx, out);
        break;
      case "strong":
        inlineNodes(node.children, [...marks, { type: "bold" }], ctx, out);
        break;
      case "delete":
        inlineNodes(node.children, [...marks, { type: "strike" }], ctx, out);
        break;
      case "inlineCode":
        pushText(out, node.value.replace(/\r?\n|\r/g, " "), [...marks, { type: "inlineCode" }]);
        break;
      case "break":
        pushAtom(out, { type: "hardBreak" }, marks);
        break;
      case "link":
        // GFM autolink literals are text in the source; keep them as text (see escape.ts).
        // (Nodes made from decoded text have no position; explicit links and `<...>` always do.)
        if (node.children.length === 1 && node.children[0]!.type === "text" && (!posOf(node) || sliceOf(node, ctx) === (node.children[0] as Text).value)) {
          inlineNodes(node.children, marks, ctx, out);
        } else if (hasMarker(node.url, ctx) || hasMarker(node.title, ctx)) raw(node);
        else inlineNodes(node.children, [...marks, { type: "link", attrs: { href: node.url, title: node.title ?? null } }], ctx, out);
        break;
      case "image":
        if (hasMarker(node.url, ctx) || hasMarker(node.title, ctx) || hasMarker(node.alt, ctx)) raw(node);
        else pushAtom(out, { type: "inlineImage", attrs: { src: node.url, alt: node.alt ?? "", title: node.title ?? null } }, marks);
        break;
      default:
        // inline html, link/image/footnote references, and anything unknown
        raw(node);
    }
  }
}

function sortMarks(marks: MarkJSON[]): MarkJSON[] {
  const seen = new Set<string>();
  return marks
    .filter((m) => {
      const key = m.type === "link" ? `link:${JSON.stringify(m.attrs)}` : m.type;
      return !seen.has(key) && seen.add(key);
    })
    .sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

const sameMarks = (a: JSONContent, b: JSONContent) => JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);

/** Sorts marks, merges adjacent equal-mark text, optionally flattens breaks to spaces. */
function finalizeInline(nodes: JSONContent[], flatten: boolean): JSONContent[] {
  const out: JSONContent[] = [];
  for (const n of nodes) {
    let node: JSONContent = n.marks ? { ...n, marks: sortMarks(n.marks as MarkJSON[]) } : n;
    if (flatten && node.type === "hardBreak") node = { type: "text", text: " ", ...(node.marks ? { marks: node.marks } : {}) };
    if (flatten && node.type === "text") node = { ...node, text: (node.text ?? "").replace(/\r?\n|\r/g, " ") };
    const prev = out.at(-1);
    if (node.type === "text" && prev?.type === "text" && sameMarks(prev, node)) out[out.length - 1] = { ...prev, text: (prev.text ?? "") + (node.text ?? "") };
    else out.push(node);
  }
  return out;
}

function inline(nodes: PhrasingContent[], ctx: Ctx, flatten = false): JSONContent[] {
  const out: JSONContent[] = [];
  inlineNodes(nodes, [], ctx, out);
  return finalizeInline(out, flatten);
}

const withContent = (type: string, attrs: Record<string, unknown> | undefined, content: JSONContent[]): JSONContent => ({
  type,
  ...(attrs ? { attrs } : {}),
  ...(content.length ? { content } : {}),
});

// ---------------------------------------------------------------------------
// Blocks

/** True when the block (and everything nested in it) maps to editor nodes without loss. */
function supported(node: RootContent): boolean {
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "thematicBreak":
      return true;
    case "table": {
      // GFM ignores cells beyond the header, but dropping their text would lose content: keep such tables raw.
      const cols = node.children[0]?.children.length ?? 0;
      return node.children.every((row) => row.children.length <= cols);
    }
    case "code":
      return node.lang !== "math";
    case "blockquote":
      return node.children.every(supported);
    case "list":
      return node.children.every((item) => item.children.every(supported));
    default:
      return false;
  }
}

const emptyParagraph = (): JSONContent => ({ type: "paragraph" });

function listItem(item: ListItem, task: boolean, ctx: Ctx): JSONContent {
  const kids = item.children.map((c) => block(c, ctx));
  if (typeof item.checked === "boolean" && task) {
    if (kids[0]?.type !== "paragraph") kids.unshift(emptyParagraph());
    return { type: "taskItem", attrs: { checked: item.checked }, content: kids };
  }
  return { type: "listItem", content: kids.length ? kids : [emptyParagraph()] };
}

function list(node: Extract<RootContent, { type: "list" }>, ctx: Ctx): JSONContent {
  const task = node.children.some((i) => typeof i.checked === "boolean");
  let spread = node.spread === true || node.children.some((i) => i.spread === true);
  node.children.forEach((item, i) => {
    const prev = node.children[i - 1];
    const a = prev && posOf(prev);
    const b = posOf(item);
    if (a && b && /\n[ \t]*\r?\n/.test(ctx.src.slice(a.end, b.start))) spread = true;
  });
  const json: JSONContent = {
    type: task ? "taskList" : "list",
    attrs: { ordered: node.ordered === true, start: node.start ?? 1, tight: !spread },
    content: node.children.map((i) => listItem(i, task, ctx)),
  };
  if (!isTight(json)) json.attrs = { ...json.attrs, tight: false };
  return json;
}

function table(node: Table, ctx: Ctx): JSONContent {
  const cols = node.children[0]?.children.length ?? 0;
  const rows = node.children.map((row, r) => {
    const cells = Array.from({ length: cols }, (_, c) => {
      const cell = row.children[c];
      return withContent(r === 0 ? "tableHeader" : "tableCell", undefined, cell ? inline(cell.children, ctx, true) : []);
    });
    return { type: "tableRow", content: cells };
  });
  const align = Array.from({ length: cols }, (_, i) => node.align?.[i] ?? null);
  return { type: "table", attrs: { align }, content: rows };
}

/** Everything after the first line of a callout's first paragraph. */
function afterFirstLine(children: PhrasingContent[]): PhrasingContent[] {
  for (const [i, c] of children.entries()) {
    if (c.type === "break") return children.slice(i + 1);
    if (c.type === "text" && c.value.includes("\n")) {
      const rest = c.value.slice(c.value.indexOf("\n") + 1);
      return [...(rest ? [{ type: "text", value: rest } as Text] : []), ...children.slice(i + 1)];
    }
  }
  return [];
}

function blockquote(node: Extract<RootContent, { type: "blockquote" }>, ctx: Ctx): JSONContent {
  const first = node.children[0];
  const head = first?.type === "paragraph" ? first.children[0] : undefined;
  if (first?.type === "paragraph" && head?.type === "text" && /^\[![A-Za-z0-9_-]+\][+-]?/.test(head.value)) {
    const line = sliceOf(first, ctx).split(/\r?\n/, 1)[0] ?? "";
    const m = CALLOUT_LINE.exec(line);
    if (m) {
      const kids: JSONContent[] = [];
      const restInline = inline(afterFirstLine(first.children), ctx);
      if (restInline.length) kids.push(withContent("paragraph", undefined, restInline));
      kids.push(...node.children.slice(1).map((c) => block(c, ctx)));
      return {
        type: "callout",
        attrs: { kind: m[1]!, fold: m[2]!, title: m[3]! },
        content: kids.length ? kids : [emptyParagraph()],
      };
    }
  }
  const kids = node.children.map((c) => block(c, ctx));
  return { type: "blockquote", content: kids.length ? kids : [emptyParagraph()] };
}

function paragraph(node: Extract<RootContent, { type: "paragraph" }>, ctx: Ctx, top: boolean): JSONContent {
  const text = sliceOf(node, ctx).trim();
  const embed = EMBED.exec(text);
  if (embed) return { type: "embed", attrs: parseWikiInner(embed[1]!) };
  const only = node.children.length === 1 ? node.children[0] : undefined;
  if (only?.type === "image" && !hasMarker(only.url, ctx) && !hasMarker(only.title, ctx) && !hasMarker(only.alt, ctx)) {
    return { type: "image", attrs: { src: only.url, alt: only.alt ?? "", title: only.title ?? null } };
  }
  if (top && text.length >= 4 && text.startsWith("$$") && text.endsWith("$$")) return { type: "math", attrs: { source: text } };
  return withContent("paragraph", undefined, inline(node.children, ctx));
}

function block(node: RootContent, ctx: Ctx, top = false): JSONContent {
  switch (node.type) {
    case "paragraph":
      return paragraph(node, ctx, top);
    case "heading":
      return withContent("heading", { level: node.depth }, inline(node.children, ctx, true));
    case "thematicBreak":
      return { type: "thematicBreak" };
    case "code": {
      const text = node.value.replace(/\r\n?/g, "\n");
      return withContent("code", { lang: node.lang ?? null, meta: node.meta ?? null }, text ? [{ type: "text", text }] : []);
    }
    case "blockquote":
      return blockquote(node, ctx);
    case "list":
      return list(node, ctx);
    case "table":
      return table(node, ctx);
    case "html":
      return { type: "html", attrs: { source: sliceOf(node, ctx) } };
    default:
      return { type: "raw", attrs: { source: sliceOf(node, ctx) } };
  }
}

function topBlock(node: RootContent, ctx: Ctx): JSONContent {
  const source = sliceOf(node, ctx);
  if (node.type === "html") return { type: "html", attrs: { source } };
  if (node.type === "code" && node.lang === "math") return { type: "math", attrs: { source } };
  if (!supported(node)) return { type: "raw", attrs: { source } };
  return block(node, ctx, true);
}

// ---------------------------------------------------------------------------
// Document

/** Code, HTML and GFM autolink literals: `[[...]]` inside them is not a wikilink. */
function excludedSpans(tree: Root, body: string): Span[] {
  const spans: Span[] = [];
  const walk = (n: Nodes) => {
    if (n.type === "link" && n.children.length === 1 && n.children[0]!.type === "text") {
      const p = posOf(n);
      if (p && body.slice(p.start, p.end) === (n.children[0] as Text).value) spans.push(p);
    }
    if (n.type === "code" || n.type === "inlineCode" || n.type === "html") {
      const p = posOf(n);
      if (p) spans.push(p);
      return;
    }
    if ("children" in n) for (const c of n.children) walk(c);
  };
  walk(tree);
  return spans;
}

function detectEol(source: string): "\n" | "\r\n" {
  const i = source.indexOf("\n");
  return i > 0 && source[i - 1] === "\r" ? "\r\n" : "\n";
}

function withSource(node: JSONContent, src: string, sep: string, ix: number): JSONContent {
  const fp = canonBlock(node);
  return { ...node, attrs: { ...node.attrs, mdSrc: src, mdSep: sep, mdFp: fp === src ? null : fp, mdIx: ix } };
}

export function markdownToDoc(source: string): MarkdownDoc {
  const split = splitFrontmatter(source);
  const frontmatter = source.slice(0, split.bodyOffset);
  const body = source.slice(split.bodyOffset);
  const eol = detectEol(source);

  let tree = parseMarkdownTree(body);
  let mask: Mask | undefined;
  if (body.includes("[[")) {
    mask = maskWikilinks(body, findWikilinks(body, excludedSpans(tree, body)));
    if (mask) tree = parseMarkdownTree(mask.text);
  }
  const ctx: Ctx = { src: body, mask };

  let content: JSONContent[] = [];
  let cursor = 0;
  let ok = true;
  for (const [ix, node] of tree.children.entries()) {
    const p = posOf(node);
    if (!p || p.start < cursor || p.end < p.start || p.end > body.length || NON_BLANK.test(body.slice(cursor, p.start))) {
      ok = false;
      break;
    }
    content.push(withSource(topBlock(node, ctx), body.slice(p.start, p.end), body.slice(cursor, p.start), ix));
    cursor = p.end;
  }
  let trailer = body.slice(cursor);
  if (!ok || NON_BLANK.test(trailer)) {
    // The parser's ranges cannot be trusted: keep the whole body as one raw block.
    content = [withSource({ type: "raw", attrs: { source: body } }, body, "", 0)];
    trailer = "";
  }
  // An empty page still needs one block for the editor to hold a cursor.
  if (content.length === 0) content = [{ type: "paragraph", attrs: { mdSrc: "", mdSep: "", mdFp: null, mdIx: 0 } }];
  return { doc: { type: "doc", attrs: { eol, trailer }, content }, frontmatter };
}
