/**
 * Keys for list items (bulleted, numbered and to-do), as in Notion.
 *
 * - Enter splits the item: at the end it starts a new item at the same level,
 *   in the middle the text after the caret moves into the new item. A new
 *   to-do is always unchecked.
 * - Enter in an empty item leaves the list: the item becomes a paragraph (the
 *   list splits around it when it was not the last item).
 * - Backspace at the start of an item turns it into a paragraph, keeping its
 *   text, instead of joining it to the item above.
 *
 * Without these, the base keymap splits the paragraph inside the item, and a
 * second paragraph nests in the to-do instead of starting a new one.
 */
import { Extension } from "@tiptap/core";
import { TextSelection, type EditorState } from "@tiptap/pm/state";
import { applyAsOneStep, turnInto } from "./block-ops.ts";

const ITEMS = new Set(["listItem", "taskItem"]);

/** The caret's textblock when it sits directly in a list item: its depth and the item. */
function inItem(state: EditorState) {
  const { $from, $to } = state.selection;
  // A code block in an item keeps its own Enter (a new line in the code).
  if ($from.depth < 2 || !$from.sameParent($to) || !$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const item = $from.node(-1);
  return ITEMS.has(item.type.name) ? { $from, item } : null;
}

export function listKeysExtension() {
  return Extension.create({
    name: "thothListKeys",
    // Default priority, added before the `/` and `[[` menus: their Enter (pick an item) runs first.
    addKeyboardShortcuts() {
      const view = () => this.editor.view;
      return {
        Enter: () => {
          const at = inItem(this.editor.state);
          if (!at) return false;
          const { $from, item } = at;
          const empty = $from.parent.content.size === 0 && item.childCount === 1;
          if (!empty) return this.editor.commands.splitListItem(item.type.name, item.type.name === "taskItem" ? { checked: false } : {});
          // A nested list's last empty item moves out one level (Tiptap's split does that); otherwise it becomes text.
          if (this.editor.commands.splitListItem(item.type.name)) return true;
          const pos = $from.before(-1);
          return applyAsOneStep(view(), (tr) => turnInto(tr, { pos, node: item }, "text"));
        },
        Backspace: () => {
          const at = inItem(this.editor.state);
          if (!at || !this.editor.state.selection.empty) return false;
          // Right after `- ` or `[] ` made the item, Backspace gives back the typed text (the base keymap's rule).
          if (this.editor.commands.undoInputRule()) return true;
          const { $from, item } = at;
          if ($from.parentOffset !== 0 || $from.index(-1) !== 0) return false;
          const pos = $from.before(-1);
          return applyAsOneStep(view(), (tr) => {
            if (!turnInto(tr, { pos, node: item }, "text")) return false;
            // `turnInto` leaves the caret after the text; Backspace keeps it where it was, at the start.
            tr.setSelection(TextSelection.create(tr.doc, tr.selection.$from.start()));
            return true;
          });
        },
      };
    },
  });
}
