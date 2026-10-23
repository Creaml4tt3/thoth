import { useState } from "react";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { ImportWizard } from "../import/ImportWizard.tsx";
import { useSession } from "../../app/context.ts";

/** Shown once for an empty Private Space (Night): start writing, or bring notes in first. */
export function Intro({ onContinue }: { onContinue(): void }) {
  const { connection, openPage, openFolder } = useSession();
  const [importing, setImporting] = useState(false);

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
          <Mark size={48} /> Ready
        </h1>
        <p className="lede">
          <b>{connection.label}</b> is now a Private Space. Everything you write here is a Markdown file in that folder.
        </p>
        <div className="ctas">
          <Button variant="primary" onClick={onContinue} data-autofocus>
            Start writing
          </Button>
          <Button variant="ghost" onClick={() => setImporting(true)}>
            Import from Notion or Obsidian
          </Button>
        </div>
      </div>
    </main>
  );
}
