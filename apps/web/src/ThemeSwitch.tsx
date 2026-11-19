import { createContext, useContext } from "react";
import { createThemeStore, storageKey, THEMES, useTheme, type Theme, type ThemeStore } from "@thoth/app-ui/ui/theme.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { Select } from "@thoth/app-ui/ui/Select.tsx";
import type { WebEnv } from "./env.ts";

/** The one localStorage key for the theme. It holds only the theme name ("light", "dark" or "system"), never sign-in data. */
export const THEME_KEY = "thoth.theme";

/** Reads the saved theme and puts it on the page. Called once, before the first render. */
export function webThemeStore(env: Pick<WebEnv, "localStorage">): ThemeStore {
  return createThemeStore(storageKey(env.localStorage, THEME_KEY));
}

/** Set by the app root. */
export const ThemeStoreContext = createContext<ThemeStore | null>(null);

export function ThemeSwitch() {
  const store = useContext(ThemeStoreContext);
  const names = useStrings().theme;
  if (!store) return null;
  return <ThemeSelect store={store} label={names.label} names={names} />;
}

function ThemeSelect({ store, label, names }: { store: ThemeStore; label: string; names: Record<Theme, string> }) {
  const { theme, setTheme } = useTheme(store);
  return (
    <div className="lang-switch">
      <Select<Theme> className="lang-select" value={theme} onChange={setTheme} aria-label={label} options={THEMES.map((choice) => ({ value: choice, label: names[choice] }))} />
    </div>
  );
}
