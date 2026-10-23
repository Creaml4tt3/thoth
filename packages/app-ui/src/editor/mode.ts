/**
 * Editor mode (ADR-0012): Blocks (Tiptap, Notion-like) or Plain (CodeMirror,
 * Obsidian-like live preview). Both edit the same Markdown file through the
 * same `PageSession`, so the mode is a view preference and never stored in
 * the file.
 *
 * - The default mode is an app preference, kept in the webview's localStorage.
 * - A page switched with the toggle keeps that mode until the app restarts.
 */
export type EditorMode = "blocks" | "plain";

export const EDITOR_MODES: readonly { id: EditorMode; label: string; hint: string }[] = [
  { id: "blocks", label: "Blocks", hint: "Formatted blocks, like Notion" },
  { id: "plain", label: "Plain", hint: "Markdown text with live preview, like Obsidian" },
];

const KEY = "thoth.editor.defaultMode";
const perPage = new Map<string, EditorMode>();

const isMode = (value: unknown): value is EditorMode => value === "blocks" || value === "plain";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage can be disabled; the default then lasts for the session
  }
}

let fallback: EditorMode = "blocks";

export function defaultEditorMode(): EditorMode {
  const stored = storage()?.getItem(KEY);
  return isMode(stored) ? stored : fallback;
}

export function setDefaultEditorMode(mode: EditorMode): void {
  fallback = mode;
  try {
    storage()?.setItem(KEY, mode);
  } catch {
    // quota or privacy mode: keep the in-memory value
  }
}

const pageKey = (root: string, path: string) => `${root}\n${path}`;

export function pageEditorMode(root: string, path: string): EditorMode {
  return perPage.get(pageKey(root, path)) ?? defaultEditorMode();
}

export function rememberPageEditorMode(root: string, path: string, mode: EditorMode): void {
  perPage.set(pageKey(root, path), mode);
}
