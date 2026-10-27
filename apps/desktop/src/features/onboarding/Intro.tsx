import { useState } from "react";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { ImportWizard } from "../import/ImportWizard.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { seedWelcome } from "./welcome.ts";

/**
 * Shown once for an empty Private Space (Night): start writing, which writes the Welcome pages the first time
 * (ADR-0032) and hands back the page to open, or bring notes in first.
 */
export function Intro({ onContinue }: { onContinue(welcome?: string): void }) {
  const { connection, vault, openPage, openFolder } = useSession();
  const t = useDesktopStrings().onboarding;
  const lang = useStrings().lang;
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = () => {
    setBusy(true);
    // The pages are a help, not the user's data: if they cannot be written, the space opens as it is.
    void seedWelcome(vault, lang)
      .catch(() => null)
      .then((welcome) => onContinue(welcome ?? undefined));
  };

  if (importing) {
    return (
      <main className="onboarding onboarding-wizard" data-theme="night">
        <ImportWizard
          onClose={() => {
            setImporting(false);
            onContinue();
          }}
          onOpenFolder={(folder) => {
            setImporting(false);
            onContinue();
            openFolder(folder);
          }}
          onOpenPage={openPage}
        />
      </main>
    );
  }

  return (
    <main className="onboarding" data-theme="night">
      <div className="onboarding-inner">
        <h1 className="display onboarding-title">
          <Mark size={48} /> {t.ready}
        </h1>
        <p className="lede">
          <b>{connection.label}</b>
          {t.readyLede}
        </p>
        <div className="ctas">
          <Button variant="primary" onClick={start} disabled={busy} data-autofocus>
            {t.startWriting}
          </Button>
          <Button variant="ghost" onClick={() => setImporting(true)} disabled={busy}>
            {t.importFrom}
          </Button>
        </div>
      </div>
    </main>
  );
}
