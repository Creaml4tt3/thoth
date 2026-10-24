import type { Nodes, PhrasingContent, Root, Text } from "mdast";
import { isTextColor } from "./attrs.ts";
import type { Span } from "./wikilinks.ts";

/**
 * Text styles beyond CommonMark/GFM (ADR-0016 rule 1): highlight `==x==`, underline `<u>x</u>` and text colour
 * `<span data-color="NAME">x</span>`.
 *
 * mdast has no highlight node and reads the tags as separate inline `html` nodes. Like wikilinks, highlight
 * delimiters are found before the single real parse and replaced by a placeholder of identical length, so offsets
 * stay valid. The placeholder uses Unicode symbol characters, which CommonMark classes as punctuation exactly like
 * `=`, so emphasis around a highlight parses the same as it does in the source.
 *
 * A delimiter is a run of exactly two `=` (after a backslash-escaped `=`, the rest of the run) inside a text node,
 * outside code, HTML, autolinks and references. Whether it can open or close follows GFM strikethrough's flanking
 * rule, decided on the source characters around it. Openers and closers, and the tags, are then paired among
 * sibling inline nodes (`pairStyles`), nearest first; anything unpaired stays as written (`==` text, raw tags).
 */

export interface DelimSpan {
  start: number;
  open: boolean;
  close: boolean;
}

export interface StyleMask {
  /** First placeholder character of a delimiter; absent from the original body. */
  marker: string;
  /** Second placeholder character, by what the delimiter can do. */
  flags: { open: string; close: string; both: string };
}

type Kind = 1 | 2 | undefined; // whitespace (or a line edge), punctuation, other
const classify = (c: string | undefined): Kind => (c === undefined || /\s/.test(c) ? 1 : /[\p{P}\p{S}]/u.test(c) ? 2 : undefined);

/** Text node ranges a delimiter may sit in: not autolinks, references, code or HTML (which have no text children). */
function textRanges(tree: Root, body: string): Span[] {
  const ranges: Span[] = [];
  const walk = (n: Nodes) => {
    if (n.type === "linkReference" || n.type === "imageReference" || n.type === "footnoteReference") return;
    if (n.type === "link" && n.position?.start.offset !== undefined && n.position.end.offset !== undefined) {
      const slice = body.slice(n.position.start.offset, n.position.end.offset);
      const only = n.children.length === 1 ? n.children[0] : undefined;
      // `<https://x>` and GFM literals (`www.x`, `a@b.c`): their text is the address.
      if (slice.startsWith("<") || (only?.type === "text" && slice === (only as Text).value)) return;
    }
    if (n.type === "text") {
      const p = n.position;
      if (p?.start.offset !== undefined && p.end.offset !== undefined) ranges.push({ start: p.start.offset, end: p.end.offset });
      return;
    }
    if ("children" in n) for (const c of n.children) walk(c);
  };
  walk(tree);
  return ranges;
}

/** Highlight delimiters in `body`, outside the excluded spans (wikilinks). */
export function findHighlightDelims(body: string, tree: Root, excluded: Span[]): DelimSpan[] {
  const found: DelimSpan[] = [];
  for (const range of textRanges(tree, body)) {
    const text = body.slice(range.start, range.end);
    for (const m of text.matchAll(/=+/g)) {
      let start = range.start + m.index;
      let length = m[0].length;
      let slashes = 0;
      while (body[start - 1 - slashes] === "\\") slashes++;
      if (slashes % 2 === 1) {
        // `\=` is a literal `=`; the rest of the run may still be a delimiter.
        start++;
        length--;
      }
      if (length !== 2 || excluded.some((s) => start < s.end && start + 2 > s.start)) continue;
      const before = classify(body[start - 1]);
      const after = classify(body[start + 2]);
      const open = !after || (after === 2 && before !== undefined);
      const close = !before || (before === 2 && after !== undefined);
      if (open || close) found.push({ start, open, close });
    }
  }
  return found;
}

/** Symbol characters (CommonMark punctuation) that do not occur in `text`. */
function unusedSymbols(text: string, count: number): string[] | undefined {
  const out: string[] = [];
  for (let c = 0x2200; c <= 0x2bff && out.length < count; c++) {
    const ch = String.fromCharCode(c);
    if (/\p{S}/u.test(ch) && !text.includes(ch)) out.push(ch);
  }
  return out.length === count ? out : undefined;
}

/** Replaces each delimiter in `text` (same length as the body) with its two-character placeholder. */
export function maskHighlights(text: string, delims: DelimSpan[]): { text: string; mask: StyleMask } | undefined {
  if (delims.length === 0) return undefined;
  const chars = unusedSymbols(text, 4);
  if (!chars) return undefined;
  const [marker, open, close, both] = chars as [string, string, string, string];
  const mask: StyleMask = { marker, flags: { open, close, both } };
  let out = "";
  let cursor = 0;
  for (const d of delims) {
    out += text.slice(cursor, d.start) + marker + (d.open && d.close ? both : d.open ? open : close);
    cursor = d.start + 2;
  }
  return { text: out + text.slice(cursor), mask };
}

// ---------------------------------------------------------------------------
// Pairing

type MarkJSON = { type: string; attrs?: Record<string, unknown> };

/** A text, inline node, or a styled run, in document order. */
export type StyleItem =
  | { kind: "text"; value: string }
  | { kind: "node"; node: PhrasingContent }
  | { kind: "styled"; mark: MarkJSON; children: StyleItem[] };

type Token =
  | StyleItem
  | { kind: "delim"; open: boolean; close: boolean }
  | { kind: "tag"; tag: "u" | "span"; open: boolean; mark: MarkJSON | null; node: PhrasingContent };

const U_OPEN = /^<u>$/i;
const U_CLOSE = /^<\/u[ \t]*>$/i;
const SPAN_OPEN = /^<span[\s>]/i;
const COLOR_OPEN = /^<span[ \t]+data-color[ \t]*=[ \t]*(?:"([a-z]+)"|'([a-z]+)'|([a-z]+))[ \t]*>$/;
const SPAN_CLOSE = /^<\/span[ \t]*>$/i;

function tagToken(node: Extract<PhrasingContent, { type: "html" }>): Token {
  const v = node.value;
  if (U_OPEN.test(v)) return { kind: "tag", tag: "u", open: true, mark: { type: "underline" }, node };
  if (U_CLOSE.test(v)) return { kind: "tag", tag: "u", open: false, mark: null, node };
  if (SPAN_CLOSE.test(v)) return { kind: "tag", tag: "span", open: false, mark: null, node };
  if (SPAN_OPEN.test(v)) {
    const m = COLOR_OPEN.exec(v);
    const color = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
    // Any other span (another attribute, an unknown colour) is still paired, so its `</span>` is not taken by a colour.
    return { kind: "tag", tag: "span", open: true, mark: isTextColor(color) ? { type: "textColor", attrs: { color } } : null, node };
  }
  return { kind: "node", node };
}

function tokenize(nodes: PhrasingContent[], mask: StyleMask | undefined): Token[] {
  const out: Token[] = [];
  for (const node of nodes) {
    if (node.type === "html") {
      out.push(tagToken(node));
      continue;
    }
    if (node.type !== "text" || !mask || !node.value.includes(mask.marker)) {
      out.push(node.type === "text" ? { kind: "text", value: node.value } : { kind: "node", node });
      continue;
    }
    let plain = "";
    const v = node.value;
    for (let i = 0; i < v.length; i++) {
      const flag = v[i + 1];
      if (v[i] === mask.marker && flag !== undefined && Object.values(mask.flags).includes(flag)) {
        if (plain) out.push({ kind: "text", value: plain });
        plain = "";
        out.push({ kind: "delim", open: flag !== mask.flags.close, close: flag !== mask.flags.open });
        i++;
      } else plain += v[i];
    }
    if (plain) out.push({ kind: "text", value: plain });
  }
  return out;
}

interface Frame {
  opener: Extract<Token, { kind: "delim" | "tag" }>;
  items: StyleItem[];
}

/** What an opener left unpaired becomes: `==` text, or the raw tag. */
const literal = (t: Frame["opener"]): StyleItem => (t.kind === "delim" ? { kind: "text", value: "==" } : { kind: "node", node: t.node });

/** Pairs highlight delimiters and `<u>`/colour-span tags among siblings, nearest opener first. */
export function pairStyles(nodes: PhrasingContent[], mask: StyleMask | undefined): StyleItem[] {
  const root: StyleItem[] = [];
  const stack: Frame[] = [];
  const current = () => stack.at(-1)?.items ?? root;
  /** Pops frames above `depth`, flattening each into its parent as literal opener + content. */
  const unwind = (depth: number) => {
    while (stack.length > depth) {
      const f = stack.pop()!;
      current().push(literal(f.opener), ...f.items);
    }
  };
  for (const t of tokenize(nodes, mask)) {
    if (t.kind === "text" || t.kind === "node" || t.kind === "styled") {
      current().push(t);
      continue;
    }
    if (t.kind === "delim") {
      const at = t.close ? stack.findLastIndex((f) => f.opener.kind === "delim") : -1;
      if (at >= 0) {
        unwind(at + 1);
        const f = stack.pop()!;
        current().push({ kind: "styled", mark: { type: "highlight" }, children: f.items });
      } else if (t.open) stack.push({ opener: t, items: [] });
      else current().push({ kind: "text", value: "==" });
      continue;
    }
    if (t.open) {
      stack.push({ opener: t, items: [] });
      continue;
    }
    const at = stack.findLastIndex((f) => f.opener.kind === "tag" && f.opener.tag === t.tag);
    if (at < 0) {
      current().push({ kind: "node", node: t.node });
      continue;
    }
    unwind(at + 1);
    const f = stack.pop()!;
    const opener = f.opener as Extract<Token, { kind: "tag" }>;
    if (opener.mark) current().push({ kind: "styled", mark: opener.mark, children: f.items });
    else current().push({ kind: "node", node: opener.node }, ...f.items, { kind: "node", node: t.node });
  }
  unwind(0);
  return root;
}
