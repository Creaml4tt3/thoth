import { parseMarkdownTree } from "@thoth/content";
import type { Nodes } from "mdast";

/**
 * Text escaping for the canonical serializer.
 *
 * Goal: the escaped text reparses to exactly the same characters. Escaping is
 * conservative (a backslash before ASCII punctuation is always legal), except
 * `_` between alphanumerics, which cannot open or close emphasis.
 *
 * GFM autolink literals (`https://x`, `www.x`, `a@b.c`) are the exception: the
 * micromark tokenizer reads them raw, so a backslash inside one stays in the
 * text. Candidate forms are tried in order and verified by parsing each:
 *   1. the run unescaped (what people write: `https://x.com/a_b`);
 *   2. the same without the parser's trailing-punctuation trimming;
 *   3. the run's first character as a character reference (`h&#116;tp://`),
 *      which defeats the tokenizer so ordinary escapes apply;
 *   4. everything escaped (only reached when parsing cannot be verified).
 * The parser side keeps literal autolinks as plain text (see `parse.ts`), so
 * they are stable under reparse.
 */
const ALNUM = /[\p{L}\p{N}]/u;
const ENTITY = /^#?[A-Za-z0-9]+;/;

export interface EscapeOptions {
  /** Escape block-start syntax (`#`, `>`, `-`, `1.`...) at line starts. */
  blockEscapes: boolean;
  /** The text begins a line. */
  firstLineStart: boolean;
  /** Single-line context (heading, table cell, link title): newlines become spaces. */
  flatten: boolean;
  /**
   * How URL-like runs are written. `verify`: candidate forms checked by reparsing
   * (as a paragraph, or as a table cell with `cell`). `off`: escaped like any text (link text).
   */
  urls?: "verify" | "cell" | "off";
  /** The text ends the line: a trailing blank becomes a character reference (verified with the rest). */
  endsLine?: boolean;
}

export function entityFirst(s: string): string {
  return (s.startsWith("\t") ? "&#x9;" : "&#x20;") + s.slice(1);
}

function entityLast(s: string): string {
  return s.slice(0, -1) + (s.endsWith("\t") ? "&#x9;" : "&#x20;");
}

export function entityLastIfBlank(s: string): string {
  return /[ \t]$/.test(s) ? entityLast(s) : s;
}

/** Escapes the first characters of a line so they cannot start a block. */
function escapeBlockStart(line: string): string {
  if (/^#/.test(line)) return `\\${line}`;
  if (/^>/.test(line)) return `\\${line}`;
  if (/^\$\$/.test(line)) return `\\${line}`; // `$$...$$` is a math block
  if (/^[-+](?=[ \t]|$)/.test(line) || /^-+[ \t]*$/.test(line) || /^=+[ \t]*$/.test(line)) return `\\${line}`;
  const ordered = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(line);
  if (ordered) return `${ordered[1]}\\${line.slice(ordered[1]!.length)}`;
  return line;
}

// ---------------------------------------------------------------------------
// URL-like runs

const URL_RUN = /(?:https?:\/\/|(?<![A-Za-z0-9])www\.)[^\s<]*/gi;
const EMAIL_RUN = /[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g;
const MAYBE_URL = /:\/\/|www\.|@/i;

interface Run {
  start: number;
  end: number;
  /** Index of the character to write as a character reference to defeat the tokenizer. */
  breakAt: number;
}

/** Candidate autolink literal spans. `trim` mimics the parser dropping trailing punctuation. */
function urlRuns(s: string, trim: boolean): Run[] {
  const runs: Run[] = [];
  for (const m of s.matchAll(URL_RUN)) {
    let end = m.index + m[0].length;
    if (trim) {
      for (;;) {
        const last = s[end - 1];
        const run = s.slice(m.index, end);
        const unbalanced = last === ")" && run.split(")").length > run.split("(").length;
        const entity = /&[A-Za-z0-9]+;$/.exec(run);
        if (end > m.index && entity) end -= entity[0].length;
        else if (end > m.index && (unbalanced || (last !== undefined && "?!.,:;*_~'\"".includes(last)))) end--;
        else break;
      }
    }
    if (end > m.index) runs.push({ start: m.index, end, breakAt: m.index });
  }
  for (const m of s.matchAll(EMAIL_RUN)) runs.push({ start: m.index, end: m.index + m[0].length, breakAt: m.index + m[0].indexOf("@") });
  runs.sort((a, b) => a.start - b.start);
  const merged: Run[] = [];
  for (const r of runs) {
    const prev = merged.at(-1);
    if (prev && r.start <= prev.end) prev.end = Math.max(prev.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** Every place a tokenizer could start an autolink literal (unmerged), written as a numeric reference. */
function breakPoints(s: string): Set<number> {
  const points = new Set<number>();
  for (const m of s.matchAll(URL_RUN)) points.add(m.index);
  for (const m of s.matchAll(/https?:\/\/|(?<![A-Za-z0-9])www\./gi)) points.add(m.index);
  for (const m of s.matchAll(EMAIL_RUN)) points.add(m.index + m[0].indexOf("@"));
  return points;
}

function plainOf(n: Nodes): string {
  if (n.type === "text" || n.type === "inlineCode") return n.value;
  if (n.type === "break") return "\n";
  return "children" in n ? n.children.map(plainOf).join("") : "";
}

/** True when `md`, read as a paragraph (or table cell), has exactly the text `expected`. */
function survives(md: string, expected: string, cell: boolean, exact: boolean): boolean {
  const tree = parseMarkdownTree(cell ? `| a |\n| - |\n| (${md} |` : `(${md}`);
  const only = tree.children[0];
  // Edge line breaks have no Markdown form (the inline serializer trims them).
  const want = `(${expected.replace(/\n+$/, "")}`;
  const same = (got: string) => (exact ? got === want : got.trimEnd() === want.trimEnd());
  if (tree.children.length !== 1) return false;
  if (!cell) return only?.type === "paragraph" && same(plainOf(only));
  const body = only?.type === "table" ? only.children[1] : undefined;
  return only?.type === "table" && only.children.length === 2 && body?.children.length === 1 && same(plainOf(body.children[0]!));
}

// ---------------------------------------------------------------------------

function escapeChars(s: string, runs: Run[], cell: boolean, breaks: Set<number> = new Set()): string {
  let out = "";
  let r = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (breaks.has(i)) {
      out += `&#${c.charCodeAt(0)};`;
      continue;
    }
    while (runs[r] && i >= runs[r]!.end) r++;
    if (runs[r] && i >= runs[r]!.start) {
      out += c === "|" && cell ? "\\|" : c; // raw inside an autolink literal
      continue;
    }
    switch (c) {
      case "\\":
      case "*":
      case "`":
      case "[":
      case "]":
      case "<":
      case "~":
      case "|":
        out += `\\${c}`;
        break;
      case "_": {
        const prev = s[i - 1];
        const next = s[i + 1];
        out += prev !== undefined && next !== undefined && ALNUM.test(prev) && ALNUM.test(next) ? c : "\\_";
        break;
      }
      case "&":
        out += ENTITY.test(s.slice(i + 1)) ? "\\&" : "&";
        break;
      default:
        out += c;
    }
  }
  return out;
}

function perLine(escaped: string, o: EscapeOptions): string {
  const lines = escaped.split("\n");
  return lines
    .map((line, i) => {
      let l = line;
      if (i > 0 || o.firstLineStart) {
        if (i > 0 && /^[ \t]/.test(l)) l = entityFirst(l);
        else if (o.blockEscapes) l = escapeBlockStart(l);
      }
      if ((i < lines.length - 1 || o.endsLine) && /[ \t]$/.test(l)) l = entityLast(l);
      return l;
    })
    .join("\n");
}

export function escapeText(raw: string, o: EscapeOptions): string {
  let s = raw.replace(/\r\n?/g, "\n");
  s = o.flatten ? s.replace(/\n+/g, " ") : s.replace(/\n{2,}/g, "\n");
  const mode = o.urls ?? "verify";
  const plain = () => perLine(escapeChars(s, [], false), o);
  if (mode === "off" || !MAYBE_URL.test(s)) return plain();
  const cell = mode === "cell";
  const candidates = [
    perLine(escapeChars(s, urlRuns(s, true), cell), o),
    perLine(escapeChars(s, urlRuns(s, false), cell), o),
    perLine(escapeChars(s, [], cell, breakPoints(s)), o),
  ];
  return candidates.find((c) => survives(c, s, cell, o.endsLine === true)) ?? plain();
}

/** Escapes `&` that would otherwise decode as a character reference. */
export function escapeEntities(s: string): string {
  return s.replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&");
}
