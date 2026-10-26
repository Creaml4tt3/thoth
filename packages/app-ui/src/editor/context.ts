import type { LinkLookup } from "./links.ts";
import type { LinkSuggester } from "./link-suggest.ts";
import type { PageLinks } from "./link-previews.ts";
import type { ImageFile, PageMedia } from "./media.ts";
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
  /** Link previews for this page (ADR-0020); absent where the app has none (the web client): links stay links. */
  links?: PageLinks;
  /** The page's images (ADR-0028): their bytes come from the page's space. Null: no image is loaded (each shows its placeholder). */
  media(): PageMedia | null;
  /** Asks the person for an image file (the host's picker, or the browser's). Absent: no `/` Image item. */
  pickImage?(): Promise<ImageFile | null>;
  /** Opens a web address in the browser. Absent: a link opens the browser's own way (the web client). */
  openExternal?(url: string): void;
}

export function createEditorContext(init: {
  lookup(): LinkLookup;
  suggester(): LinkSuggester;
  openPage(path: string): void;
  strings?: EditorStrings;
  client?: "desktop" | "web";
  links?: PageLinks;
  media?(): PageMedia | null;
  pickImage?(): Promise<ImageFile | null>;
  openExternal?(url: string): void;
}): EditorContext {
  return { media: () => null, ...init, strings: init.strings ?? en.editor, client: init.client ?? "desktop", views: new Set() };
}
