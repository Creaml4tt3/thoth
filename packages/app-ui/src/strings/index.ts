/**
 * UI text, one module per language (`en.ts`, `th.ts`). React views read it with `useStrings()`; the editors'
 * plain-DOM parts (menus, node views) get it through their `EditorContext`. With no provider the text is
 * English, which is what the desktop app uses.
 */
import { createContext, useContext } from "react";
import { en, type Lang, type Strings } from "./en.ts";
import { th } from "./th.ts";

export { en, th };
export type { EditorStrings, Lang, Strings } from "./en.ts";

export const STRINGS: Record<Lang, Strings> = { en, th };
export const LANGS: readonly Lang[] = ["en", "th"];

export const StringsContext = createContext<Strings>(en);

export function useStrings(): Strings {
  return useContext(StringsContext);
}

/** The first of the browser's preferred languages that we have; English otherwise. */
export function pickLang(preferred: readonly string[]): Lang {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0];
    if (base === "th" || base === "en") return base;
  }
  return "en";
}
