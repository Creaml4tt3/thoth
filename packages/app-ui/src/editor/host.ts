/**
 * What an open page needs from the app around it. The desktop's vault session and the web client's session
 * both provide it, so `PageFrame` and `usePageSession` work in either.
 */
import { createContext, useContext } from "react";

export interface PageHost {
  /** Idle time before an edited page is saved. 0 disables autosave. */
  autosaveMs: number;
  now: () => Date;
  /** The open page registers how to write its pending edits; returns the unregister function. */
  registerFlush(flush: () => Promise<boolean>): () => void;
}

export const PageHostContext = createContext<PageHost | null>(null);

export function usePageHost(): PageHost {
  const host = useContext(PageHostContext);
  if (!host) throw new Error("usePageHost() outside a PageHostContext provider");
  return host;
}
