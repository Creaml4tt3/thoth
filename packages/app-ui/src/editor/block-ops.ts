/**
 * Block-level edits on a ProseMirror transaction: move, duplicate, delete and
 * "turn into". The `/` menu, the block menu, the keyboard shortcuts, drag and
 * drop and the Markdown input rules all call these, so each user action is one
 * transaction (one undo step).
 *
 * A "block" is a top-level node or a list item. Moving keeps the very same
 * node objects, so a block that was not edited keeps its source attributes and
 * is written back byte-for-byte (docs/architecture/editor-serialization.md).
 * New and converted blocks have no source and are written canonically.
 */
import { closeHistory } from "@tiptap/pm/history";
import type { EditorView } from "@tiptap/pm/view";
import { Fragment, type Node as PMNode, type ResolvedPos, type Schema } from "@tiptap/pm/model";
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { SOURCE_ATTR_NAMES } from "@thoth/editor";
import type { BlockKind } from "./block-kinds.ts";

export interface BlockTarget {
  /** Position directly before the block. */
  pos: number;
  node: PMNode;
}

const ITEMS = new Set(["listItem", "taskItem"]);
const isItem = (node: PMNode) => ITEMS.has(node.type.name);
/** Nodes whose children are movable blocks: the page, quotes and callout bodies. */
const CONTAINERS = new Set(["doc", "blockquote", "callout"]);

/**
 * The block around `$pos`: the innermost list item, else the innermost node
 * that sits directly in the page, a quote or a callout body (a callout title
 * belongs to its callout).
 */
export function blockAtResolved($pos: ResolvedPos): BlockTarget | null {
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d);
    if (isItem(node)) return { pos: $pos.before(d), node };
    if (CONTAINERS.has($pos.node(d - 1).type.name) && node.type.name !== "calloutTitle") return { pos: $pos.before(d), node };
  }
  return null;
}

export function blockAtSelection(state: EditorState): BlockTarget | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    const parent = selection.$from.parent;
    if (isItem(selection.node) || CONTAINERS.has(parent.type.name)) return { pos: selection.from, node: selection.node };
  }
  return blockAtResolved(selection.$head);
}

/** The block a gutter handle belongs to: a list item, else the top-level node. */
export function handleBlockAt($pos: ResolvedPos): BlockTarget | null {
  for (let d = $pos.depth; d >= 1; d--) {
    if (isItem($pos.node(d))) return { pos: $pos.before(d), node: $pos.node(d) };
  }
  if ($pos.depth >= 1) return { pos: $pos.before(1), node: $pos.node(1) };
  // A top-level atom (image, embed, raw) has no inside: the position is just before it.
  return $pos.nodeAfter ? { pos: $pos.pos, node: $pos.nodeAfter } : null;
}

/** The block a `/` typed in the textblock at `$pos` converts: the list item when the text is its first line, else the textblock. */
export function slashTarget($pos: ResolvedPos): BlockTarget {
  const d = $pos.depth;
  if (d >= 2 && isItem($pos.node(d - 1)) && $pos.index(d - 1) === 0) return { pos: $pos.before(d - 1), node: $pos.node(d - 1) };
  return { pos: $pos.before(d), node: $pos.parent };
}

/**
 * Runs `edit` as one undo step: history is closed before and after, so the
 * edit neither merges with earlier typing nor swallows what is typed next.
 * Returns false (and dispatches nothing) when `edit` reports no change.
 */
export function applyAsOneStep(view: EditorView, edit: (tr: Transaction) => boolean): boolean {
  const tr = closeHistory(view.state.tr);
  if (!edit(tr)) return false;
  view.dispatch(tr.scrollIntoView());
  view.dispatch(closeHistory(view.state.tr));
  return true;
}

const clearSource = (attrs: Record<string, unknown>): Record<string, unknown> => ({ ...attrs, ...Object.fromEntries(SOURCE_ATTR_NAMES.map((n) => [n, null])) });
const sizes = (nodes: readonly PMNode[]) => nodes.reduce((sum, n) => sum + n.nodeSize, 0);
const childrenOf = (node: PMNode): PMNode[] => {
  const out: PMNode[] = [];
  node.forEach((c) => out.push(c));
  return out;
};

// ---------------------------------------------------------------------------
// Kinds

/** What a block is, in the vocabulary of the `/` menu; null for blocks that cannot be converted (images, tables, raw). */
export function kindOfBlock(node: PMNode, parent: PMNode | null): BlockKind | null {
  switch (node.type.name) {
    case "paragraph":
      return "text";
    case "heading": {
      const level = node.attrs["level"] as number;
      return level <= 3 ? (`h${level}` as BlockKind) : null;
    }
    case "taskItem":
      return "todo";
    case "listItem":
      return parent?.attrs["ordered"] === true ? "numbered" : "bullet";
    case "blockquote":
      return "quote";
    case "callout":
      return node.attrs["kind"] === "toggle" ? "toggle" : "callout";
    case "code":
      return "code";
    case "thematicBreak":
      return "divider";
    default:
      return null;
  }
}

const CONVERTIBLE = new Set(["paragraph", "heading", "listItem", "taskItem", "blockquote", "callout", "code", "thematicBreak"]);

export const canTurnInto = (target: BlockTarget): boolean => CONVERTIBLE.has(target.node.type.name);

// ---------------------------------------------------------------------------
// Building blocks

interface Parts {
  /** Inline content of the block's first line. */
  head: Fragment;
  /** Blocks that follow it (list item children, a callout body...). */
  rest: PMNode[];
}

function lines(schema: Schema, text: string): Fragment {
  const out: PMNode[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) out.push(schema.nodes["hardBreak"]!.create());
    if (line) out.push(schema.text(line));
  });
  return Fragment.from(out);
}

const plainOf = (content: Fragment): string =>
  content.textBetween(0, content.size, "\n", (leaf) => {
    const name = leaf.type.name;
    if (name === "hardBreak") return "\n";
    if (name === "wikilink") return `[[${String(leaf.attrs["target"])}]]`;
    if (name === "inlineRaw") return String(leaf.attrs["source"]);
    return "";
  });

/** Callout titles are one line: breaks become spaces. */
function titleOf(schema: Schema, content: Fragment): PMNode {
  const nodes: PMNode[] = [];
  content.forEach((n) => nodes.push(n.type.name === "hardBreak" ? schema.text(" ") : n));
  return schema.nodes["calloutTitle"]!.create(null, nodes);
}

const emptyOnly = (body: PMNode[]) => (body.length === 1 && body[0]!.type.name === "paragraph" && body[0]!.content.size === 0 ? [] : body);

function partsOf(node: PMNode, schema: Schema): Parts | null {
  const kids = childrenOf(node);
  switch (node.type.name) {
    case "paragraph":
    case "heading":
      return { head: node.content, rest: [] };
    case "code":
      return { head: lines(schema, node.textContent), rest: [] };
    case "thematicBreak":
      return { head: Fragment.empty, rest: [] };
    case "listItem":
    case "taskItem":
    case "blockquote": {
      const first = kids[0];
      if (first && (first.type.name === "paragraph" || (node.type.name === "blockquote" && first.type.name === "heading"))) return { head: first.content, rest: kids.slice(1) };
      return { head: Fragment.empty, rest: kids };
    }
    case "callout": {
      const title = kids[0]!;
      const body = kids.slice(1);
      if (title.content.size > 0) return { head: title.content, rest: emptyOnly(body) };
      if (body[0]?.type.name === "paragraph") return { head: body[0].content, rest: body.slice(1) };
      return { head: Fragment.empty, rest: body };
    }
    default:
      return null;
  }
}

/** The nodes that make up `kind`, holding `head` and, after it, `rest`. */
function build(schema: Schema, kind: BlockKind, head: Fragment, rest: PMNode[]): PMNode[] {
  const n = schema.nodes;
  const paragraph = (content?: Fragment) => n["paragraph"]!.create(null, content);
  switch (kind) {
    case "text":
      return [paragraph(head), ...rest];
    case "h1":
    case "h2":
    case "h3":
      return [n["heading"]!.create({ level: Number(kind[1]) }, head), ...rest];
    case "bullet":
      return [n["list"]!.create({ ordered: false, start: 1, tight: true }, n["listItem"]!.create(null, [paragraph(head), ...rest]))];
    case "numbered":
      return [n["list"]!.create({ ordered: true, start: 1, tight: true }, n["listItem"]!.create(null, [paragraph(head), ...rest]))];
    case "todo":
      return [n["taskList"]!.create({ ordered: false, start: 1, tight: true }, n["taskItem"]!.create({ checked: false }, [paragraph(head), ...rest]))];
    case "toggle":
      // Open by default (`+`): a new toggle should not hide what the user is about to type into it.
      return [n["callout"]!.create({ kind: "toggle", fold: "+" }, [titleOf(schema, head), ...(rest.length ? rest : [paragraph()])])];
    case "callout":
      return [n["callout"]!.create({ kind: "note", fold: "" }, [n["calloutTitle"]!.create(), paragraph(head), ...rest])];
    case "quote":
      return [n["blockquote"]!.create(null, [paragraph(head), ...rest])];
    case "code": {
      const text = plainOf(head);
      return [n["code"]!.create({ lang: null, meta: null }, text ? schema.text(text) : undefined), ...rest];
    }
    case "divider":
      // The text stays, after the rule; an empty paragraph gives the caret somewhere to go.
      return [n["thematicBreak"]!.create(), paragraph(head), ...rest];
  }
}

/** Puts the caret at the end of the first line of text in `nodes` (which start at `from`), or just inside the first node. */
function focusIn(tr: Transaction, from: number, nodes: readonly PMNode[], kind: BlockKind): void {
  let at = from;
  for (const node of nodes) {
    let found: number | null = node.isTextblock ? at + 1 + node.content.size : null;
    if (found === null) node.descendants((child, offset, parent) => {
      if (found !== null) return false;
      if (!child.isTextblock) return true;
      // A new callout holds its text in the body; the empty title is not where the caret belongs.
      if (kind === "callout" && parent?.type.name === "callout" && child.type.name === "calloutTitle") return false;
      found = at + 1 + offset + 1 + child.content.size;
      return false;
    });
    if (found !== null) {
      tr.setSelection(TextSelection.create(tr.doc, found));
      return;
    }
    at += node.nodeSize;
  }
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)), 1));
}

// ---------------------------------------------------------------------------
// Turn into

function setItemType(schema: Schema, item: PMNode, task: boolean): PMNode {
  if (!task) return schema.nodes["listItem"]!.create(null, item.content);
  const kids = childrenOf(item);
  const content = kids[0]?.type.name === "paragraph" ? kids : [schema.nodes["paragraph"]!.create(), ...kids];
  return schema.nodes["taskItem"]!.create({ checked: false }, content);
}

function turnItem(tr: Transaction, target: BlockTarget, kind: BlockKind): boolean {
  const schema = tr.doc.type.schema;
  const { node } = target;
  const $p = tr.doc.resolve(target.pos);
  const list = $p.parent;
  const listPos = $p.before();
  const index = $p.index();
  const kids = childrenOf(list);
  const ordered = list.attrs["ordered"] === true;
  const rebuild = (items: PMNode[], attrs: Record<string, unknown> = list.attrs) => list.type.create(attrs, items);

  if (kind === "todo" || kind === "bullet" || kind === "numbered") {
    const wantOrdered = kind === "numbered";
    const wantTask = kind === "todo";
    if (kindOfBlock(node, list) === kind) return false;
    if (kind === "todo" || ordered === wantOrdered) {
      // Same list family: a task list may hold plain items, so only the item and the list's node type change.
      const items = kids.map((k, i) => (i === index ? setItemType(schema, k, wantTask) : k));
      const type = items.some((k) => k.type.name === "taskItem") ? schema.nodes["taskList"]! : schema.nodes["list"]!;
      tr.replaceWith(listPos, listPos + list.nodeSize, type.create(list.attrs, items));
      tr.setSelection(Selection.near(tr.doc.resolve(target.pos + 1), 1));
      return true;
    }
    // Ordered to bullet or back for one item: the list splits around it.
    const own = setItemType(schema, node, false);
    const parts: PMNode[] = [];
    if (index > 0) parts.push(rebuild(kids.slice(0, index), clearSource(list.attrs)));
    parts.push(schema.nodes["list"]!.create({ ordered: wantOrdered, start: 1, tight: list.attrs["tight"] }, own));
    if (index < kids.length - 1) parts.push(rebuild(kids.slice(index + 1), clearSource({ ...list.attrs, start: ordered ? (list.attrs["start"] as number) + index + 1 : list.attrs["start"] })));
    tr.replaceWith(listPos, listPos + list.nodeSize, parts);
    const at = listPos + (index > 0 ? parts[0]!.nodeSize : 0);
    tr.setSelection(Selection.near(tr.doc.resolve(at + 2), 1));
    return true;
  }

  // Anything else lifts the item out of its list, which splits around it.
  const parts = partsOf(node, schema);
  if (!parts) return false;
  const blocks = build(schema, kind, parts.head, parts.rest);
  const out: PMNode[] = [];
  if (index > 0) out.push(rebuild(kids.slice(0, index), clearSource(list.attrs)));
  const firstAt = listPos + sizes(out);
  out.push(...blocks);
  if (index < kids.length - 1) out.push(rebuild(kids.slice(index + 1), clearSource({ ...list.attrs, start: ordered ? (list.attrs["start"] as number) + index + 1 : list.attrs["start"] })));
  tr.replaceWith(listPos, listPos + list.nodeSize, out);
  focusIn(tr, firstAt, blocks, kind);
  return true;
}

/** Converts the block to `kind`, keeping its text. False when nothing changes. */
export function turnInto(tr: Transaction, target: BlockTarget, kind: BlockKind): boolean {
  const { node } = target;
  if (!canTurnInto(target)) return false;
  if (isItem(node)) return turnItem(tr, target, kind);
  const schema = tr.doc.type.schema;
  const parent = tr.doc.resolve(target.pos).parent;
  if (kindOfBlock(node, parent) === kind) return false;
  if (node.type.name === "callout" && (kind === "toggle" || kind === "callout")) {
    // Same node, other look: toggles are callouts of kind `toggle`.
    const attrs = kind === "toggle" ? { kind: "toggle", fold: node.attrs["fold"] || "+" } : { kind: "note", fold: "" };
    tr.setNodeMarkup(target.pos, undefined, { ...node.attrs, ...attrs });
    return true;
  }
  const parts = partsOf(node, schema);
  if (!parts) return false;
  const blocks = build(schema, kind, parts.head, parts.rest);
  tr.replaceWith(target.pos, target.pos + node.nodeSize, blocks);
  focusIn(tr, target.pos, blocks, kind);
  return true;
}

/** Inserts a new empty block of `kind` at `at` (a position between blocks) and puts the caret in it. */
export function insertBlock(tr: Transaction, at: number, kind: BlockKind): void {
  const blocks = build(tr.doc.type.schema, kind, Fragment.empty, []);
  tr.insert(at, blocks);
  focusIn(tr, at, blocks, kind);
}

// ---------------------------------------------------------------------------
// Move, duplicate, delete

function reorder(tr: Transaction, target: BlockTarget, to: number): boolean {
  const $p = tr.doc.resolve(target.pos);
  const kids = childrenOf($p.parent);
  const index = $p.index();
  // A callout's first child is its title.
  const min = $p.parent.type.name === "callout" ? 1 : 0;
  if (to < min || to >= kids.length || to === index || index < min) return false;
  const selection = tr.selection;
  const next = kids.slice();
  next.splice(to, 0, next.splice(index, 1)[0]!);
  const lo = Math.min(index, to);
  const hi = Math.max(index, to);
  const start = $p.start();
  tr.replaceWith(start + sizes(kids.slice(0, lo)), start + sizes(kids.slice(0, hi + 1)), next.slice(lo, hi + 1));
  const moved = start + sizes(next.slice(0, to));
  const delta = moved - target.pos;
  const inside = selection.from >= target.pos && selection.to <= target.pos + target.node.nodeSize;
  if (!inside) tr.setSelection(Selection.near(tr.doc.resolve(moved + 1), 1));
  else if (selection instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, selection.from + delta));
  else tr.setSelection(TextSelection.create(tr.doc, selection.anchor + delta, selection.head + delta));
  return true;
}

/** Swaps the block with its previous or next sibling (within its list for a list item). */
export function moveBlock(tr: Transaction, target: BlockTarget, direction: "up" | "down"): boolean {
  const index = tr.doc.resolve(target.pos).index();
  return reorder(tr, target, direction === "up" ? index - 1 : index + 1);
}

/** Moves the block to `slot`: the gap before sibling number `slot` (siblings.length is the end). */
export function moveBlockToSlot(tr: Transaction, target: BlockTarget, slot: number): boolean {
  const index = tr.doc.resolve(target.pos).index();
  return reorder(tr, target, slot > index ? slot - 1 : slot);
}

/** Positions of the siblings of `target`, for drop targets: the node, its position, and its index. */
export function siblingsOf(doc: PMNode, target: BlockTarget): { pos: number; node: PMNode }[] {
  const $p = doc.resolve(target.pos);
  const out: { pos: number; node: PMNode }[] = [];
  let at = $p.start();
  $p.parent.forEach((node) => {
    out.push({ pos: at, node });
    at += node.nodeSize;
  });
  return out;
}

export function canMove(doc: PMNode, target: BlockTarget): { up: boolean; down: boolean } {
  const $p = doc.resolve(target.pos);
  const min = $p.parent.type.name === "callout" ? 1 : 0;
  return { up: $p.index() > min, down: $p.index() < $p.parent.childCount - 1 };
}

/**
 * Inserts a copy after the block and moves the caret into it. The copy keeps
 * the original's source attributes, so an untouched block is duplicated
 * byte-for-byte; once either is edited it is written canonically.
 */
export function duplicateBlock(tr: Transaction, target: BlockTarget): boolean {
  const at = target.pos + target.node.nodeSize;
  tr.insert(at, target.node);
  if (target.node.isAtom) tr.setSelection(NodeSelection.create(tr.doc, at));
  else tr.setSelection(Selection.near(tr.doc.resolve(at + 1), 1));
  return true;
}

/**
 * Inserts a new empty block of `kind` after `target` and puts the caret in it.
 * Another list item of the same family joins the list; anything else goes after
 * the nearest ancestor that accepts it.
 */
export function insertAfter(tr: Transaction, target: BlockTarget, kind: BlockKind): void {
  const schema = tr.doc.type.schema;
  let $p = tr.doc.resolve(target.pos + target.node.nodeSize);
  if (isItem(target.node)) {
    const list = tr.doc.resolve(target.pos).parent;
    const family = kind === "todo" ? "taskList" : kind === "numbered" ? "ordered" : kind === "bullet" ? "bullet" : null;
    const same = family === "taskList" ? list.type.name === "taskList" : family !== null && list.type.name === "list" && list.attrs["ordered"] === (family === "ordered");
    if (same) {
      const item = (kind === "todo" ? schema.nodes["taskItem"]!.create({ checked: false }, schema.nodes["paragraph"]!.create()) : schema.nodes["listItem"]!.create(null, schema.nodes["paragraph"]!.create()));
      tr.insert($p.pos, item);
      tr.setSelection(Selection.near(tr.doc.resolve($p.pos + 1), 1));
      return;
    }
  }
  const nodes = build(schema, kind, Fragment.empty, []);
  while ($p.depth > 0 && !$p.parent.canReplace($p.index(), $p.index(), Fragment.from(nodes))) $p = tr.doc.resolve($p.after());
  tr.insert($p.pos, nodes);
  focusIn(tr, $p.pos, nodes, kind);
}

/** Removes the block, and any container that would be left empty. The last block of a page becomes an empty paragraph. */
export function deleteBlock(tr: Transaction, target: BlockTarget): boolean {
  let $p = tr.doc.resolve(target.pos);
  if ($p.parent.type.name === "callout" && $p.parent.childCount === 2) {
    // A callout needs a body block after its title: keep an empty one.
    tr.replaceWith($p.pos, $p.pos + target.node.nodeSize, tr.doc.type.schema.nodes["paragraph"]!.create());
    tr.setSelection(TextSelection.create(tr.doc, $p.pos + 1));
    return true;
  }
  while ($p.depth > 0 && $p.parent.childCount === 1) $p = tr.doc.resolve($p.before());
  const node = $p.nodeAfter;
  if (!node) return false;
  if ($p.depth === 0 && tr.doc.childCount === 1) {
    tr.replaceWith(0, node.nodeSize, tr.doc.type.schema.nodes["paragraph"]!.create());
    tr.setSelection(Selection.near(tr.doc.resolve(1), 1));
    return true;
  }
  tr.delete($p.pos, $p.pos + node.nodeSize);
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min($p.pos, tr.doc.content.size)), -1));
  return true;
}
