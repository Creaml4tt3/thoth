/**
 * What the command palette can ask of the open page's editor: switch Blocks and Plain, and style the selection.
 * The page frame registers these while a page is on screen (one at a time, because only the current tab is
 * mounted); with no page open `editorActions()` is null and the palette offers neither.
 */
import { useSyncExternalStore } from "react";
import type { TextColor } from "@thoth/editor";

export type StyleName = "bold" | "italic" | "underline" | "strike" | "inlineCode" | "highlight";

/** A text style for the selection: a mark, the link field, or a palette colour (null clears it). */
export type FormatCommand = StyleName | "link" | { color: TextColor | null };

export interface EditorActions {
  /** Blocks ↔ Plain. */
  toggleMode(): void;
  /** True in Blocks mode when text is selected and may be styled. */
  canFormat(): boolean;
  /** Applies a style to the selection. False when nothing changed. */
  format(command: FormatCommand): boolean;
}

let current: EditorActions | null = null;
const listeners = new Set<() => void>();

/** Called by the page frame. Returns the function that withdraws these actions (it leaves later ones alone). */
export function registerEditorActions(actions: EditorActions): () => void {
  current = actions;
  for (const listener of [...listeners]) listener();
  return () => {
    if (current !== actions) return;
    current = null;
    for (const listener of [...listeners]) listener();
  };
}

export const editorActions = (): EditorActions | null => current;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The open page's editor actions, or null; re-renders when a page opens or closes. */
export function useEditorActions(): EditorActions | null {
  return useSyncExternalStore(subscribe, editorActions, editorActions);
}
