/**
 * Unlinked mentions (ADR-0050 rules 4 and 5): where a page's text names another page's title (or, in the Private
 * Space, one of its aliases, ADR-0051 rule 12) without linking it, and how one such mention becomes a link. Pure: no
 * store, no React. Every name is looked for with the same rules.
 *
 * - Matched on the Markdown source of plain text only: never in a link, an image, code, HTML or the frontmatter.
 * - Case-insensitive; a space in the title matches spaces or tabs, never a line break.
 * - Word edges for scripts written with spaces (an "Atlas" is not in "Atlases"); none for Thai, Lao, Khmer, Myanmar,
 *   Chinese and Japanese, which are written without them. A match never ends before a combining mark, and never
 *   starts after a Thai or Lao leading vowel, so it never splits a character as people read it.
 */
import { parseMarkdownTree, splitFrontmatter } from "@thoth/content";

/** Titles shorter than this are not looked for: they find far more noise than mentions. */
export const MIN_TITLE_LENGTH = 3;
/** Words of context shown on each side of a mention, in characters. */
const CONTEXT = 40;

export interface Mention {
  /** UTF-16 offsets into the whole source, frontmatter included. */
  start: number;
  end: number;
  /** The text as written. */
  text: string;
  /** The name it matched: the title or one of the aliases, as the page gives it. */
  name: string;
  /** How many earlier mentions on the page have the same text: finds it again after the page changed. */
  occurrence: number;
  /** In a table cell, where a wikilink's `|` is written `\|`. */
  inTable: boolean;
  /** A few words before and after, on the same line; "…" where the line goes on. */
  before: string;
  after: string;
}

const UNSPACED = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WORDISH = /[\p{L}\p{N}]/u;
const needsEdge = (char: string | undefined) => char !== undefined && WORDISH.test(char) && !UNSPACED.test(char);

export const isTooShort = (title: string) => [...title.trim()].length < MIN_TITLE_LENGTH;

/** The pattern for `title`, or null when it is too short to look for. */
export function mentionPattern(title: string): RegExp | null {
  const clean = title.trim().normalize("NFC");
  if (isTooShort(clean)) return null;
  const chars = [...clean];
  const body = clean
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join("[ \\t]+");
  const head = needsEdge(chars[0]) ? "(?<![\\p{L}\\p{N}\\p{M}])" : "(?<![\\u0E40-\\u0E44\\u0EC0-\\u0EC4])";
  const tail = needsEdge(chars.at(-1)) ? "(?![\\p{L}\\p{N}\\p{M}])" : "(?!\\p{M})";
  return new RegExp(`${head}${body}${tail}`, "giu");
}

interface Run {
  start: number;
  end: number;
  inTable: boolean;
}

const WIKILINK = /!?\[\[[^[\]\n]+?\]\]/g;
const SKIP = new Set(["link", "linkReference", "image", "imageReference", "definition", "code", "inlineCode", "html", "footnoteDefinition"]);

/** The source ranges of plain text, outside links, code and HTML. */
function textRuns(source: string): Run[] {
  const base = splitFrontmatter(source).bodyOffset;
  const body = source.slice(base);
  const runs: Run[] = [];
  type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] };
  const walk = (node: Node, inTable: boolean) => {
    if (SKIP.has(node.type)) return;
    const table = inTable || node.type === "tableCell";
    if (node.type === "text") {
      const s = node.position?.start.offset;
      const e = node.position?.end.offset;
      if (s !== undefined && e !== undefined) runs.push({ start: base + s, end: base + e, inTable: table });
      return;
    }
    for (const child of node.children ?? []) walk(child, table);
  };
  walk(parseMarkdownTree(body) as unknown as Node, false);
  // Wikilinks are text to Markdown: cut them out of the runs.
  const links = [...source.matchAll(WIKILINK)].map((m) => ({ start: m.index, end: m.index + m[0].length })).filter((l) => l.start >= base);
  return runs.flatMap((run) => {
    const out: Run[] = [];
    let from = run.start;
    for (const link of links) {
      if (link.end <= from || link.start >= run.end) continue;
      if (link.start > from) out.push({ ...run, start: from, end: link.start });
      from = Math.max(from, link.end);
    }
    if (from < run.end) out.push({ ...run, start: from });
    return out;
  });
}

const lineContext = (source: string, start: number, end: number) => {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = source.indexOf("\n", end);
  const from = Math.max(lineStart, start - CONTEXT);
  const lineStop = lineEnd === -1 ? source.length : lineEnd;
  const to = Math.min(lineStop, end + CONTEXT);
  // An ellipsis only where the line goes on.
  return { before: (from > lineStart ? "…" : "") + source.slice(from, start).trimStart(), after: source.slice(end, to).trimEnd() + (to < lineStop ? "…" : "") };
};

/** True when none of `names` is long enough to look for. */
export const allTooShort = (names: readonly string[]) => names.every(isTooShort);

/**
 * Every unlinked mention in `source` of `names` (a title, or a title and its aliases), in order; at most `limit`.
 * Where two names match overlapping text, the one that starts first wins, then the longer one ("Bangkok Office"
 * over "Bangkok"), so the same words are never listed twice.
 */
export function findMentions(source: string, names: string | readonly string[], limit = Number.POSITIVE_INFINITY): Mention[] {
  const patterns = (typeof names === "string" ? [names] : names).flatMap((name) => {
    const pattern = mentionPattern(name);
    return pattern ? [{ name, pattern }] : [];
  });
  if (patterns.length === 0) return [];
  const found: { start: number; end: number; text: string; name: string; inTable: boolean }[] = [];
  for (const run of textRuns(source)) {
    const text = source.slice(run.start, run.end).normalize("NFC");
    // NFC can change lengths; such a run is matched only when it was already NFC, so offsets stay exact.
    if (text !== source.slice(run.start, run.end)) continue;
    for (const { name, pattern } of patterns)
      for (const m of text.matchAll(pattern)) found.push({ start: run.start + m.index, end: run.start + m.index + m[0].length, text: m[0], name, inTable: run.inTable });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const seen = new Map<string, number>();
  const out: Mention[] = [];
  let reached = -1;
  for (const f of found) {
    if (f.start < reached) continue;
    if (out.length >= limit) break;
    reached = f.end;
    const key = f.text.toLocaleLowerCase();
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    out.push({ ...f, occurrence, ...lineContext(source, f.start, f.end) });
  }
  return out;
}

/** The same mention in `source` after the page may have changed: same place and text, else the same occurrence of that text. */
export function relocate(source: string, names: string | readonly string[], mention: Pick<Mention, "start" | "text" | "occurrence">): Mention | undefined {
  const now = findMentions(source, names);
  return now.find((m) => m.start === mention.start && m.text === mention.text) ?? now.find((m) => m.text.toLocaleLowerCase() === mention.text.toLocaleLowerCase() && m.occurrence === mention.occurrence);
}

/** A wikilink to `target` showing `text` (no label when they are the same), with `|` escaped in a table. */
export function wikilinkFor(target: string, text: string, inTable: boolean): string {
  if (target === text) return `[[${target}]]`;
  return `[[${target}${inTable ? "\\|" : "|"}${text}]]`;
}

export type LinkOutcome = "linked" | "changed" | "gone";

/** A page as the link action reads and writes it: compare-and-swap on `hash`. */
export interface MentionStore {
  read(): Promise<{ source: string; hash: string } | null>;
  write(source: string, expected: string): Promise<unknown>;
  isConflict(error: unknown): boolean;
}

/**
 * Turns one mention into a link (ADR-0050 rule 5): reads the page afresh, finds the mention again and replaces only
 * its characters, written with compare-and-swap on what was read. One conflict reads again and retries; a second, or
 * a mention no longer there, writes nothing.
 */
export async function linkMention(store: MentionStore, names: string | readonly string[], mention: Pick<Mention, "start" | "text" | "occurrence">, linkText: (found: Mention) => string): Promise<LinkOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await store.read();
    if (!page) return "gone";
    const found = relocate(page.source, names, mention);
    if (!found) return "gone";
    const next = page.source.slice(0, found.start) + linkText(found) + page.source.slice(found.end);
    try {
      await store.write(next, page.hash);
      return "linked";
    } catch (error) {
      if (!store.isConflict(error)) throw error;
    }
  }
  return "changed";
}
