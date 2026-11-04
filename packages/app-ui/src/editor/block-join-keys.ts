/**
 * Backspace and Delete across the edge of a list, quote or callout, and before a picture, divider or formula, as in
 * Notion and Google Docs.
 *
 * - Backspace at the start of a paragraph right after a list, quote or callout: an empty paragraph goes away and the
 *   caret goes to the end of the block's last line; a paragraph with text joins that line. (ProseMirror's default
 *   moves the paragraph inside the block instead: a new list item, or a new line in the quote.)
 * - Backspace at the start of a paragraph right after a picture, divider, formula or other single block: selects that
 *   block (an empty paragraph also goes away), so one key never deletes it unseen. A second Backspace deletes it.
 * - Delete at the end of a list's, quote's or callout's last line, with a paragraph after the block: the mirror; that
 *   paragraph's text joins the line, or the empty paragraph goes away.
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

const CONTAINERS = new Set(["list", "taskList", "blockquote", "callout"]);

/** The textblock the caret goes to at the end of `node` (which ends at `end`, its closing position); null when none. */
function lastLine(node: PMNode, end: number): { node: PMNode; end: number } | null {
  // A folded callout shows only its title: join there, not into a hidden line.
  if (node.type.name === "callout" && node.attrs["fold"] === "-" && node.firstChild) return { node: node.firstChild, end: end - node.nodeSize + node.firstChild.nodeSize };
  let n = node;
  let p = end - 1;
  while (!n.isTextblock) {
    const last = n.lastChild;
    if (!last) return null;
    n = last;
    p -= 1;
  }
  return { node: n, end: p };
}

/** Moves `line`'s text (between `from` and `to`, its content) to the end of `target`, or drops an empty `line`. */
function join(tr: Transaction, line: PMNode, lineFrom: number, lineTo: number, target: { node: PMNode; end: number }, caret: "target" | "keep"): boolean {
  const content = line.content;
  if (content.size > 0 && (target.node.type.spec.code || !target.node.canReplace(target.node.childCount, target.node.childCount, content))) return false;
  tr.delete(lineFrom, lineTo);
  const at = tr.mapping.map(target.end);
  if (content.size > 0) tr.insert(at, content);
  if (caret === "target") tr.setSelection(TextSelection.create(tr.doc, at));
  return true;
}

export function backspaceAfterBlock(state: EditorState): Transaction | null {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.parent.type.name !== "paragraph" || $from.depth < 1) return null;
  const index = $from.index(-1);
  if (index === 0) return null;
  const prev = $from.node(-1).child(index - 1);
  const line = $from.parent;
  const before = $from.before();
  const tr = state.tr;
  if (CONTAINERS.has(prev.type.name)) {
    const target = lastLine(prev, before);
    if (!target || !join(tr, line, before, $from.after(), target, "target")) return null;
    return tr.scrollIntoView();
  }
  if (prev.isAtom && NodeSelection.isSelectable(prev)) {
    if (line.content.size === 0) tr.delete(before, $from.after());
    return tr.setSelection(NodeSelection.create(tr.doc, before - prev.nodeSize)).scrollIntoView();
  }
  return null;
}

export function deleteBeforeParagraph(state: EditorState): Transaction | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code || $from.parentOffset !== $from.parent.content.size) return null;
  // The outermost list, quote or callout whose very end the caret is at.
  let d = 0;
  for (let k = $from.depth - 1; k >= 1; k--) {
    if ($from.index(k) !== $from.node(k).childCount - 1) break;
    if (CONTAINERS.has($from.node(k).type.name)) d = k;
  }
  if (d === 0) return null;
  const next = $from.node(d - 1).maybeChild($from.index(d - 1) + 1);
  if (next?.type.name !== "paragraph") return null;
  const from = $from.after(d);
  const tr = state.tr;
  if (!join(tr, next, from, from + next.nodeSize, { node: $from.parent, end: $from.pos }, "keep")) return null;
  return tr.setSelection(TextSelection.create(tr.doc, $from.pos)).scrollIntoView();
}

export function blockJoinKeysExtension() {
  return Extension.create({
    name: "thothBlockJoinKeys",
    addKeyboardShortcuts() {
      const run = (make: (state: EditorState) => Transaction | null) => () => {
        const tr = make(this.editor.state);
        if (!tr) return false;
        this.editor.view.dispatch(tr);
        return true;
      };
      return { Backspace: run(backspaceAfterBlock), Delete: run(deleteBeforeParagraph) };
    },
  });
}
