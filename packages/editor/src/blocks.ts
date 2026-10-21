import type { JSONContent } from "@tiptap/core";
import {
  CalloutAttrsSchema,
  CodeAttrsSchema,
  HeadingAttrsSchema,
  ListAttrsSchema,
  SourceOnlyAttrsSchema,
  TableAttrsSchema,
  TaskItemAttrsSchema,
  readAttrs,
  type Align,
} from "./attrs.ts";
import { imageText, renderInline, wikilinkText } from "./inline.ts";

/**
 * Canonical block serializer (docs/architecture/editor-serialization.md).
 * Output uses "\n"; the caller converts to the document's line ending.
 */
const BULLETS = ["-", "*", "+"];
const ORDERED = [".", ")"];

export type ListFamily = "bullet" | "ordered";

export function listFamily(node: JSONContent): ListFamily | undefined {
  if (node.type !== "list" && node.type !== "taskList") return undefined;
  return readAttrs(ListAttrsSchema, node).ordered ? "ordered" : "bullet";
}

/** First marker that differs from the previous sibling list's, so adjacent lists never merge. */
export function pickMarker(family: ListFamily, prev: string | undefined): string {
  const options = family === "bullet" ? BULLETS : ORDERED;
  return options.find((m) => m !== prev) ?? options[0]!;
}

/** Marker character of a list's Markdown (`-`, `*`, `+`, `.` or `)`). */
export function listMarkerOf(text: string): string | undefined {
  const m = /^\s*(?:([-*+])|\d+([.)]))/.exec(text);
  return m?.[1] ?? m?.[2];
}

const isVoid = (n: JSONContent) => n.type === "paragraph" && !(n.content ?? []).some((c) => c.type !== "text" || c.text);

const indent = (text: string, pad: string) => text.split("\n").map((l, i) => (i === 0 || l === "" ? l : pad + l)).join("\n");
const quote = (text: string) => text.split("\n").map((l) => (l === "" ? ">" : `> ${l}`)).join("\n");
const textOf = (n: JSONContent) => (n.content ?? []).map((c) => c.text ?? "").join("").replace(/\r\n?/g, "\n");

/** A tight list item may join a child to the previous one with a single newline only for these. */
const TIGHT_NEXT = new Set(["list", "taskList", "code"]);

/** Effective tightness: the attribute, unless an item's children need blank lines to stay separate blocks. */
export function isTight(list: JSONContent): boolean {
  if (!readAttrs(ListAttrsSchema, list).tight) return false;
  return (list.content ?? []).every((item) =>
    (item.content ?? []).filter((c) => !isVoid(c)).slice(1).every((c) => TIGHT_NEXT.has(c.type ?? "")),
  );
}

/** Joins sibling blocks. `tight` joins list-compatible children with one newline (list items only). */
export function canonBlocks(nodes: JSONContent[], tight = false): string {
  let out = "";
  let prevFamily: ListFamily | undefined;
  let prevMarker: string | undefined;
  for (const node of nodes) {
    const family = listFamily(node);
    const marker = family ? pickMarker(family, family === prevFamily ? prevMarker : undefined) : undefined;
    const text = canonBlock(node, marker);
    if (text === "") continue;
    const sep = out === "" ? "" : tight && TIGHT_NEXT.has(node.type ?? "") ? "\n" : "\n\n";
    out += sep + text;
    prevFamily = family;
    prevMarker = marker;
  }
  return out;
}

function canonList(node: JSONContent, marker: string): string {
  const a = readAttrs(ListAttrsSchema, node);
  const tight = isTight(node);
  const parts = (node.content ?? []).map((item, i) => {
    const m = a.ordered ? `${Math.min(a.start + i, 999_999_999)}${marker}` : marker;
    const kids = item.content ?? [];
    let body = canonBlocks(kids, tight);
    if (item.type === "taskItem") {
      body = `${readAttrs(TaskItemAttrsSchema, item).checked ? "[x]" : "[ ]"}${body === "" ? "" : ` ${body}`}`;
    }
    if (body === "") return m;
    const first = kids.find((k) => !isVoid(k));
    // `- ---` would read as a thematic break; start the item on the next line instead.
    if (item.type !== "taskItem" && first?.type === "thematicBreak") {
      const pad = " ".repeat(m.length + 1);
      return `${m}\n${pad}${indent(body, pad)}`;
    }
    return `${m} ${indent(body, " ".repeat(m.length + 1))}`;
  });
  return parts.join(tight ? "\n" : "\n\n");
}

function canonCode(node: JSONContent): string {
  const a = readAttrs(CodeAttrsSchema, node);
  const text = textOf(node);
  const info = [a.lang, a.meta].filter((s): s is string => !!s).join(" ").replace(/\r?\n|\r/g, " ");
  const ch = info.includes("`") ? "~" : "`";
  const longest = Math.max(0, ...(text.match(new RegExp(`${ch}+`, "g")) ?? []).map((r) => r.length));
  const fence = ch.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text === "" ? "" : `${text}\n`}${fence}`;
}

const DELIM: Record<string, string> = { left: ":--", right: "--:", center: ":-:" };

function canonTable(node: JSONContent): string {
  const rows = node.content ?? [];
  const head = rows[0];
  if (!head) return "";
  const cols = Math.max(1, (head.content ?? []).length);
  const align: Align[] = readAttrs(TableAttrsSchema, node).align;
  const row = (r: JSONContent) => {
    const cells = Array.from({ length: cols }, (_, i) => {
      const cell = (r.content ?? [])[i];
      return renderInline(cell?.content, { start: true, blockEscapes: false, flatten: true, cell: true });
    });
    return `| ${cells.join(" | ")} |`;
  };
  const delimiter = `| ${Array.from({ length: cols }, (_, i) => DELIM[align[i] ?? ""] ?? "---").join(" | ")} |`;
  return [row(head), delimiter, ...rows.slice(1).map(row)].join("\n");
}

function canonCallout(node: JSONContent): string {
  const a = readAttrs(CalloutAttrsSchema, node);
  const kind = a.kind.replace(/[^A-Za-z0-9_-]/g, "") || "note";
  const title = a.title.replace(/\r?\n|\r/g, " ").trim();
  const head = `> [!${kind}]${a.fold}${title === "" ? "" : ` ${title}`}`;
  const kids = (node.content ?? []).filter((k) => !isVoid(k));
  const body = canonBlocks(kids);
  if (body === "") return head;
  // Anything but a paragraph is separated by a `>` line so it cannot be absorbed into the title paragraph.
  return `${head}\n${kids[0]?.type === "paragraph" ? "" : ">\n"}${quote(body)}`;
}

export function canonBlock(node: JSONContent, marker?: string): string {
  const inline = { start: true, blockEscapes: true, flatten: false, cell: false };
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content, inline);
    case "heading": {
      const text = renderInline(node.content, { ...inline, blockEscapes: false, flatten: true }).replace(/(^|[ \t])(#+)$/, (_, lead: string, run: string) => `${lead}${run.slice(0, -1)}\\#`);
      return `${"#".repeat(readAttrs(HeadingAttrsSchema, node).level)}${text === "" ? "" : ` ${text}`}`;
    }
    case "list":
    case "taskList": {
      const family = listFamily(node)!;
      return canonList(node, marker ?? pickMarker(family, undefined));
    }
    case "blockquote": {
      const body = canonBlocks(node.content ?? []);
      return body === "" ? ">" : quote(body);
    }
    case "callout":
      return canonCallout(node);
    case "code":
      return canonCode(node);
    case "table":
      return canonTable(node);
    case "thematicBreak":
      return "***";
    case "image":
      return imageText(node);
    case "embed":
      return wikilinkText(node, true, false);
    case "html":
    case "math":
    case "raw":
      return readAttrs(SourceOnlyAttrsSchema, node).source;
    default:
      throw new Error(`Cannot serialize block node "${String(node.type)}"`);
  }
}
