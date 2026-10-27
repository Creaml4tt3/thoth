import { useEffect, useRef, useState } from "react";
import type { Platform } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { useDesktopStrings } from "../../strings/index.ts";
import { displayPath } from "../settings/path.ts";
import { tipIfClipped } from "@thoth/app-ui/ui/Tooltip.tsx";

interface Props {
  platform: Platform;
  busy: boolean;
  error: string | null;
  /** The Private Space this window just closed: first in Recent, and focus starts on the main button. */
  left?: string | null;
  onOpen(root: string): void;
}

const leaf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** First screen (Night): choose or create the folder that becomes a Private Space. */
export function Onboarding({ platform, busy, error, left = null, onOpen }: Props) {
  const t = useDesktopStrings().onboarding;
  const [recent, setRecent] = useState<string[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
  const choose = useRef<HTMLButtonElement>(null);
  // Back from a Private Space: focus was on a control that is gone.
  useEffect(() => {
    if (left !== null) choose.current?.focus();
  }, [left]);

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
  const listed = left === null ? recent : [left, ...recent.filter((root) => root !== left)];

  return (
    <main className="onboarding" data-theme="night">
      <div className="onboarding-inner">
        <h1 className="display onboarding-title">
          {t.meet.before} <Mark size={56} /> {t.meet.after}
        </h1>
        <p className="lede">{t.lede}</p>
        <div className="ctas">
          <Button ref={choose} variant="primary" onClick={() => void pick()} disabled={busy} data-autofocus>
            {busy ? t.opening : t.choose}
          </Button>
        </div>
        <p className="muted onboarding-hint">{t.hint}</p>
        {shown && (
          <p role="alert" className="alert alert-danger">
            {shown}
          </p>
        )}
        {listed.length > 0 && (
          <section aria-labelledby="recent-heading" className="recent">
            <h2 id="recent-heading" className="label">
              {t.recent}
            </h2>
            <ul>
              {listed.map((root) => (
                <li key={root}>
                  <button type="button" className="recent-item" disabled={busy} onClick={() => onOpen(root)} title={root} {...tipIfClipped(root)}>
                    <b>{leaf(root)}</b>
                    <span className="muted mono">{displayPath(root, 64)}</span>
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
