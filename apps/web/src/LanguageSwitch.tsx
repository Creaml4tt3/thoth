import { createContext, useContext } from "react";
import { LANGS, STRINGS, useStrings, type Lang } from "@thoth/app-ui/strings/index.ts";

/** Set by the app root: changes the UI language and remembers the choice. */
export const SetLangContext = createContext<(lang: Lang) => void>(() => undefined);

export function LanguageSwitch() {
  const t = useStrings();
  const setLang = useContext(SetLangContext);
  return (
    <label className="lang-switch">
      <span className="sr-only">{t.web.language}</span>
      <select className="input lang-select" value={t.lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t.web.language}>
        {LANGS.map((lang) => (
          <option key={lang} value={lang} lang={lang}>
            {STRINGS[lang].name}
          </option>
        ))}
      </select>
    </label>
  );
}
