import { createContext, useContext } from "react";
import { LANGS, STRINGS, useStrings, type Lang } from "@thoth/app-ui/strings/index.ts";
import { Select } from "@thoth/app-ui/ui/Select.tsx";

/** Set by the app root: changes the UI language and remembers the choice. */
export const SetLangContext = createContext<(lang: Lang) => void>(() => undefined);

export function LanguageSwitch() {
  const t = useStrings();
  const setLang = useContext(SetLangContext);
  return (
    <div className="lang-switch">
      <Select<Lang> className="lang-select" value={t.lang} onChange={setLang} aria-label={t.web.language} options={LANGS.map((lang) => ({ value: lang, label: STRINGS[lang].name }))} />
    </div>
  );
}
