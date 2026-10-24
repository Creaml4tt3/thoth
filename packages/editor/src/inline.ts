import type { JSONContent } from "@tiptap/core";
import {
  ImageAttrsSchema,
  LinkMarkAttrsSchema,
  SourceOnlyAttrsSchema,
  TextColorMarkAttrsSchema,
  WikiAttrsSchema,
  readAttrs,
} from "./attrs.ts";
import { entityFirst, entityLastIfBlank, escapeEntities, escapeText } from "./escape.ts";

/**
 * Canonical inline serializer. Marks are rendered as a nesting tree so that
 * adjacent runs share delimiters; whitespace at the edge of a mark moves
 * outside the delimiters (otherwise `** x**` would not be emphasis).
 */
export interface InlineOptions {
  /** The first character begins a line of a Markdown block. */
  start: boolean;
  /** Escape block-start syntax at line starts (paragraphs, list items). */
  blockEscapes: boolean;
  /** Single-line context (heading, table cell): breaks become spaces. */
  flatten: boolean;
  /** Table cell: pipes inside code spans need a backslash. */
  cell: boolean;
  /** Inside link text, where autolink literals are not recognized. */
  inLink?: boolean;
  /** The last node of the content: its trailing blank needs a character reference. */
  last?: JSONContent;
}

type Mark = { type: string; attrs?: Record<string, unknown> | undefined };
/**
 * Nesting order, outermost first. The HTML marks (ADR-0016) go outside the delimiter marks: a tag can sit anywhere,
 * while `==` next to `**` must still pass the flanking rules.
 */
export const MARK_ORDER = ["link", "textColor", "underline", "highlight", "bold", "italic", "strike", "inlineCode"];
const DELIMITERS: Record<string, string> = { highlight: "==", bold: "**", italic: "*", strike: "~~" };

const colorOf = (m: Mark) => readAttrs(TextColorMarkAttrsSchema, m).color;

function markKey(m: Mark): string {
  if (m.type === "textColor") return `textColor:${colorOf(m)}`;
  if (m.type !== "link") return m.type;
  const a = readAttrs(LinkMarkAttrsSchema, m);
  return `link:${JSON.stringify([a.href, a.title])}`;
}

/** Known marks, deduplicated and in nesting order (outermost first). A colour outside the palette, or a second one, is dropped. */
function marksOf(node: JSONContent): Mark[] {
  const seen = new Map<string, Mark>();
  for (const m of (node.marks ?? []) as Mark[]) {
    if (m.type === "textColor" && (colorOf(m) === null || [...seen.values()].some((s) => s.type === "textColor"))) continue;
    if (MARK_ORDER.includes(m.type) && !seen.has(markKey(m))) seen.set(markKey(m), m);
  }
  return [...seen.values()].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

const sameMarks = (a: JSONContent, b: JSONContent) => marksOf(a).map(markKey).join("\0") === marksOf(b).map(markKey).join("\0");

/** Drops empty text, merges equal-mark neighbours, applies flattening and trims trailing breaks. */
function normalize(content: JSONContent[], o: InlineOptions): JSONContent[] {
  const out: JSONContent[] = [];
  for (const n of content) {
    const node: JSONContent =
      n.type === "hardBreak" && o.flatten ? { type: "text", text: " ", ...(n.marks ? { marks: n.marks } : {}) } : n;
    if (node.type === "text") {
      if (!node.text) continue;
      const prev = out.at(-1);
      if (prev?.type === "text" && sameMarks(prev, node)) {
        out[out.length - 1] = { ...prev, text: (prev.text ?? "") + node.text };
        continue;
      }
    }
    out.push(node);
  }
  while (out.at(-1)?.type === "hardBreak") out.pop();
  return out;
}

type Tree = { kind: "leaf"; node: JSONContent } | { kind: "mark"; mark: Mark; key: string; children: Tree[] };

function buildTree(nodes: JSONContent[]): Tree[] {
  const root: Tree[] = [];
  const stack: Extract<Tree, { kind: "mark" }>[] = [];
  for (const node of nodes) {
    const marks = marksOf(node);
    const keys = marks.map(markKey);
    let keep = 0;
    while (keep < stack.length && keys.includes(stack[keep]!.key)) keep++;
    stack.length = keep;
    for (const m of marks) {
      if (stack.some((s) => s.key === markKey(m))) continue;
      const entry: Extract<Tree, { kind: "mark" }> = { kind: "mark", mark: m, key: markKey(m), children: [] };
      (stack.at(-1)?.children ?? root).push(entry);
      stack.push(entry);
    }
    (stack.at(-1)?.children ?? root).push({ kind: "leaf", node });
  }
  return root;
}

function wikiText(attrs: ReturnType<typeof readWiki>, embed: boolean, cell: boolean): string {
  const clean = (s: string) => s.replace(/[[\]\n\r]/g, "");
  const target = clean(attrs.target).replace(/[|#]/g, "");
  const fragment = attrs.fragment === null ? "" : `#${clean(attrs.fragment).replace(/\|/g, "")}`;
  const label = attrs.label === null ? "" : `${cell ? "\\|" : "|"}${clean(attrs.label)}`;
  return `${embed ? "!" : ""}[[${target}${fragment}${label}]]`;
}
const readWiki = (n: JSONContent) => readAttrs(WikiAttrsSchema, n);
export const wikilinkText = (n: JSONContent, embed: boolean, cell: boolean) => wikiText(readWiki(n), embed, cell);

const balanced = (s: string) => {
  let depth = 0;
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return false;
  }
  return depth === 0;
};

/** Link destination: bare when safe, otherwise `<...>`. */
export function destination(href: string): string {
  if (href !== "" && !/[\s<>\\\u0000-\u001f]/.test(href) && balanced(href) && !/&#?[A-Za-z0-9]+;/.test(href)) return href;
  return `<${escapeEntities(href).replace(/[<>\\]/g, "\\$&").replace(/\r?\n|\r/g, "%0A")}>`;
}

export function titleSuffix(title: string | null): string {
  if (title === null) return "";
  return ` "${escapeEntities(title).replace(/[\\"]/g, "\\$&").replace(/\r?\n|\r/g, " ")}"`;
}

export function imageText(n: JSONContent): string {
  const a = readAttrs(ImageAttrsSchema, n);
  const alt = escapeText(a.alt, { blockEscapes: false, firstLineStart: false, flatten: true, urls: "off" });
  return `![${alt}](${destination(a.src)}${titleSuffix(a.title)})`;
}

function codeSpan(text: string, cell: boolean): string {
  let t = text.replace(/\r?\n|\r/g, " ");
  if (cell) t = t.replace(/\|/g, "\\|");
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = /^`|`$/.test(t) || (t.length > 1 && t.startsWith(" ") && t.endsWith(" ") && t.trim() !== "");
  return pad ? `${fence} ${t} ${fence}` : `${fence}${t}${fence}`;
}

const AUTOLINK = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\u0000-\u001f]*$/;

function plainText(n: JSONContent): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "wikilink") return wikilinkText(n, false, false);
  if (n.type === "inlineRaw") return readAttrs(SourceOnlyAttrsSchema, n).source;
  return "";
}

/** Which edges of a text leaf touch a highlight's `==` (its `=` there must be escaped, or the run grows). */
type EqEdges = { start: boolean; end: boolean };
const NO_EDGES: EqEdges = { start: false, end: false };

function renderLeaf(node: JSONContent, o: InlineOptions, atStart: boolean, eq: EqEdges): string {
  switch (node.type) {
    case "text":
      return escapeText(node.text ?? "", { blockEscapes: o.blockEscapes, firstLineStart: atStart, flatten: o.flatten, urls: o.inLink ? "off" : o.cell ? "cell" : "verify", endsLine: node === o.last, eqStart: eq.start, eqEnd: eq.end });
    case "hardBreak":
      return "\\\n";
    case "wikilink":
      return wikilinkText(node, false, o.cell);
    case "inlineImage":
      return imageText(node);
    case "inlineRaw":
      return readAttrs(SourceOnlyAttrsSchema, node).source;
    default:
      throw new Error(`Cannot serialize inline node "${String(node.type)}"`);
  }
}

function renderMark(t: Extract<Tree, { kind: "mark" }>, o: InlineOptions): string {
  if (t.mark.type === "inlineCode") {
    const text = t.children.map((c) => (c.kind === "leaf" ? plainText(c.node) : "")).join("");
    return text === "" ? "" : codeSpan(text, o.cell);
  }
  if (t.mark.type === "underline" || t.mark.type === "textColor") {
    // HTML marks keep their content as is (edge blanks included): a tag needs no flanking.
    const inner = renderNodes(t.children, false, o);
    if (inner === "") return "";
    return t.mark.type === "underline" ? `<u>${inner}</u>` : `<span data-color="${colorOf(t.mark)!}">${inner}</span>`;
  }
  const highlight = t.mark.type === "highlight";
  const inner = renderNodes(t.children, false, t.mark.type === "link" ? { ...o, inLink: true } : o, highlight ? { start: true, end: true } : NO_EDGES);
  if (t.mark.type === "link") {
    const a = readAttrs(LinkMarkAttrsSchema, t.mark);
    const bare = t.children.every((c) => c.kind === "leaf" && c.node.type === "text" && marksOf(c.node).length === 1);
    const raw = t.children.map((c) => (c.kind === "leaf" ? (c.node.text ?? "") : "")).join("");
    if (bare && a.title === null && raw === a.href && AUTOLINK.test(a.href)) return `<${a.href}>`;
    return `[${inner}](${destination(a.href)}${titleSuffix(a.title)})`;
  }
  const d = DELIMITERS[t.mark.type] ?? "";
  const m = /^([ \t\n]*)([\s\S]*?)([ \t\n]*)$/.exec(inner)!;
  return m[2] === "" ? inner : `${m[1]}${d}${m[2]}${d}${m[3]}`;
}

const isHighlight = (t: Tree | undefined) => t?.kind === "mark" && t.mark.type === "highlight";

/** `edges`: the children sit directly inside `==` (a highlight), so the first and last leaves touch it. */
function renderNodes(children: Tree[], start: boolean, o: InlineOptions, edges: EqEdges = NO_EDGES): string {
  let out = "";
  for (const [i, ch] of children.entries()) {
    const atStart = out === "" ? start : out.endsWith("\n");
    const eq = { start: i === 0 ? edges.start : isHighlight(children[i - 1]), end: i === children.length - 1 ? edges.end : isHighlight(children[i + 1]) };
    let piece = ch.kind === "leaf" ? renderLeaf(ch.node, o, atStart, eq) : renderMark(ch, o);
    if (atStart && /^[ \t]/.test(piece)) piece = entityFirst(piece);
    out += piece;
  }
  return out;
}

export function renderInline(content: JSONContent[] | undefined, o: InlineOptions): string {
  // Leading and trailing line breaks have no Markdown form.
  const nodes = normalize(content ?? [], o);
  const out = renderNodes(buildTree(nodes), o.start, { ...o, ...(nodes.length ? { last: nodes[nodes.length - 1]! } : {}) }).replace(/^\n+|\n+$/g, "");
  return entityLastIfBlank(out);
}
