/**
 * The translucent sidebar (ADR-0053 amendment 2026-11-16). On macOS the window has the native Sidebar material
 * (tauri.macos.conf.json, and lib.rs for space-* windows); `data-os-effect` on <html> lets shell.css clear the page so
 * the material shows through the sidebar. The window's own appearance follows Thoth's theme, so a dark Thoth never sits
 * on light glass: "system" hands it back to the OS. Anywhere else (the browser, Windows, Linux) nothing changes.
 */
import type { ThemeStore } from "@thoth/app-ui/ui/theme.ts";

export interface GlassWindow {
  setTheme(theme: "light" | "dark" | null): Promise<void>;
}

export function startWindowGlass(isMacTauri: boolean, store: ThemeStore, window: () => Promise<GlassWindow>, root: HTMLElement = document.documentElement): () => void {
  if (!isMacTauri) return () => undefined;
  root.setAttribute("data-os-effect", "");
  const sync = () => {
    const theme = store.get();
    void window()
      .then((w) => w.setTheme(theme === "system" ? null : theme))
      .catch(() => undefined); // the page still reads right: shell.css keeps the sidebar 88–90% opaque
  };
  sync();
  return store.subscribe(sync);
}

/** True in Thoth's macOS app window, never in a browser. */
export const isMacTauri = (win: Window & { __TAURI_INTERNALS__?: unknown } = window): boolean =>
  win.__TAURI_INTERNALS__ !== undefined && /Mac OS X|Macintosh/.test(win.navigator.userAgent);
