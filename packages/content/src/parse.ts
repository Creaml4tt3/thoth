import { isStableId, basename, stripExtension } from "@thoth/domain";
import type { Nodes, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";
import { parseFrontmatter } from "./frontmatter.ts";
import { LineIndex } from "./lines.ts";
import {
  CONTENT_SCHEMA_VERSION,
  type Block,
  type LinkSyntax,
  type PageDocument,
  type ParsedReference,
} from "./schema.ts";

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const CALLOUT = /^>\s*\[!([A-Za-z0-9_-]+)\][+-]?/;
const BLOCK_ANCHOR = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
const INLINE_TAG = /(?<![\p{L}\p{N}_/&#\]])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function isExternalTarget(target: string): boolean {
  return SCHEME.test(target) || target.startsWith("//");
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseMarkdownTree(body: string): Root {
  return fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

interface Span {
  start: number;
  end: number;
}

function offsets(node: Nodes, base: number): Span | undefined {
  const p = node.position;
  if (p?.start.offset === undefined || p.end.offset === undefined) return undefined;
  return { start: p.start.offset + base, end: p.end.offset + base };
}

function visit(node: Nodes, fn: (n: Nodes) => boolean | void): void {
  if (fn(node) === false) return;
  if ("children" in node) for (const child of node.children) visit(child, fn);
}

/**
 * Index of the `]` matching the `[` at `open`, honoring backslash escapes,
 * nesting, and code spans (brackets inside `code` do not count).
 */
function matchBracket(source: string, open: number, limit: number): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      let run = 1;
      while (source[i + run] === "`") run++;
      const fence = "`".repeat(run);
      const close = source.indexOf(fence, i + run);
      if (close !== -1 && close < limit) {
        i = close + run - 1;
        continue;
      }
      i += run - 1;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

/** Locates the destination inside `(...)` or after `]:`, starting at `from`. */
function destinationSpan(source: string, from: number, limit: number): Span | undefined {
  let i = from;
  while (i < limit && /[ \t\n]/.test(source[i]!)) i++;
  if (source[i] === "<") {
    const close = source.indexOf(">", i + 1);
    return close === -1 || close > limit ? undefined : { start: i + 1, end: close };
  }
  const start = i;
  let depth = 0;
  for (; i < limit; i++) {
    const c = source[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (/\s/.test(c)) break;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  return i > start ? { start, end: i } : undefined;
}

function splitFragment(raw: string): { path: string; fragment?: string } {
  const hash = raw.indexOf("#");
  if (hash === -1) return { path: raw };
  return { path: raw.slice(0, hash), fragment: raw.slice(hash + 1) };
}

/** Parses a Markdown file into the canonical PageDocument (ADR-002). */
export function parsePage(path: string, source: string): PageDocument {
  const fm = parseFrontmatter(source);
  const base = fm.split.bodyOffset;
  const body = source.slice(base);
  const lines = new LineIndex(source);
  const tree = parseMarkdownTree(body);

  const excluded: Span[] = [];
  const references: ParsedReference[] = [];
  const headings: { level: number; text: string }[] = [];
  const inlineTags = new Set<string>();

  const pushMarkdownRef = (syntax: LinkSyntax, span: Span, dest: Span, label?: string) => {
    const rawTarget = source.slice(dest.start, dest.end);
    const { path: rawPath, fragment } = splitFragment(rawTarget);
    const target = safeDecode(rawPath.replace(/\\(.)/g, "$1"));
    references.push({
      syntax,
      target,
      ...(fragment !== undefined ? { fragment: safeDecode(fragment) } : {}),
      ...(label !== undefined ? { label } : {}),
      external: isExternalTarget(rawTarget),
      range: lines.range(span.start, span.end),
      targetRange: lines.range(dest.start, dest.start + rawPath.length),
      rawTarget,
    });
  };

  visit(tree, (node) => {
    const span = offsets(node, base);
    if (!span) return;
    switch (node.type) {
      case "code":
      case "inlineCode":
      case "html":
        excluded.push(span);
        return false;
      case "heading":
        headings.push({ level: node.depth, text: toString(node) });
        return;
      case "text":
        for (const m of node.value.replace(WIKILINK, " ").matchAll(INLINE_TAG)) inlineTags.add(m[1]!);
        return;
      case "link":
      case "image": {
        const open = span.start + (node.type === "image" ? 1 : 0);
        if (source[open] !== "[") return; // autolink or bare URL
        const close = matchBracket(source, open, span.end);
        if (close === -1 || source[close + 1] !== "(") return;
        const dest = destinationSpan(source, close + 2, span.end);
        if (dest) {
          const label = node.type === "image" ? node.alt ?? "" : toString(node);
          pushMarkdownRef(node.type === "image" ? "markdown-image" : "markdown-link", span, dest, label);
        }
        return node.type === "image" ? false : undefined;
      }
      case "definition": {
        const close = matchBracket(source, span.start, span.end);
        if (close === -1 || source[close + 1] !== ":") return;
        const dest = destinationSpan(source, close + 2, span.end);
        if (dest) pushMarkdownRef("definition", span, dest, node.label ?? node.identifier);
        return;
      }
      default:
        return;
    }
  });

  const isExcluded = (offset: number) => excluded.some((s) => offset >= s.start && offset < s.end);

  for (const m of body.matchAll(WIKILINK)) {
    const start = base + m.index;
    if (isExcluded(start)) continue;
    const embed = m[1] === "!";
    const inner = m[2]!;
    const pipe = inner.indexOf("|");
    let targetPart = pipe === -1 ? inner : inner.slice(0, pipe);
    const label = pipe === -1 ? undefined : inner.slice(pipe + 1);
    if (targetPart.endsWith("\\")) targetPart = targetPart.slice(0, -1); // `\|` inside tables
    const { path: rawPath, fragment } = splitFragment(targetPart);
    const targetStart = start + (embed ? 3 : 2);
    references.push({
      syntax: embed ? "embed" : "wikilink",
      target: rawPath.trim(),
      ...(fragment !== undefined ? { fragment: fragment.trim() } : {}),
      ...(label !== undefined ? { label } : {}),
      external: false,
      range: lines.range(start, start + m[0].length),
      targetRange: lines.range(targetStart, targetStart + rawPath.length),
      rawTarget: targetPart,
    });
  }
  references.sort((a, b) => a.range.start - b.range.start);

  const blocks = tree.children.map((node) => toBlock(node, source, base, lines));
  const blockAnchors = blocks.flatMap((b) => (b.anchor ? [b.anchor] : []));

  const data = fm.data;
  const fmTitle = typeof data["title"] === "string" ? data["title"].trim() : "";
  const thothId = typeof data["thoth_id"] === "string" && isStableId(data["thoth_id"]) ? data["thoth_id"] : undefined;

  return {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    path,
    title: fmTitle || stripExtension(basename(path)),
    frontmatter: data,
    ...(fm.error !== undefined ? { frontmatterError: fm.error } : {}),
    bodyOffset: base,
    blocks,
    references,
    headings,
    blockAnchors,
    tags: [...new Set([...stringList(data["tags"] ?? data["tag"]).map((t) => t.replace(/^#/, "")), ...inlineTags])],
    aliases: stringList(data["aliases"] ?? data["alias"]),
    ...(thothId !== undefined ? { thothId } : {}),
    plainText: toString(tree, { includeHtml: false }),
  };
}

/** Accepts YAML lists or comma-separated strings, as Obsidian does. */
export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" || typeof v === "number").map(String);
  if (typeof value === "string")
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

function toBlock(node: RootContent, source: string, base: number, lines: LineIndex): Block {
  const span = offsets(node, base) ?? { start: base, end: base };
  const range = lines.range(span.start, span.end);
  const text = source.slice(span.start, span.end);
  const anchor = BLOCK_ANCHOR.exec(text)?.[1];
  const common = { range, ...(anchor !== undefined ? { anchor } : {}) };
  switch (node.type) {
    case "heading":
      return { type: "heading", level: node.depth, text: toString(node), ...common };
    case "paragraph": {
      const trimmed = text.trim();
      if (/^!\[\[[^[\]\n]+\]\]$/.test(trimmed)) return { type: "embed", ...common };
      if (node.children.length === 1 && node.children[0]!.type === "image") return { type: "image", ...common };
      return { type: "paragraph", ...common };
    }
    case "list": {
      if (node.children.some((item) => typeof item.checked === "boolean")) {
        const tasks = node.children.map((item) => ({ checked: item.checked === true, text: toString(item) }));
        return { type: "taskList", ordered: node.ordered === true, tasks, ...common };
      }
      return { type: "list", ordered: node.ordered === true, ...common };
    }
    case "blockquote": {
      const kind = CALLOUT.exec(text)?.[1];
      return kind ? { type: "callout", calloutKind: kind.toLowerCase(), ...common } : { type: "blockquote", ...common };
    }
    case "code":
      return node.lang === "math"
        ? { type: "math", ...common }
        : { type: "code", ...(node.lang ? { lang: node.lang } : {}), ...common };
    case "table":
      return { type: "table", ...common };
    case "thematicBreak":
      return { type: "thematicBreak", ...common };
    case "html":
      return { type: "html", ...common };
    default:
      return { type: "raw", ...common };
  }
}
