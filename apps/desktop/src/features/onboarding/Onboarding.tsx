import { useEffect, useRef, useState } from "react";
import type { Platform } from "@thoth/platform";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { useDesktopStrings } from "../../strings/index.ts";
import { displayPath } from "../settings/path.ts";
import { tipIfClipped } from "@thoth/app-ui/ui/Tooltip.tsx";
import { useFolderPicker } from "./FolderNote.tsx";
import ibis from "./art/ibis.webp";

interface Props {
  platform: Platform;
  busy: boolean;
  error: string | null;
  /** The Private Space this window just closed: first in Recent, and focus starts on the main button. */
  left?: string | null;
  onOpen(root: string): void;
}

const leaf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * First screen: choose or create the folder that becomes a Private Space. It follows the computer's light or dark
 * setting, like thothnotes.com: the hooded ibis on a Moon stage beside the site's headline, then the two ways in as
 * cards (ADR-0051 rule 3: the same in-place picker behind both; the words say what each person is doing).
 */
export function Onboarding({ platform, busy, error, left = null, onOpen }: Props) {
  const t = useDesktopStrings().onboarding;
  const [recent, setRecent] = useState<string[]>([]);
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

  const picker = useFolderPicker(platform, onOpen);
  const shown = error ?? picker.error;
  const listed = left === null ? recent : [left, ...recent.filter((root) => root !== left)];

  return (
    <main className="onboarding onboarding-first">
      <div className="first-stage" aria-hidden="true">
        <div className="first-moon" />
        <img className="first-ibis" src={ibis} alt="" width={414} height={720} />
      </div>
      <div className="first-copy">
        <p className="first-brand">
          <Mark size={28} /> Thoth
        </p>
        <h1 className="first-title">
          <span>{t.headline[0]}</span> <span>{t.headline[1]}</span>
        </h1>
        <p className="first-lede">{t.lede}</p>
        {/* Each card's button holds only its title (its name) and covers the whole card; the line under it is its
            description. The same in-place picker behind both (ADR-0051 rule 3). */}
        <div className="first-choices">
          <div className="first-choice first-choice-main" data-busy={busy || undefined}>
            <button ref={choose} type="button" className="first-choice-title" onClick={() => void picker.pick()} disabled={busy} data-autofocus aria-describedby="first-new-note">
              {busy ? t.opening : t.startNew}
            </button>
            <span className="first-choice-note" id="first-new-note">
              {t.startNewNote}
            </span>
            <span className="first-choice-arrow" aria-hidden="true">→</span>
          </div>
          <div className="first-choice" data-busy={busy || undefined}>
            <button type="button" className="first-choice-title" onClick={() => void picker.pick()} disabled={busy} aria-describedby="first-open-note">
              {t.openExisting}
            </button>
            <span className="first-choice-note" id="first-open-note">
              {t.openExistingNote}
            </span>
            <span className="first-choice-arrow" aria-hidden="true">→</span>
          </div>
        </div>
        <ul className="first-promise">
          {t.promise.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {shown && (
          <p role="alert" className="alert alert-danger">
            {shown}
          </p>
        )}
        {listed.length > 0 && (
          <section aria-labelledby="recent-heading" className="recent">
            <h2 id="recent-heading" className="first-label">
              {t.recent}
            </h2>
            <ul>
              {listed.map((root) => (
                <li key={root}>
                  <button type="button" className="recent-item" disabled={busy} onClick={() => onOpen(root)} title={root} {...tipIfClipped(root)}>
                    <b>{leaf(root)}</b>
                    <span className="muted">{displayPath(root, 64)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {picker.dialog}
    </main>
  );
}
