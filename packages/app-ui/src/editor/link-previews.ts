/**
 * Link previews in the editor (ADR-0020 rules 2, 5 and 6): which links get a card, when a preview is fetched, and
 * what the person chose. No DOM and no ProseMirror here; `link-cards.ts` draws the cards.
 *
 * - Settings → Editor → "Link previews": On (default), Only for links I paste, Off. Off: plain links, no fetch.
 * - When a preview is fetched (a fetch tells the site you looked): a link pasted on a page, at once; links already in
 *   a Private Space page, when the page is shown (with On); everything else (links in workspace pages, written by
 *   others, and with "Only for links I paste" the links that were already there) waits for "Load preview".
 * - "Show as link" hides one link's card on one page, remembered in the app's own storage, not in the vault.
 * - The previews themselves are cached by the host (app data folder); this keeps the session's answers in memory.
 */
import type { LinkPreview, Links } from "@thoth/platform";

export type LinkPreviewMode = "on" | "paste" | "off";
export const LINK_PREVIEW_MODES: readonly LinkPreviewMode[] = ["on", "paste", "off"];

const MODE_KEY = "thoth.editor.linkPreviews";
const HIDDEN_KEY = "thoth.editor.linkCardsHidden";
/** At most this many pages remember hidden cards, and this many links each. */
const MAX_HIDDEN_PAGES = 200;
const MAX_HIDDEN_PER_PAGE = 100;
/** Previews fetched at once by one window. */
const PARALLEL = 3;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let memoryMode: LinkPreviewMode = "on";
const modeListeners = new Set<() => void>();

export function linkPreviewMode(): LinkPreviewMode {
  try {
    const stored = storage()?.getItem(MODE_KEY);
    if (stored === "on" || stored === "paste" || stored === "off") return stored;
  } catch {
    // fall through
  }
  return memoryMode;
}

export function setLinkPreviewMode(mode: LinkPreviewMode): void {
  memoryMode = mode;
  try {
    storage()?.setItem(MODE_KEY, mode);
  } catch {
    // memory only
  }
  for (const listener of [...modeListeners]) listener();
}

export function onLinkPreviewModeChange(listener: () => void): () => void {
  modeListeners.add(listener);
  return () => void modeListeners.delete(listener);
}

/** Pages' hidden cards: `{ "<space>\n<page>": [href, …] }`, most recently changed last. */
function readHidden(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(HIDDEN_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [page, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(list)) out[page] = list.filter((h): h is string => typeof h === "string").slice(-MAX_HIDDEN_PER_PAGE);
    }
    return out;
  } catch {
    return {};
  }
}

function writeHidden(all: Record<string, string[]>): void {
  const pages = Object.keys(all);
  for (const page of pages.slice(0, Math.max(0, pages.length - MAX_HIDDEN_PAGES))) delete all[page];
  try {
    storage()?.setItem(HIDDEN_KEY, JSON.stringify(all));
  } catch {
    // memory only for this session
  }
}

export type CardState =
  /** Not fetched (yet). */
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; preview: LinkPreview }
  /** Nothing to show: the fetch failed, or the page gave no title or description. Shown as a plain link. */
  | { kind: "none" };

/** What one open page's editor uses. */
export interface PageLinks {
  /** Whether `href` may have a card on this page at all (Off and "Show as link" say no). */
  shows(href: string): boolean;
  /** Whether its preview is fetched without asking. */
  auto(href: string): boolean;
  state(href: string): CardState;
  /** Fetches the preview (once per session per link; the host caches across sessions). */
  load(href: string): void;
  /** The editor pasted these links on this page: they are fetched at once (unless Off). */
  pasted(hrefs: string[]): void;
  /** "Show as link": no card for `href` on this page, from now on. */
  hide(href: string): void;
  open(href: string): void;
  /** Called (asynchronously) whenever something above changes for this page. */
  subscribe(listener: () => void): () => void;
}

export interface LinkPreviewService {
  forPage(page: { space: "private" | "workspace"; key: string }): PageLinks;
  /** Settings → "Clear link previews": the host's cache and this session's answers. */
  clear(): Promise<void>;
}

/** Only these image data URLs are shown (the host checks the bytes too). */
export function isPreviewImage(src: string | undefined): src is string {
  return typeof src === "string" && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(src);
}

export function createLinkPreviewService(links: Links): LinkPreviewService {
  const results = new Map<string, CardState>();
  const pastedOn = new Map<string, Set<string>>();
  const listeners = new Set<() => void>();
  const queue: string[] = [];
  let running = 0;
  let scheduled = false;

  const changed = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const listener of [...listeners]) listener();
    });
  };
  onLinkPreviewModeChange(changed);

  const pump = () => {
    while (running < PARALLEL && queue.length > 0) {
      const href = queue.shift()!;
      running++;
      links
        .preview(href)
        .then((preview) => {
          results.set(href, preview.title || preview.description ? { kind: "ready", preview } : { kind: "none" });
        })
        .catch(() => {
          results.set(href, { kind: "none" });
        })
        .finally(() => {
          running--;
          changed();
          pump();
        });
    }
  };

  const load = (href: string) => {
    const state = results.get(href);
    if (state && state.kind !== "idle") return;
    results.set(href, { kind: "loading" });
    queue.push(href);
    changed();
    pump();
  };

  return {
    forPage({ space, key }) {
      const pasted = () => pastedOn.get(key) ?? new Set<string>();
      return {
        shows: (href) => linkPreviewMode() !== "off" && !(readHidden()[key] ?? []).includes(href),
        auto(href) {
          const mode = linkPreviewMode();
          if (mode === "off") return false;
          if (pasted().has(href)) return true;
          return space === "private" && mode === "on";
        },
        state: (href) => results.get(href) ?? { kind: "idle" },
        load,
        pasted(hrefs) {
          const set = pastedOn.get(key) ?? new Set<string>();
          for (const href of hrefs) if (/^https?:/i.test(href)) set.add(href);
          pastedOn.set(key, set);
          changed();
        },
        hide(href) {
          const all = readHidden();
          const list = (all[key] ?? []).filter((h) => h !== href);
          delete all[key];
          all[key] = [...list, href].slice(-MAX_HIDDEN_PER_PAGE);
          writeHidden(all);
          changed();
        },
        open: (href) => void links.open(href).catch(() => undefined),
        subscribe(listener) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      };
    },
    async clear() {
      await links.clearPreviews();
      results.clear();
      changed();
    },
  };
}
