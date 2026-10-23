/**
 * Everything the web client takes from the browser, in one place, so tests can hand in a fake server, a fake
 * clock and fake storage. `browserEnv()` is the real thing.
 */
import type { ThothAnalytics } from "./analytics.ts";

export interface WebEnv {
  /** The server's origin, fixed at build time. */
  server: string;
  /** This page's origin and the client's base path (`/app/`). */
  origin: string;
  basePath: string;
  location: { pathname: string; search: string };
  /** Replaces the current history entry (removes the code and state from the address bar). */
  replaceUrl(path: string): void;
  /** Top-level navigation, for the sign-in redirect. */
  navigate(url: string): void;
  fetch: typeof fetch;
  /** For the sign-in round trip only (verifier and state); emptied on return. */
  sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** For preferences only (language, editor mode). Never a token. */
  localStorage: Pick<Storage, "getItem" | "setItem"> | null;
  languages: readonly string[];
  random(bytes: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Change-feed polling while the tab is visible; 0 disables it. */
  pollMs: number;
  /** Idle time before an edited page is saved. */
  autosaveMs: number;
  /** Where `track` looks for the site's analytics layer. */
  analyticsTarget: { thothAnalytics?: ThothAnalytics | undefined };
}

export function browserEnv(): WebEnv {
  const storage = (): Storage | null => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };
  return {
    server: import.meta.env.VITE_DEFAULT_SERVER as string,
    origin: window.location.origin,
    basePath: import.meta.env.BASE_URL,
    location: window.location,
    replaceUrl: (path) => window.history.replaceState(null, "", path),
    navigate: (url) => window.location.assign(url),
    fetch: window.fetch.bind(window),
    sessionStorage: window.sessionStorage,
    localStorage: storage(),
    languages: navigator.languages?.length ? navigator.languages : [navigator.language],
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    sha256: async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)),
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    pollMs: 5000,
    autosaveMs: 1000,
    analyticsTarget: window,
  };
}
