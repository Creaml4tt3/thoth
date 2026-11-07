import { useEffect, useState } from "react";
import type { ConnectedApps } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { checkMemoryFolder } from "@thoth/local-store";
import { REPEAT_MS } from "@thoth/app-ui/notifications/core.ts";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { answerRequest } from "./answer.ts";
import { folderName } from "./names.ts";

/**
 * Connected apps in one window (ADR-0021): answers the requests the host sends this window, from its open Vault, and
 * asks Allow or Deny when an app connects for the first time, and "May propose changes" when an allowed app first
 * proposes one (ADR-0048). When an app first uses memory in this Private Space and its `Memory` folder holds pages of
 * the user's own, it asks which folder agents should use (ADR-0052 rule 1). Every window shows the question; the first
 * answer closes it everywhere (the host tells them). The bell says what agents saved without review.
 */
export function ConnectedAppsHost({ connectedApps }: { connectedApps: ConnectedApps }) {
  const { vault, connection, windowId, notifications, notificationPrefs } = useSession();
  const trash = connection.trash?.bind(connection);
  const [pending, setPending] = useState<string[]>([]);
  const [proposers, setProposers] = useState<string[]>([]);
  const [shared, setShared] = useState<string[]>([]);
  const [folders, setFolders] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void connectedApps
      .onRequest((request) => {
        // Every window hears every request: answer only the ones for this window and its Private Space.
        if (request.owner !== windowId || request.root !== connection.root) return;
        void answerRequest(vault, request, trash ? { trash } : {})
          .then((answer) => connectedApps.answer(request.id, answer))
          .catch(() => undefined);
      })
      .then((remove) => (live ? (stop = remove) : remove()));
    return () => {
      live = false;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `trash` is bound anew each render; the connection's root names it
  }, [connectedApps, vault, connection.root, windowId]);

  // ADR-0052 rule 5: "Claude Code saved 3 memories", one entry per app; its next memories within a minute join it.
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const runs = new Map<string, { saved: number; forgot: number; pages: string[]; at: number }>();
    void connectedApps
      .onMemories((written) => {
        if (written.root !== connection.root || !notificationPrefs.get().kinds.memories) return;
        const at = Date.now();
        const last = runs.get(written.app);
        const run = last && at - last.at <= REPEAT_MS ? last : { saved: 0, forgot: 0, pages: [], at };
        if (written.action === "forgot") run.forgot++;
        else run.saved++;
        run.pages = [written.title, ...run.pages.filter((p) => p !== written.title)];
        run.at = at;
        runs.set(written.app, run);
        notifications.push({ kind: "memories", app: written.app, saved: run.saved, forgot: run.forgot, pages: run.pages });
      })
      .then((remove) => (live ? (stop = remove) : remove()));
    return () => {
      live = false;
      stop?.();
    };
  }, [connectedApps, connection.root, notifications, notificationPrefs]);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const shown = (s: { pending: string[]; proposers?: string[]; spaces: string[]; folders?: string[] }) => {
      if (!live) return;
      setPending(s.pending);
      setProposers(s.proposers ?? []);
      setShared(s.spaces);
      setFolders(s.folders ?? []);
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
  if (proposer === undefined) {
    if (!folders.includes(connection.root)) return null;
    return (
      <FolderPrompt
        key={connection.root}
        space={folderName(connection.root)}
        onAnswer={(folder) => connectedApps.memoryFolder(connection.root, folder).then((s) => setFolders(s.folders ?? []))}
      />
    );
  }
  return (
    <ProposePrompt
      key={proposer}
      app={proposer}
      onAnswer={(allow) => void connectedApps.mayPropose(proposer, allow).then((s) => setProposers(s.proposers), () => setProposers((p) => p.filter((a) => a !== proposer)))}
    />
  );
}

/**
 * Asked once per Private Space, when an app first uses memory there and `Memory/` holds pages Thoth did not set up
 * (ADR-0052 rule 1). Focus starts on the other folder: agents change pages in their folder without asking.
 */
function FolderPrompt({ space, onAnswer }: { space: string; onAnswer: (folder: string) => Promise<unknown> }) {
  const t = useDesktopStrings().connectedApps.folderPrompt;
  const [folder, setFolder] = useState("Agent memory");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const answer = async (chosen: string) => {
    setFailure(null);
    let checked: string;
    try {
      checked = checkMemoryFolder(chosen);
    } catch (error) {
      setFailure(t.failed(error instanceof Error ? error.message : String(error)));
      return;
    }
    setBusy(true);
    try {
      await onAnswer(checked);
    } catch (error) {
      setFailure(t.failed(error instanceof Error ? error.message : String(error)));
      setBusy(false);
    }
  };
  return (
    <Modal title={t.title}>
      <form
        className="mcp-prompt"
        data-testid="mcp-folder-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          void answer(folder);
        }}
      >
        <p>{t.body(space)}</p>
        <label htmlFor="mcp-memory-folder">{t.other}</label>
        <input id="mcp-memory-folder" className="input" value={folder} disabled={busy} data-autofocus aria-describedby="mcp-memory-folder-hint" onChange={(e) => setFolder(e.target.value)} />
        <p id="mcp-memory-folder-hint" className="muted small">
          {t.otherHint}
        </p>
        {failure && (
          <p role="alert" className="alert alert-danger">
            {failure}
          </p>
        )}
        <p className="muted small">{t.later}</p>
        <div className="modal-actions">
          <Button type="button" variant="quiet" disabled={busy} onClick={() => void answer("Memory")}>
            {t.useMemory}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t.useOther}
          </Button>
        </div>
      </form>
    </Modal>
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
