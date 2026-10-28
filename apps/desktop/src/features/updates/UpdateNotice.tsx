import { useEffect, useId, useSyncExternalStore } from "react";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { InstallPanel, installTitle, useInstallAnnouncement } from "./InstallPanel.tsx";
import type { UpdateService } from "./service.ts";
import "./updates.css";

/** True for a place where typing happens: Esc there belongs to the editor or the field, not to the popup. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable || target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * The popup for a new desktop version (ADR-0022): a small dialog in the corner. It is not modal over typing: it never
 * takes the focus (a polite status line says it is there), the page behind it stays usable, and Esc or "Later" closes
 * it. "Download" and "What's new" open the browser through the host; "Skip this version" is remembered by the host.
 *
 * In-app updates (ADR-0034): where the host can update this copy, Update takes the place of Download, and the popup
 * then follows the update: progress with Cancel, "Restart now" or "Later", and each failure with the Download button.
 */
export function UpdateNotice() {
  const { updates } = useSession();
  return updates ? <Popup service={updates} /> : null;
}

function Popup({ service }: { service: UpdateService }) {
  const t = useDesktopStrings().updates;
  const state = useSyncExternalStore(service.subscribe, service.getState);
  const { offer, install } = state;
  const announcement = useInstallAnnouncement(install, offer?.version ?? state.latest?.version);
  const title = useId();
  const body = useId();
  const open = offer !== null;

  // Esc closes it when the focus is on the page or in the dialog, but not while the person types, and not when
  // something else (a menu, the list under the bell) has already used the key.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || typing(event.target)) return;
      service.later();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, service]);

  return (
    <>
      <span className="sr-only" role="status" data-testid="update-live">
        {announcement || (offer ? t.announce(offer.version) : "")}
      </span>
      {offer && install.phase !== "idle" && (
        <section role="dialog" aria-modal="false" aria-labelledby={title} aria-describedby={body} className="update-notice" data-testid="update-notice">
          <h2 id={title}>{installTitle(t, install, offer.version)}</h2>
          <InstallPanel
            service={service}
            state={state}
            messageId={body}
            extra={
              install.phase !== "restarting" && (
                <Button variant="quiet" small onClick={() => service.later()}>
                  {t.later}
                </Button>
              )
            }
          />
        </section>
      )}
      {offer && install.phase === "idle" && (
        <section role="dialog" aria-modal="false" aria-labelledby={title} aria-describedby={body} className="update-notice" data-testid="update-notice">
          <h2 id={title}>{t.popup(offer.version)}</h2>
          <p id={body} className="muted">
            {offer.inApp ? t.bodyInApp(offer.date) : t.body(offer.date)}
          </p>
          <div className="update-actions">
            {offer.inApp ? (
              <Button variant="primary" small onClick={() => void service.update()}>
                {t.update}
              </Button>
            ) : (
              <Button variant="primary" small onClick={() => void service.download()}>
                {t.download}
              </Button>
            )}
            {offer.notesUrl && (
              <Button variant="ghost" small onClick={() => void service.notes()}>
                {t.whatsNew}
              </Button>
            )}
            <Button variant="quiet" small onClick={() => service.later()}>
              {t.later}
            </Button>
            <Button variant="quiet" small onClick={() => void service.skip()}>
              {t.skip}
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
