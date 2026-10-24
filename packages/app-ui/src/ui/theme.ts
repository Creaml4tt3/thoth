/**
 * Themes (ADR-0016 rule 6): Light, Dark and System. The tokens (`@thoth/ui/tokens.css`) key off `data-theme` on
 * the root element: "light" for light, "night" for dark, and "system" which follows
 * `prefers-color-scheme` in CSS, so System follows the OS live with no script.
 *
 * Storage is injected: the desktop keeps the choice with its other preferences, the web client in one
 * localStorage key that holds only the theme name. A command palette calls `cycleTheme` / `store.set`.
 */
import { useCallback, useSyncExternalStore } from "react";
import { motionOff } from "./presence.ts";

export type Theme = "light" | "dark" | "system";
export const THEMES: readonly Theme[] = ["light", "dark", "system"];
export const DEFAULT_THEME: Theme = "system";

export const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark" || value === "system";

/** The `data-theme` value for a theme. The tokens call dark "night". */
export const THEME_ATTRIBUTE: Record<Theme, string> = { light: "light", dark: "night", system: "system" };

/** Light → Dark → System → Light. */
export function cycleTheme(current: Theme): Theme {
  return THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]!;
}

/** Puts a theme on the page (the root element unless one is given). */
export function applyTheme(theme: Theme, root: Pick<Element, "setAttribute"> | undefined = globalThis.document?.documentElement): void {
  root?.setAttribute("data-theme", THEME_ATTRIBUTE[theme]);
}

/** The part of the View Transitions API used here. */
interface ViewTransitionApi {
  startViewTransition?(update: () => void): { ready: Promise<unknown>; finished: Promise<unknown> };
}

/**
 * Runs `apply` (which changes `data-theme`) inside a view transition where the browser has them, so the old page dissolves
 * into the new one (the duration and curve are in ui.css) instead of snapping. Colours are never transitioned element by
 * element: that would restart every colour transition on every frame (inherited colours animate under their children's own
 * transitions). Only a choice made while the app runs fades: the saved theme is applied before the first render. Where there is
 * no View Transitions API, or under reduced motion, or no layout (a test), `apply` just runs.
 */
function fadeThemeChange(apply: () => void): void {
  const doc = globalThis.document as (Document & ViewTransitionApi) | undefined;
  if (!doc || typeof doc.startViewTransition !== "function" || motionOff()) return apply();
  // A second choice made while the first is fading skips the first; that rejects its promises, which is fine.
  const transition = doc.startViewTransition(apply);
  transition.ready.catch(() => undefined);
  transition.finished.catch(() => undefined);
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
/** The part of `MediaQueryList` used here, so tests can hand in a fake. */
export interface Media {
  matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
}
export type MatchMedia = (query: string) => Media;

const systemMedia = (): MatchMedia | undefined => (typeof globalThis.matchMedia === "function" ? (globalThis.matchMedia.bind(globalThis) as MatchMedia) : undefined);

/** What a theme looks like right now: System resolves to the OS setting. */
export function resolveTheme(theme: Theme, matchMedia: MatchMedia | undefined = systemMedia()): "light" | "dark" {
  if (theme !== "system") return theme;
  return matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

/** Calls `onChange` when the OS switches between light and dark. Returns the unsubscribe. */
export function watchSystemTheme(onChange: (dark: boolean) => void, matchMedia: MatchMedia | undefined = systemMedia()): () => void {
  const query = matchMedia?.(DARK_QUERY);
  if (!query) return () => undefined;
  const listener = (event: { matches: boolean }) => onChange(event.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** Where a client keeps the choice. `read` returns the raw stored text, `write` stores it. */
export interface ThemeStorage {
  read(): string | null;
  write(value: string): void;
}

export interface ThemeStore {
  get(): Theme;
  set(theme: Theme): void;
  subscribe(listener: () => void): () => void;
}

/**
 * The current theme, remembered through `storage` and applied to `root` straight away (call it before the first
 * render so the page never shows the wrong theme). Unreadable or unknown stored text means System. A storage that
 * cannot write (private mode) keeps the choice for the session.
 */
export function createThemeStore(storage: ThemeStorage, root?: Pick<Element, "setAttribute">): ThemeStore {
  const read = (): Theme => {
    try {
      const stored = storage.read();
      return isTheme(stored) ? stored : DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  };
  let current = read();
  const listeners = new Set<() => void>();
  applyTheme(current, root);
  return {
    get: () => current,
    set(theme) {
      current = theme;
      if (root === undefined) fadeThemeChange(() => applyTheme(theme, root));
      else applyTheme(theme, root);
      try {
        storage.write(theme);
      } catch {
        // quota or privacy mode: the choice lasts for this session
      }
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** A storage over a `Storage`-like object under one key; a missing storage reads nothing and drops writes. */
export function storageKey(storage: Pick<Storage, "getItem" | "setItem"> | null | undefined, key: string): ThemeStorage {
  return {
    read: () => storage?.getItem(key) ?? null,
    write: (value) => storage?.setItem(key, value),
  };
}

/** The theme and a setter; re-renders on change. */
export function useTheme(store: ThemeStore): { theme: Theme; setTheme(theme: Theme): void; cycle(): void } {
  const theme = useSyncExternalStore(store.subscribe, store.get, store.get);
  const setTheme = useCallback((next: Theme) => store.set(next), [store]);
  const cycle = useCallback(() => store.set(cycleTheme(store.get())), [store]);
  return { theme, setTheme, cycle };
}

/** "light" or "dark" for the chosen theme, following the OS live while the theme is System. */
export function useResolvedTheme(theme: Theme, matchMedia: MatchMedia | undefined = systemMedia()): "light" | "dark" {
  const subscribe = useCallback((onChange: () => void) => (theme === "system" ? watchSystemTheme(onChange, matchMedia) : () => undefined), [theme, matchMedia]);
  const snapshot = () => resolveTheme(theme, matchMedia);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
