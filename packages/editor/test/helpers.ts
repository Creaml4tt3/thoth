import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { docToMarkdown, markdownToDoc, stripSourceAttrs } from "../src/index.ts";

export const FIXTURES = new URL("../../../tests/fixtures/", import.meta.url).pathname;
export const GOLDEN = new URL("./golden/", import.meta.url).pathname;

export function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return path.endsWith(".md") ? [path] : [];
  });
}

export const read = (path: string) => readFileSync(path, "utf8");

/** parse then serialize, untouched. */
export function roundTrip(source: string): string {
  const { doc, frontmatter } = markdownToDoc(source);
  return docToMarkdown(doc, { frontmatter });
}

/** parse, drop all source attributes, serialize: the canonical form. */
export function canonical(source: string): string {
  const { doc, frontmatter } = markdownToDoc(source);
  return docToMarkdown(stripSourceAttrs(doc), { frontmatter });
}

/** Document content without source attributes, for semantic comparison. */
export function semantic(source: string): JSONContent[] {
  return stripSourceAttrs(markdownToDoc(source).doc).content ?? [];
}

export function blocks(doc: JSONContent): JSONContent[] {
  return doc.content ?? [];
}

/** Concatenated text of a node; hard breaks count as newlines. */
export function textOf(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(textOf).join("");
}

export function paragraph(text: string): JSONContent {
  return { type: "paragraph", content: text === "" ? [] : [{ type: "text", text }] };
}

export function withContent(node: JSONContent, text: string): JSONContent {
  return { ...node, content: text === "" ? [] : [{ type: "text", text }] };
}

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;

/** Names of every node and mark type used in a document. */
export function typesIn(node: JSONContent, into = new Set<string>()): Set<string> {
  if (node.type) into.add(node.type);
  for (const m of node.marks ?? []) into.add(m.type);
  for (const c of node.content ?? []) typesIn(c, into);
  return into;
}
