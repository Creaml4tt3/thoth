/**
 * Styling the selection from code (the command palette), with the same edits as the toolbar and the shortcuts.
 */
import type { Editor } from "@tiptap/core";
import type { FormatCommand } from "../keyboard/editor-actions.ts";
import type { TextToolbarApi } from "./selection-toolbar.ts";
import { runEdit, setTextColor, toggleStyle, toolbarApplies } from "./text-styles.ts";

/** True when text is selected that the toolbar may style (not a caret, not a code block). */
export const canFormat = (editor: Editor): boolean => editor.isEditable && toolbarApplies(editor.state);

/** Applies `command` to the selection as one undo step. `link` opens the link field. False when nothing was done. */
export function formatSelection(editor: Editor, command: FormatCommand): boolean {
  if (!canFormat(editor)) return false;
  if (command === "link") {
    const toolbar = (editor.storage as unknown as { thothTextStyles?: { toolbar: TextToolbarApi | null } }).thothTextStyles?.toolbar;
    return toolbar?.openLink() ?? false;
  }
  if (typeof command === "object") return runEdit(editor.view, setTextColor(command.color));
  return runEdit(editor.view, toggleStyle(command));
}
