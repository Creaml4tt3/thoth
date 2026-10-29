import { useEffect, useState, type ReactNode } from "react";
import type { FeedbackContext } from "@thoth/workspace-protocol";
import { FEEDBACK_EMAIL, FeedbackDialog, pickFeedbackServer, type FeedbackTarget } from "@thoth/app-ui/feedback/FeedbackDialog.tsx";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { currentOs } from "../settings/path.ts";

const OS_NAMES = { mac: "macOS", windows: "Windows", linux: "Linux" } as const;

/**
 * Send feedback from the desktop app (ADR-0033). It goes through the host (`api.call`) to the demo server once the
 * person has added it, else to the first signed-in server that lists `feedback`; a server that was never added is
 * never contacted. The details it may add: the client, the running version, the system and the interface language.
 */
export function DesktopFeedbackDialog({ onClose }: { onClose(): void }) {
  const { servers, options, platform } = useSession();
  const lang = useStrings().lang;
  const [version, setVersion] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    platform.updates
      ?.settings()
      .then((s) => live && setVersion(s.current))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [platform]);

  const context: FeedbackContext = { client: "desktop", ...(version ? { version } : {}), os: OS_NAMES[currentOs()], language: lang };
  const target = async (): Promise<FeedbackTarget | null> => {
    const entry = await pickFeedbackServer(servers.getState().servers, (id) => servers.capabilitiesOf(id), options.starterServer?.url ?? null);
    return entry ? { label: entry.info.label, send: (input) => servers.client(entry.info.id).sendFeedback(input) } : null;
  };
  // The webview cannot open mailto: links (the host's link.open takes web links only, ADR-0020): copy the address.
  return <FeedbackDialog target={target} context={context} mail="copy" onClose={onClose} />;
}

/** Settings → Help and feedback; `children`: the desktop's other help (the tour), after sending feedback. */
export function FeedbackSettings({ children }: { children?: ReactNode }) {
  const t = useDesktopStrings().helpFeedback;
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="set-feedback" className="set-section">
      <h2 id="set-feedback">{t.title}</h2>
      <p className="muted">{t.intro}</p>
      <div className="set-actions">
        <Button variant="primary" small onClick={() => setOpen(true)}>
          {t.send}
        </Button>
        <span className="muted">{t.email(FEEDBACK_EMAIL)}</span>
      </div>
      {children}
      {open && <DesktopFeedbackDialog onClose={() => setOpen(false)} />}
    </section>
  );
}
