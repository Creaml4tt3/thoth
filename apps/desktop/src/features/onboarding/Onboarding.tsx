import { useEffect, useState } from "react";
import type { Platform } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";

interface Props {
  platform: Platform;
  busy: boolean;
  error: string | null;
  onOpen(root: string): void;
}

const leaf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** First screen (Night): choose or create the folder that becomes a Private Space. */
export function Onboarding({ platform, busy, error, onOpen }: Props) {
  const [recent, setRecent] = useState<string[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    platform
      .recentVaults()
      .then((list) => live && setRecent(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [platform]);

  const pick = async () => {
    setPickError(null);
    try {
      const root = await platform.pickVaultFolder();
      if (root) onOpen(root);
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    }
  };

  const shown = error ?? pickError;

  return (
    <main className="onboarding" data-theme="night">
      <div className="onboarding-inner">
        <h1 className="display onboarding-title">
          Meet <Mark size={56} /> Thoth
        </h1>
        <p className="lede">A private place for everything you know. Your files stay on your computer as Markdown, in a folder you choose. No account, no cloud.</p>
        <div className="ctas">
          <Button variant="primary" onClick={() => void pick()} disabled={busy} data-autofocus>
            {busy ? "Opening…" : "Choose or create a Private Space"}
          </Button>
        </div>
        <p className="muted onboarding-hint">Pick an existing folder of Markdown files, or create a new empty folder in the dialog. Thoth keeps its index in a hidden .thoth folder inside it, and the index can always be rebuilt from your files.</p>
        {shown && (
          <p role="alert" className="alert alert-danger">
            {shown}
          </p>
        )}
        {recent.length > 0 && (
          <section aria-labelledby="recent-heading" className="recent">
            <h2 id="recent-heading" className="label">
              Recent
            </h2>
            <ul>
              {recent.map((root) => (
                <li key={root}>
                  <button type="button" className="recent-item" disabled={busy} onClick={() => onOpen(root)}>
                    <b>{leaf(root)}</b>
                    <span className="muted mono">{root}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
