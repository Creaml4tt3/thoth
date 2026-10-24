/**
 * The desktop app's UI language. By default it follows the system (the webview's `navigator.languages`): Thai for
 * `th*`, English otherwise. Settings → Language can pin English or Thai; the choice is an app preference kept in
 * the webview's localStorage, like the default editor mode.
 *
 * The shared editor and workspace views read `@thoth/app-ui/strings` through its `StringsContext`; the desktop's
 * own views read `useDesktopStrings()`. The app root provides both for the chosen language.
 */
import { createContext, useContext } from "react";
import { pickLang, type Lang } from "@thoth/app-ui/strings/index.ts";
import { en, type DesktopStrings } from "./en.ts";
import { th } from "./th.ts";

export { en, th };
export type { DesktopStrings, Os } from "./en.ts";

export const DESKTOP_STRINGS: Record<Lang, DesktopStrings> = { en, th };

/** "system" follows the OS language; the others pin one. */
export type LangPreference = "system" | Lang;
export const LANG_PREFERENCES: readonly LangPreference[] = ["system", "en", "th"];

const KEY = "thoth.desktop.lang";
const isPreference = (value: unknown): value is LangPreference => value === "system" || value === "en" || value === "th";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage can be disabled; the choice then lasts for the session
  }
}

let fallback: LangPreference = "system";

export function langPreference(): LangPreference {
  const stored = storage()?.getItem(KEY);
  return isPreference(stored) ? stored : fallback;
}

export function setLangPreference(preference: LangPreference): void {
  fallback = preference;
  try {
    storage()?.setItem(KEY, preference);
  } catch {
    // quota or privacy mode: keep the in-memory value
  }
}

/** The system's languages, most preferred first (the webview reports the OS setting). */
export function systemLanguages(nav: Pick<Navigator, "languages" | "language"> | undefined = globalThis.navigator): readonly string[] {
  if (!nav) return [];
  return nav.languages?.length ? nav.languages : nav.language ? [nav.language] : [];
}

export function resolveLang(preference: LangPreference, system: readonly string[]): Lang {
  return preference === "system" ? pickLang(system) : preference;
}

export const DesktopStringsContext = createContext<DesktopStrings>(en);

export function useDesktopStrings(): DesktopStrings {
  return useContext(DesktopStringsContext);
}

/** Set by the app root: the current preference and a way to change it (Settings → Language). */
export const LangPreferenceContext = createContext<{ preference: LangPreference; setPreference(preference: LangPreference): void }>({
  preference: "system",
  setPreference: () => undefined,
});
