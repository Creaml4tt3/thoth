/**
 * The desktop's theme preference (ADR-0016 rule 6). Like the language and the default editor mode it is an app
 * preference kept in the webview's localStorage. `main.tsx` imports the store before the first render, which
 * applies the theme to the page, so there is no flash of the wrong theme.
 */
import { createThemeStore, storageKey } from "@thoth/app-ui/ui/theme.ts";

export const THEME_KEY = "thoth.desktop.theme";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage can be disabled; the choice then lasts for the session
  }
}

export const desktopTheme = createThemeStore(storageKey(storage(), THEME_KEY));
