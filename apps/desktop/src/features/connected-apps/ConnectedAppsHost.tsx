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
 * asks Allow or Deny when an app connects for the first time, and "May propose changes" when an allowed app first
 * proposes one (ADR-0048). Every window shows the question; the first answer closes it everywhere (the host tells them).
 */
export function ConnectedAppsHost({ connectedApps }: { connectedApps: ConnectedApps }) {
  const { vault, connection, windowId } = useSession();
  const [pending, setPending] = useState<string[]>([]);
  const [proposers, setProposers] = useState<string[]>([]);
  const [shared, setShared] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void connectedApps
      .onRequest((request) => {
        // Every window hears every request: answer only the ones for this window and its Private Space.
        if (request.owner !== windowId || request.root !== connection.root) return;
        void answerRequest(vault, request, connection.trash ? { trash: connection.trash.bind(connection) } : {})
          .then((answer) => connectedApps.answer(request.id, answer))
          .catch(() => undefined);
      })
      .then((remove) => (live ? (stop = remove) : remove()));
    return () => {
      live = false;
      stop?.();
    };
  }, [connectedApps, vault, connection, windowId]);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const shown = (s: { pending: string[]; proposers?: string[]; spaces: string[] }) => {
      if (!live) return;
      setPending(s.pending);
      setProposers(s.proposers ?? []);
      setShared(s.spaces);
    };
    // Who waits for which question is in the settings.
    const show = () => void connectedApps.settings().then(shown, () => undefined);
    void connectedApps.onPending(show).then((remove) => (live ? (stop = remove) : remove()));
    // An app may have asked before this window opened.
    show();
    return () => {
      live = false;
      stop?.();
    };
  }, [connectedApps]);

  const app = pending[0];
  if (app !== undefined) {
    return <AllowPrompt key={app} app={app} shared={shared} onAnswer={(allow) => void connectedApps.decide(app, allow).then((s) => setPending(s.pending), () => setPending((p) => p.filter((a) => a !== app)))} />;
  }
  const proposer = proposers[0];
  if (proposer === undefined) return null;
  return (
    <ProposePrompt
      key={proposer}
      app={proposer}
      onAnswer={(allow) => void connectedApps.mayPropose(proposer, allow).then((s) => setProposers(s.proposers), () => setProposers((p) => p.filter((a) => a !== proposer)))}
    />
  );
}

/** Asked once, when an allowed app first proposes a change (ADR-0048). Focus starts on "Don't allow". */
function ProposePrompt({ app, onAnswer }: { app: string; onAnswer: (allow: boolean) => void }) {
  const t = useDesktopStrings().connectedApps.proposePrompt;
  const caution = useDesktopStrings().connectedApps.prompt.caution;
  const [answered, setAnswered] = useState(false);
  const answer = (allow: boolean) => {
    setAnswered(true);
    onAnswer(allow);
  };
  return (
    <Modal title={t.title(app)}>
      <div className="mcp-prompt" data-testid="mcp-propose-prompt">
        <p>{t.body}</p>
        <p className="mcp-caution">{caution(app)}</p>
        <p className="muted small">{t.later}</p>
      </div>
      <div className="modal-actions">
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
