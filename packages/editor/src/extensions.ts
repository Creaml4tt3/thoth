import { Extension, Mark, Node, getSchema, type AnyExtension } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { SOURCE_ATTR_NAMES } from "./attrs.ts";

/**
 * Tiptap extensions, one per v1 block type (ADR-0002 section 3) plus the
 * inline nodes and marks Markdown needs. They define the schema only; commands,
 * keymaps and rendering belong to the UI layer. No DOM is needed to build the schema.
 */

/** Which editor nodes implement each v1 block type of `@thoth/content`. */
export const V1_BLOCK_NODES = {
  paragraph: ["paragraph"],
  heading: ["heading"],
  list: ["list", "listItem"],
  taskList: ["taskList", "taskItem"],
  blockquote: ["blockquote"],
  callout: ["callout", "calloutTitle"],
  code: ["code"],
  table: ["table", "tableRow", "tableCell", "tableHeader"],
  thematicBreak: ["thematicBreak"],
  image: ["image"],
  embed: ["embed"],
  html: ["html"],
  math: ["math"],
  raw: ["raw"],
} as const;

/** Top-level blocks that carry source-tracking attributes. */
const SOURCE_TRACKED = ["paragraph", "heading", "list", "taskList", "blockquote", "callout", "code", "table", "thematicBreak", "image", "embed", "html", "math", "raw"];

const attr = <T>(def: T) => ({ default: def, rendered: false as const });

const SourceAttrs = Extension.create({
  name: "thothSource",
  addGlobalAttributes() {
    return [
      {
        types: SOURCE_TRACKED,
        attributes: Object.fromEntries(SOURCE_ATTR_NAMES.map((n) => [n, { default: null, rendered: false, keepOnSplit: false }])),
      },
    ];
  },
});

const Doc = Node.create({
  name: "doc",
  topNode: true,
  content: "block+",
  addAttributes: () => ({ eol: attr("\n"), trailer: attr<string | null>(null) }),
});

const Text = Node.create({ name: "text", group: "inline cellInline" });

const Paragraph = Node.create({
  name: "paragraph",
  group: "block",
  content: "inline*",
  parseHTML: () => [{ tag: "p" }],
  renderHTML: () => ["p", 0],
});

const Heading = Node.create({
  name: "heading",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes: () => ({ level: attr(1) }),
  parseHTML: () => [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
  renderHTML: ({ node }) => [`h${node.attrs["level"] as number}`, 0],
});

const List = Node.create({
  name: "list",
  group: "block",
  content: "listItem+",
  addAttributes: () => ({ ordered: attr(false), start: attr(1), tight: attr(true) }),
  parseHTML: () => [{ tag: "ul", attrs: { ordered: false } }, { tag: "ol", attrs: { ordered: true } }],
  renderHTML: ({ node }) => [node.attrs["ordered"] ? "ol" : "ul", 0],
});

const ListItem = Node.create({
  name: "listItem",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "li" }],
  renderHTML: () => ["li", 0],
});

/** Task lists may hold plain items too: Markdown allows `- [ ] a` next to `- b`. */
const TaskList = Node.create({
  name: "taskList",
  group: "block",
  content: "(taskItem | listItem)+",
  addAttributes: () => ({ ordered: attr(false), start: attr(1), tight: attr(true) }),
  parseHTML: () => [{ tag: 'ul[data-type="taskList"]' }],
  renderHTML: ({ node }) => [node.attrs["ordered"] ? "ol" : "ul", { "data-type": "taskList" }, 0],
});

const TaskItem = Node.create({
  name: "taskItem",
  content: "paragraph block*",
  defining: true,
  addAttributes: () => ({ checked: attr(false) }),
  parseHTML: () => [{ tag: 'li[data-type="taskItem"]' }],
  renderHTML: ({ node }) => ["li", { "data-type": "taskItem", "data-checked": String(node.attrs["checked"]) }, 0],
});

const Blockquote = Node.create({
  name: "blockquote",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "blockquote" }],
  renderHTML: () => ["blockquote", 0],
});

/**
 * Obsidian `> [!kind]+ title`. The first child is the editable title line
 * (inline content, no breaks); the rest is the body. `kind` `toggle` is the
 * Notion-style toggle block (`> [!toggle]- Title`).
 */
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "calloutTitle block+",
  defining: true,
  addAttributes: () => ({ kind: attr("note"), fold: attr("") }),
  parseHTML: () => [{ tag: "div[data-callout]" }],
  renderHTML: ({ node }) => ["div", { "data-callout": node.attrs["kind"] as string }, 0],
});

const CalloutTitle = Node.create({
  name: "calloutTitle",
  content: "cellInline*",
  selectable: false,
  parseHTML: () => [{ tag: "div[data-callout-title]" }],
  renderHTML: () => ["div", { "data-callout-title": "", class: "callout-title" }, 0],
});

const Code = Node.create({
  name: "code",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes: () => ({ lang: attr<string | null>(null), meta: attr<string | null>(null) }),
  parseHTML: () => [{ tag: "pre", preserveWhitespace: "full" }],
  renderHTML: () => ["pre", ["code", 0]],
});

const Table = Node.create({
  name: "table",
  group: "block",
  content: "tableRow+",
  isolating: true,
  addAttributes: () => ({ align: attr<(string | null)[]>([]) }),
  parseHTML: () => [{ tag: "table" }],
  renderHTML: () => ["table", ["tbody", 0]],
});

const TableRow = Node.create({
  name: "tableRow",
  content: "(tableHeader | tableCell)+",
  parseHTML: () => [{ tag: "tr" }],
  renderHTML: () => ["tr", 0],
});

/** GFM cells hold inline content only (no hard breaks: a cell is one line). */
const TableCell = Node.create({
  name: "tableCell",
  content: "cellInline*",
  isolating: true,
  parseHTML: () => [{ tag: "td" }],
  renderHTML: () => ["td", 0],
});

const TableHeader = Node.create({
  name: "tableHeader",
  content: "cellInline*",
  isolating: true,
  parseHTML: () => [{ tag: "th" }],
  renderHTML: () => ["th", 0],
});

const ThematicBreak = Node.create({
  name: "thematicBreak",
  group: "block",
  parseHTML: () => [{ tag: "hr" }],
  renderHTML: () => ["hr"],
});

const Image = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: attr(""), alt: attr(""), title: attr<string | null>(null) }),
  parseHTML: () => [{ tag: "img[src]" }],
  renderHTML: ({ node }) => ["img", { src: node.attrs["src"] as string, alt: node.attrs["alt"] as string }],
});

const wikiAttrs = () => ({ target: attr(""), fragment: attr<string | null>(null), label: attr<string | null>(null) });

const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes: wikiAttrs,
  parseHTML: () => [{ tag: "div[data-embed]" }],
  renderHTML: ({ node }) => ["div", { "data-embed": node.attrs["target"] as string }],
});

/** Read-only blocks that carry their exact Markdown source. */
const rawBlock = (name: string) =>
  Node.create({
    name,
    group: "block",
    atom: true,
    draggable: true,
    addAttributes: () => ({ source: attr("") }),
    parseHTML: () => [{ tag: `pre[data-thoth="${name}"]`, preserveWhitespace: "full" }],
    renderHTML: ({ node }) => ["pre", { "data-thoth": name }, node.attrs["source"] as string],
  });

const HardBreak = Node.create({
  name: "hardBreak",
  group: "inline",
  inline: true,
  selectable: false,
  parseHTML: () => [{ tag: "br" }],
  renderHTML: () => ["br"],
});

const Wikilink = Node.create({
  name: "wikilink",
  group: "inline cellInline",
  inline: true,
  atom: true,
  addAttributes: wikiAttrs,
  parseHTML: () => [{ tag: "span[data-wikilink]" }],
  renderHTML: ({ node }) => ["span", { "data-wikilink": node.attrs["target"] as string }, (node.attrs["label"] ?? node.attrs["target"]) as string],
});

const InlineImage = Node.create({
  name: "inlineImage",
  group: "inline cellInline",
  inline: true,
  atom: true,
  addAttributes: () => ({ src: attr(""), alt: attr(""), title: attr<string | null>(null) }),
  parseHTML: () => [{ tag: "img[src]" }],
  renderHTML: ({ node }) => ["img", { src: node.attrs["src"] as string, alt: node.attrs["alt"] as string }],
});

const InlineRaw = Node.create({
  name: "inlineRaw",
  group: "inline cellInline",
  inline: true,
  atom: true,
  addAttributes: () => ({ source: attr("") }),
  parseHTML: () => [{ tag: 'span[data-thoth="inlineRaw"]' }],
  renderHTML: ({ node }) => ["span", { "data-thoth": "inlineRaw" }, node.attrs["source"] as string],
});

const simpleMark = (name: string, tag: string) =>
  Mark.create({ name, parseHTML: () => [{ tag }], renderHTML: () => [tag, 0] });

const Link = Mark.create({
  name: "link",
  inclusive: false,
  addAttributes: () => ({ href: attr(""), title: attr<string | null>(null) }),
  parseHTML: () => [{ tag: "a[href]" }],
  renderHTML: ({ HTMLAttributes }) => ["a", HTMLAttributes, 0],
});

export function thothExtensions(): AnyExtension[] {
  return [
    Doc, Text, Paragraph, Heading, List, ListItem, TaskList, TaskItem, Blockquote, Callout, CalloutTitle, Code,
    Table, TableRow, TableCell, TableHeader, ThematicBreak, Image, Embed,
    rawBlock("html"), rawBlock("math"), rawBlock("raw"),
    HardBreak, Wikilink, InlineImage, InlineRaw,
    simpleMark("bold", "strong"), simpleMark("italic", "em"), simpleMark("strike", "s"), simpleMark("inlineCode", "code"),
    Link, SourceAttrs,
  ];
}

export function thothSchema(): Schema {
  return getSchema(thothExtensions());
}
