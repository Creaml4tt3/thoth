/**
 * Keys for callout and toggle titles.
 *
 * - Enter in the title moves into the body (it never splits the title).
 * - Backspace at the start of a title turns the callout back into text, keeping
 *   the title text and the body.
 * - Backspace in the empty first block of the body goes back to the end of the
 *   title (and drops that empty block when the body has other blocks).
 * - Mod+Enter folds or unfolds the callout around the caret. Folding is
 *   view-only (see `calloutView`): it clicks the triangle, so it is the same code path.
 */
import { Extension } from "@tiptap/core";
import { Selection, TextSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { applyAsOneStep, turnInto } from "./block-ops.ts";

function inTitle(state: EditorState) {
  const { $from, empty } = state.selection;
  return empty && $from.parent.type.name === "calloutTitle" ? $from : null;
}

/** The empty first body block of a callout, when the caret is in it. */
function inEmptyFirstBody(state: EditorState) {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 2 || $from.parent.content.size !== 0 || $from.parent.type.name !== "paragraph") return null;
  const callout = $from.node($from.depth - 1);
  return callout.type.name === "callout" && $from.index($from.depth - 1) === 1 ? $from : null;
}

function foldCallout(view: EditorView): boolean {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d >= 1; d--) {
    if ($from.node(d).type.spec.code) return false;
    if ($from.node(d).type.name !== "callout") continue;
    const dom = view.nodeDOM($from.before(d));
    const button = dom instanceof HTMLElement ? dom.querySelector<HTMLButtonElement>(":scope > .callout-lead > .callout-fold") : null;
    if (!button || button.hidden) return false;
    button.click();
    return true;
  }
  return false;
}

export function calloutKeysExtension() {
  return Extension.create({
    name: "thothCalloutKeys",
    // Ahead of the default Enter and Backspace handling.
    priority: 1000,
    addKeyboardShortcuts() {
      const view = () => this.editor.view;
      return {
        Enter: () => {
          const $from = inTitle(this.editor.state);
          if (!$from) return false;
          const body = $from.after() + 1;
          const { state } = this.editor;
          view().dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(body), 1)).scrollIntoView());
          return true;
        },
        Backspace: () => {
          const { state } = this.editor;
          const title = inTitle(state);
          if (title && title.parentOffset === 0) {
            const at = title.before(title.depth - 1);
            return applyAsOneStep(view(), (tr) => turnInto(tr, { pos: at, node: tr.doc.nodeAt(at)! }, "text"));
          }
          const body = inEmptyFirstBody(state);
          if (!body) return false;
          const callout = body.node(body.depth - 1);
          const titleEnd = body.start(body.depth - 1) + callout.firstChild!.nodeSize - 1;
          return applyAsOneStep(view(), (tr) => {
            if (callout.childCount > 2) tr.delete(body.before(), body.after());
            tr.setSelection(TextSelection.create(tr.doc, titleEnd));
            return true;
          });
        },
        "Mod-Enter": () => foldCallout(view()),
      };
    },
  });
}
