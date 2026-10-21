import { parseMarkdownTree } from "@thoth/content";
import type { JSONContent } from "@tiptap/core";
import { DocAttrsSchema, SOURCE_ATTR_NAMES, SourceAttrsSchema, readAttrs, type SourceAttrs } from "./attrs.ts";
import { canonBlock, listFamily, listMarkerOf, pickMarker, type ListFamily } from "./blocks.ts";

/**
 * Editor document to Markdown.
 *
 * Untouched top-level blocks (canonical form still equals their parse-time
 * fingerprint) are emitted from their original source with their original
 * separator; everything else is emitted canonically. The result is then
 * re-parsed to check that the blocks were not glued together or split, and any
 * offending block falls back to canonical form with a safe separator.
 */
export interface SerializeOptions {
  /** BOM and frontmatter, as returned by `markdownToDoc`. */
  frontmatter?: string;
  /** Re-parse the output to guard block boundaries (default true). */
  verify?: boolean;
}

interface Entry {
  node: JSONContent;
  a: SourceAttrs;
  /** Parse-time source is still valid for this node. */
  untouched: boolean;
}

interface Flags {
  canon: boolean;
  safeSep: boolean;
}

const hasBlankLine = (sep: string) => (sep.match(/\r\n|\n|\r/g) ?? []).length >= 2;
const toEol = (text: string, eol: string) => (eol === "\n" ? text : text.replace(/\r?\n/g, eol));

function entryOf(node: JSONContent): Entry {
  const a = readAttrs(SourceAttrsSchema, node);
  const untouched = a.mdSrc !== null && canonBlock(node) === (a.mdFp ?? a.mdSrc);
  return { node, a, untouched };
}

interface Composed {
  body: string;
  /** Emitted text of each non-empty block. */
  texts: string[];
  /** Entry index of each emitted block. */
  emitted: number[];
}

function compose(entries: Entry[], flags: Flags[], eol: "\n" | "\r\n", trailer: string | null, leadingBlank: boolean): Composed {
  const safe = eol + eol;
  const texts: string[] = [];
  const emitted: number[] = [];
  let body = "";
  let prev: Entry | undefined;
  let prevFamily: ListFamily | undefined;
  let prevMarker: string | undefined;
  entries.forEach((e, i) => {
    const flag = flags[i]!;
    const family = listFamily(e.node);
    const marker = family ? pickMarker(family, family === prevFamily ? prevMarker : undefined) : undefined;
    const text = e.untouched && !flag.canon ? e.a.mdSrc! : toEol(canonBlock(e.node, marker), eol);
    if (text === "") return; // empty paragraphs have no Markdown form
    let sep: string;
    if (prev === undefined) {
      sep = e.a.mdIx === 0 && e.a.mdSep !== null && !flag.safeSep ? e.a.mdSep : leadingBlank ? eol : "";
    } else if (flag.safeSep || e.a.mdSep === null) {
      sep = safe;
    } else if (hasBlankLine(e.a.mdSep) || (prev.a.mdIx !== null && e.a.mdIx === prev.a.mdIx + 1)) {
      sep = e.a.mdSep;
    } else {
      sep = safe;
    }
    body += sep + text;
    texts.push(text);
    emitted.push(i);
    prev = e;
    prevFamily = family;
    prevMarker = family ? listMarkerOf(text) : undefined;
  });
  return { body: body + (trailer ?? (texts.length ? eol : "")), texts, emitted };
}

/** Index of the first emitted block whose boundaries changed on re-parse, or -1. */
function firstMismatch(body: string, texts: string[]): number {
  const kids = parseMarkdownTree(body).children;
  const n = Math.min(kids.length, texts.length);
  for (let j = 0; j < n; j++) {
    const p = kids[j]!.position;
    if (p?.start.offset === undefined || p.end.offset === undefined || body.slice(p.start.offset, p.end.offset) !== texts[j]) return j;
  }
  if (kids.length === texts.length) return -1;
  return Math.min(n, texts.length - 1);
}

const MODELED_RAW = new Set(["raw", "html", "math"]);

export function docToMarkdown(doc: JSONContent, options: SerializeOptions = {}): string {
  if (doc.type !== "doc") throw new Error(`Expected a "doc" node, got "${String(doc.type)}"`);
  const frontmatter = options.frontmatter ?? "";
  const { eol, trailer } = readAttrs(DocAttrsSchema, doc);
  const entries = (doc.content ?? []).map(entryOf);
  const flags: Flags[] = entries.map(() => ({ canon: false, safeSep: false }));
  const leadingBlank = frontmatter.replace(/^﻿/, "") !== "";

  for (let round = 0; ; round++) {
    const { body, texts, emitted } = compose(entries, flags, eol, trailer, leadingBlank);
    if (options.verify === false || texts.length === 0 || round > entries.length * 3 + 3) return frontmatter + body;
    const j = firstMismatch(body, texts);
    if (j < 0) return frontmatter + body;
    // The block after the mismatch usually glued itself to its predecessor; the block itself is the fallback.
    let changed = false;
    for (const t of [emitted[j + 1], emitted[j]]) {
      if (t === undefined) continue;
      const flag = flags[t]!;
      const entry = entries[t]!;
      if (!flag.safeSep) flag.safeSep = changed = true;
      else if (!flag.canon && entry.untouched && !MODELED_RAW.has(entry.node.type ?? "")) flag.canon = changed = true;
      if (changed) break;
    }
    if (!changed) return frontmatter + body;
  }
}

/** Removes source-tracking attributes, so serialization yields the canonical form. */
export function stripSourceAttrs(node: JSONContent): JSONContent {
  const { attrs, content, ...rest } = node;
  const kept = attrs
    ? Object.fromEntries(Object.entries(attrs).filter(([k]) => !(SOURCE_ATTR_NAMES as readonly string[]).includes(k) && !(node.type === "doc" && k === "trailer")))
    : undefined;
  return {
    ...rest,
    ...(kept && Object.keys(kept).length ? { attrs: kept } : {}),
    ...(content ? { content: content.map(stripSourceAttrs) } : {}),
  };
}
