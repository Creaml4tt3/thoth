import { useContext } from "react";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { SettingsLayout } from "@thoth/app-ui/ui/SettingsLayout.tsx";
import { LanguageSwitch } from "./LanguageSwitch.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";

/** Settings, a tab of the web client: appearance, language and the account. */
export function SettingsView({ account, signOut, signingOut, showShortcuts }: { account: { displayName: string } | null; signOut(): void; signingOut: boolean; showShortcuts(): void }) {
  const t = useStrings();
  const s = t.web.settingsView;
  return (
    <SettingsLayout
      sections={[
        { id: "web-set-appearance", label: s.appearance },
        { id: "web-set-keyboard", label: s.keyboard },
        { id: "web-set-account", label: s.account },
      ]}
    >
      <h1 className="page-title">{s.title}</h1>

      <section aria-labelledby="web-set-appearance" className="set-section">
        <h2 id="web-set-appearance">{s.appearance}</h2>
        <div className="field">
          <span>{s.themeHint}</span>
          <ThemeSwitch />
        </div>
        <div className="field">
          <span>{s.languageHint}</span>
          <LanguageSwitch />
        </div>
      </section>

      <section aria-labelledby="web-set-keyboard" className="set-section">
        <h2 id="web-set-keyboard">{s.keyboard}</h2>
        <p className="muted">{s.keyboardNote}</p>
        <div className="set-actions">
          <Button variant="ghost" small onClick={showShortcuts}>
            {s.showShortcuts}
          </Button>
        </div>
      </section>

      <section aria-labelledby="web-set-account" className="set-section">
        <h2 id="web-set-account">{s.account}</h2>
        {account && <p className="muted">{t.web.signedInAs(account.displayName)}</p>}
        <div className="set-actions">
          <Button variant="ghost" small disabled={signingOut} onClick={signOut}>
            {signingOut ? t.web.signingOut : t.web.signOut}
          </Button>
        </div>
      </section>
    </SettingsLayout>
  );
}
