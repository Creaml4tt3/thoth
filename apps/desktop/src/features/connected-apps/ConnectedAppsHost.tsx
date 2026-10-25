import { useEffect, useState } from "react";
import type { ConnectedApps } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { answerRequest } from "./answer.ts";
import { folderName } from "./names.ts";

/**
 * Connected apps in one window (ADR-0021): answers the requests the host sends this window, from its open Vault, and
 * asks Allow or Deny when an app connects for the first time. Every window shows the question; the first answer
 * closes it everywhere (the host tells them).
 */
export function ConnectedAppsHost({ connectedApps }: { connectedApps: ConnectedApps }) {
  const { vault, connection, windowId } = useSession();
  const [pending, setPending] = useState<string[]>([]);
  const [shared, setShared] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void connectedApps
      .onRequest((request) => {
        // Every window hears every request: answer only the ones for this window and its Private Space.
        if (request.owner !== windowId || request.root !== connection.root) return;
        void answerRequest(vault, request)
          .then((answer) => connectedApps.answer(request.id, answer))
          .catch(() => undefined);
      })
      .then((remove) => (live ? (stop = remove) : remove()));
    return () => {
      live = false;
      stop?.();
    };
  }, [connectedApps, vault, connection.root, windowId]);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const show = (apps: string[]) => {
      if (!live) return;
      setPending(apps);
      if (apps.length > 0) void connectedApps.settings().then((s) => live && setShared(s.spaces), () => undefined);
    };
    void connectedApps.onPending(show).then((remove) => (live ? (stop = remove) : remove()));
    // An app may have asked before this window opened.
    void connectedApps.settings().then((s) => show(s.pending), () => undefined);
    return () => {
      live = false;
      stop?.();
    };
  }, [connectedApps]);

  const app = pending[0];
  if (app === undefined) return null;
  return <AllowPrompt key={app} app={app} shared={shared} onAnswer={(allow) => void connectedApps.decide(app, allow).then((s) => setPending(s.pending), () => setPending((p) => p.filter((a) => a !== app)))} />;
}

function AllowPrompt({ app, shared, onAnswer }: { app: string; shared: string[]; onAnswer: (allow: boolean) => void }) {
  const t = useDesktopStrings().connectedApps.prompt;
  const [answered, setAnswered] = useState(false);
  const answer = (allow: boolean) => {
    setAnswered(true);
    onAnswer(allow);
  };
  // No onClose: the question needs an answer (Escape does not count as Deny, so it is never given by accident).
  return (
    <Modal title={t.title(app)}>
      <div className="mcp-prompt" data-testid="mcp-prompt">
        <p>{shared.length > 0 ? t.body(shared.map(folderName).join(", ")) : t.nothingShared}</p>
        <p className="mcp-caution">{t.caution(app)}</p>
        <p className="muted small">{t.later}</p>
      </div>
      <div className="modal-actions">
        {/* Focus starts on Deny: a stray Enter never lets an app in. */}
        <Button variant="quiet" disabled={answered} data-autofocus onClick={() => answer(false)}>
          {t.deny}
        </Button>
        <Button variant="primary" disabled={answered} onClick={() => answer(true)}>
          {t.allow}
        </Button>
      </div>
    </Modal>
  );
}
