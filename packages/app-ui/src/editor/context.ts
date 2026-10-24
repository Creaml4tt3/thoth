import type { LinkLookup } from "./links.ts";
import type { LinkSuggester } from "./link-suggest.ts";
import { en, type EditorStrings } from "../strings/en.ts";

/** Something a node view can ask to re-render when the link index changes. */
export interface Refreshable {
  refresh(): void;
}

/** What node views need from the surrounding page; read lazily so it can change under a live editor. */
export interface EditorContext {
  lookup(): LinkLookup;
  /** Pages to offer after `[[`, ranked for the open page. */
  suggester(): LinkSuggester;
  openPage(path: string): void;
  views: Set<Refreshable>;
  /** Text for the editors' menus and node views (fixed for the editor's lifetime). */
  strings: EditorStrings;
  /** Which app the editor is in; the web client binds other style keys where a browser keeps the desktop's. */
  client: "desktop" | "web";
}

export function createEditorContext(init: { lookup(): LinkLookup; suggester(): LinkSuggester; openPage(path: string): void; strings?: EditorStrings; client?: "desktop" | "web" }): EditorContext {
  return { ...init, strings: init.strings ?? en.editor, client: init.client ?? "desktop", views: new Set() };
}
