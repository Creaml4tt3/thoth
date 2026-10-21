import type { LinkLookup } from "./links.ts";

/** Something a node view can ask to re-render when the link index changes. */
export interface Refreshable {
  refresh(): void;
}

/** What node views need from the surrounding page; read lazily so it can change under a live editor. */
export interface EditorContext {
  lookup(): LinkLookup;
  openPage(path: string): void;
  views: Set<Refreshable>;
}

export function createEditorContext(init: { lookup(): LinkLookup; openPage(path: string): void }): EditorContext {
  return { ...init, views: new Set() };
}
