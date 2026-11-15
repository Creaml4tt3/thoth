/**
 * Stands in for `@thoth/app-ui/editor/mode.ts` in this build (vite.config.ts redirects the import): the real one reads the
 * default mode from localStorage, and the demo stores nothing. Same exports, kept in memory; "Start over" calls `resetModes`.
 */
export type EditorMode = "blocks" | "plain";

export const EDITOR_MODES: readonly { id: EditorMode; label: string; hint: string }[] = [
  { id: "blocks", label: "Blocks", hint: "Formatted blocks, like Notion" },
  { id: "plain", label: "Plain", hint: "Markdown text with live preview, like Obsidian" },
];

const perPage = new Map<string, EditorMode>();

export const defaultEditorMode = (): EditorMode => "blocks";
export const setDefaultEditorMode = (): void => undefined;
export const pageEditorMode = (root: string, path: string): EditorMode => perPage.get(`${root}\n${path}`) ?? "blocks";
export const rememberPageEditorMode = (root: string, path: string, mode: EditorMode): void => void perPage.set(`${root}\n${path}`, mode);
export const resetModes = (): void => perPage.clear();
