import { useState } from "react";
import type { Links } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { LINK_PREVIEW_MODES, linkPreviewMode, setLinkPreviewMode, type LinkPreviewMode } from "@thoth/app-ui/editor/link-previews.ts";
import { useDesktopStrings } from "../../strings/index.ts";

/**
 * Settings → Editor → Link previews (ADR-0020 rules 5 and 6): On, Only for links I paste, Off, and "Clear link
 * previews" (the host's cache in the app data folder). The choice is stored with the other editor preferences.
 */
export function LinkPreviewSettings({ links, onCleared }: { links: Links; onCleared?: () => Promise<void> }) {
  const t = useDesktopStrings().settings;
  const [mode, setMode] = useState<LinkPreviewMode>(linkPreviewMode);
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "failed">("idle");

  const clear = async () => {
    setStatus("busy");
    try {
      await (onCleared ? onCleared() : links.clearPreviews());
      setStatus("done");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <div className="link-preview-settings">
      <h3 id="set-link-previews">{t.linkPreviews}</h3>
      <p className="muted" id="set-link-previews-note">
        {t.linkPreviewsNote}
      </p>
      <div role="radiogroup" aria-labelledby="set-link-previews" aria-describedby="set-link-previews-note" className="link-preview-choices">
        {LINK_PREVIEW_MODES.map((m) => (
          <label key={m} className="link-preview-choice">
            <input
              type="radio"
              name="link-previews"
              value={m}
              aria-label={t.linkPreviewModes[m]}
              checked={mode === m}
              onChange={() => {
                setLinkPreviewMode(m);
                setMode(m);
              }}
            />
            <span aria-hidden="true">{t.linkPreviewModes[m]}</span>
          </label>
        ))}
      </div>
      <div className="set-actions">
        <Button variant="ghost" small disabled={status === "busy"} onClick={() => void clear()}>
          {t.clearLinkPreviews}
        </Button>
        <span role="status" className="muted">
          {status === "done" ? t.linkPreviewsCleared : ""}
        </span>
      </div>
      {status === "failed" && (
        <p role="alert" className="alert alert-danger">
          {t.linkPreviewsClearFailed}
        </p>
      )}
    </div>
  );
}
