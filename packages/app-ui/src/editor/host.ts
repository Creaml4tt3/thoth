/**
 * What an open page needs from the app around it. The desktop's vault session and the web client's session
 * both provide it, so `PageFrame` and `usePageSession` work in either.
 */
import { createContext, useContext } from "react";
import type { LinkPreviewService } from "./link-previews.ts";
import type { ImageFile } from "./media.ts";

export interface PageHost {
  /** Which app this is, for the keys the editor binds (the web client avoids keys a browser keeps). Default: the desktop app. */
  client?: "desktop" | "web";
  /** Idle time before an edited page is saved. 0 disables autosave. */
  autosaveMs: number;
  now: () => Date;
  /** The open page registers how to write its pending edits; returns the unregister function. */
  registerFlush(flush: () => Promise<boolean>): () => void;
  /** Link previews (ADR-0020): only the desktop app has them. Absent: links show as links, nothing is fetched. */
  links?: LinkPreviewService;
  /** Asks for an image file to add to a page (ADR-0028): the host's picker on the desktop, `<input type=file>` on the web. Null: cancelled. */
  pickImage?(): Promise<ImageFile | null>;
  /** Download as Markdown: saves `text` as `name`. The host's "Save as" on the desktop, the browser's download on the web. False: cancelled. */
  saveFile?(name: string, text: string): Promise<boolean>;
  /** Writes every pending edit of the pages open in this window; false when one could not be written. */
  flushAll?(): Promise<boolean>;
}

export const PageHostContext = createContext<PageHost | null>(null);

export function usePageHost(): PageHost {
  const host = useContext(PageHostContext);
  if (!host) throw new Error("usePageHost() outside a PageHostContext provider");
  return host;
}
