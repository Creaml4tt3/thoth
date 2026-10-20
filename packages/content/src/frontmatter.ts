import { Document, isMap, isScalar, parseDocument } from "yaml";

/**
 * YAML frontmatter handling (ADR-001).
 *
 * Unknown keys, their order, and comments are preserved: edits go through the
 * `yaml` Document API instead of re-dumping a plain object. Malformed
 * frontmatter is never rewritten.
 */
export interface FrontmatterSplit {
  /** True when the file starts with a `---` fenced block that is closed. */
  present: boolean;
  /** YAML text between the fences (without fences). */
  yaml: string;
  /** Offset in the source where the body starts. */
  bodyOffset: number;
  /** Newline style detected for the fence lines. */
  eol: "\n" | "\r\n";
  /** Length of a leading UTF-8 BOM, if any (0 or 1 code unit). */
  bomLength: number;
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;

export function splitFrontmatter(source: string): FrontmatterSplit {
  const bomLength = source.startsWith("﻿") ? 1 : 0;
  const text = source.slice(bomLength);
  // Line ending of the opening fence, so frontmatter edits match the frontmatter itself
  // even when the body uses a different style.
  const eol: "\n" | "\r\n" = source.slice(bomLength).startsWith("---\r\n") || /^---[ \t]*\r\n/.test(source.slice(bomLength)) ? "\r\n" : "\n";
  const open = OPEN.exec(text);
  if (!open) return { present: false, yaml: "", bodyOffset: bomLength, eol, bomLength };
  const rest = text.slice(open[0].length);
  // An immediately-closing fence means empty frontmatter.
  const close = CLOSE.exec(rest);
  if (!close || (close.index > 0 && rest[close.index - 1] !== "\n")) {
    return { present: false, yaml: "", bodyOffset: bomLength, eol, bomLength };
  }
  return {
    present: true,
    yaml: rest.slice(0, close.index),
    bodyOffset: bomLength + open[0].length + close.index + close[0].length,
    eol,
    bomLength,
  };
}

export interface ParsedFrontmatter {
  split: FrontmatterSplit;
  /** Plain data; empty object when absent or invalid. */
  data: Record<string, unknown>;
  /** Parse error message when the YAML is malformed or not a mapping. */
  error?: string;
}

export function parseFrontmatter(source: string): ParsedFrontmatter {
  const split = splitFrontmatter(source);
  if (!split.present || split.yaml.trim() === "") return { split, data: {} };
  const doc = parseDocument(split.yaml, { prettyErrors: false, uniqueKeys: false });
  if (doc.errors.length > 0) return { split, data: {}, error: doc.errors[0]!.message };
  if (doc.contents !== null && !isMap(doc.contents)) {
    return { split, data: {}, error: "Frontmatter is not a key/value mapping" };
  }
  // Duplicate keys are ambiguous (readers disagree on first vs last wins); treat as malformed.
  const keys = isMap(doc.contents) ? doc.contents.items.map((p) => (isScalar(p.key) ? String(p.key.value) : "")) : [];
  if (new Set(keys).size !== keys.length) return { split, data: {}, error: "Frontmatter has duplicate keys" };
  try {
    // Unresolved aliases and alias expansion bombs throw here; never let one file break a vault.
    const data = (doc.toJS({ maxAliasCount: 100 }) ?? {}) as Record<string, unknown>;
    return { split, data };
  } catch (error) {
    return { split, data: {}, error: `Frontmatter could not be read: ${(error as Error).message}` };
  }
}

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

/**
 * Sets (or deletes, with `undefined`) top-level frontmatter keys while
 * preserving every other key, comment, and the body byte-for-byte.
 *
 * Edits are spliced into the YAML text by node range, so untouched keys keep
 * their exact formatting (flow lists, quoting, indentation). New keys are
 * appended. Throws FrontmatterError rather than rewriting malformed frontmatter.
 */
export function updateFrontmatter(source: string, changes: Record<string, unknown>): string {
  const split = splitFrontmatter(source);
  const bom = source.slice(0, split.bomLength);
  const eol = split.eol;
  const body = split.present ? source.slice(split.bodyOffset) : source.slice(split.bomLength);
  let yaml = split.present ? split.yaml : "";

  if (yaml.trim() !== "") {
    const doc = parseDocument(yaml, { uniqueKeys: false });
    if (doc.errors.length > 0) throw new FrontmatterError(`Refusing to edit malformed frontmatter: ${doc.errors[0]!.message}`);
    const problem = parseFrontmatter(source).error;
    if (problem) throw new FrontmatterError(`Refusing to edit frontmatter: ${problem}`);
    if (doc.contents !== null && !isMap(doc.contents)) throw new FrontmatterError("Frontmatter is not a mapping");
    if (isMap(doc.contents) && doc.contents.flow) throw new FrontmatterError("Refusing to edit flow-style ({...}) frontmatter");
  }

  for (const [key, value] of Object.entries(changes)) {
    const doc = parseDocument(yaml, { uniqueKeys: false });
    const map = isMap(doc.contents) ? doc.contents : undefined;
    const pair = map?.items.find((p) => isScalar(p.key) && p.key.value === key);
    const keyRange = pair && isScalar(pair.key) ? pair.key.range : undefined;
    const valueNode = pair?.value as { range?: [number, number, number] | null } | null | undefined;
    const valueEnd = valueNode?.range?.[1] ?? keyRange?.[1];
    const rendered = value === undefined ? "" : renderPair(key, value, eol);

    if (pair && keyRange && valueEnd !== undefined) {
      const lineStart = yaml.lastIndexOf("\n", keyRange[0] - 1) + 1;
      const lineEnd = yaml.indexOf("\n", Math.max(valueEnd - 1, keyRange[0]));
      const end = lineEnd === -1 ? yaml.length : lineEnd + 1;
      yaml = yaml.slice(0, lineStart) + rendered + yaml.slice(end);
    } else if (value !== undefined) {
      if (yaml !== "" && !yaml.endsWith("\n")) yaml += eol;
      yaml += rendered;
    }
  }

  if (yaml.trim() === "") return bom + body;
  if (!yaml.endsWith("\n")) yaml += eol;
  return `${bom}---${eol}${yaml}---${eol}${body}`;
}

function renderPair(key: string, value: unknown, eol: string): string {
  const doc = new Document({ [key]: value });
  let text = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  if (eol === "\r\n") text = text.replace(/\r?\n/g, "\r\n");
  return text;
}
