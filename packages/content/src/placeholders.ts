/**
 * Template placeholders (ADR-0051 rule 10): `{{date}}`, `{{time}}`, `{{title}}`, `{{date:<pattern>}}` and
 * `{{time:<pattern>}}`, filled when a page is made from a template, as Obsidian's Templates plugin fills them
 * (defaults `YYYY-MM-DD` and `HH:mm`). Anything else in double braces, a pattern Thoth cannot make, and everything in
 * code blocks and inline code is left exactly as written. Nothing here runs code.
 */
import type { Nodes } from "mdast";
import { datePatternProblem, formatDate } from "./dates.ts";
import { splitFrontmatter } from "./frontmatter.ts";
import { parseMarkdownTree } from "./parse.ts";

const PLACEHOLDER = /\{\{\s*(date|time|title)\s*(?::([^{}\n]*))?\}\}/g;
const DEFAULTS = { date: "YYYY-MM-DD", time: "HH:mm" } as const;

/** Spans of code (fenced, indented and inline) in `source`, as offsets into it. */
function codeSpans(source: string): [number, number][] {
  const base = splitFrontmatter(source).bodyOffset;
  const spans: [number, number][] = [];
  const visit = (node: Nodes) => {
    const { start, end } = node.position ?? {};
    if ((node.type === "code" || node.type === "inlineCode") && start?.offset !== undefined && end?.offset !== undefined) spans.push([base + start.offset, base + end.offset]);
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(parseMarkdownTree(source.slice(base)));
  return spans;
}

/** `source` with its placeholders filled for `now` (local time) and `title`. */
export function fillPlaceholders(source: string, values: { now: Date; title: string }): string {
  if (!source.includes("{{")) return source;
  const code = codeSpans(source);
  return source.replace(PLACEHOLDER, (match: string, name: "date" | "time" | "title", pattern: string | undefined, offset: number) => {
    if (code.some(([start, end]) => offset < end && offset + match.length > start)) return match;
    if (name === "title") return pattern === undefined ? values.title : match;
    const format = pattern?.trim() || DEFAULTS[name];
    return datePatternProblem(format, { time: true }) ? match : formatDate(format, values.now, { time: true });
  });
}
