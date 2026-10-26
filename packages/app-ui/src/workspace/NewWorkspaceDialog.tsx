import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { newStableId } from "@thoth/domain";
import { QuotaExceeded } from "@thoth/workspace-client";
import { WORKSPACE_NAME_MAX, type Workspace } from "@thoth/workspace-protocol";
import { shellRoot } from "../order/ContextMenu.tsx";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";
import type { ServerDirectory } from "./directory.ts";

interface Props {
  directory: ServerDirectory;
  server: string;
  /** The server's name, for the title. */
  serverLabel: string;
  /** The workspace exists, is in the sidebar and opened there; the dialog has closed. */
  onCreated(workspace: Workspace): void;
  /** "Recently deleted…": the deleted workspaces that still count toward the limit. */
  onShowDeleted(): void;
  onClose(): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * "New workspace…" (ADR-0025): a name and the export-restriction choice. It says how many workspaces the user owns of
 * the server's limit (deleted ones count until they are deleted permanently) and, at the limit, why Create is off and
 * where to make room. One Idempotency-Key per dialog, so trying again after a lost answer never makes two workspaces.
 */
export function NewWorkspaceDialog({ directory, server, serverLabel, onCreated, onShowDeleted, onClose }: Props) {
  const strings = useStrings();
  const t = strings.workspaces;
  // Re-render when the workspaces or the deleted ones change: the counts below read them.
  useSyncExternalStore(directory.subscribe, directory.getState, directory.getState);
  const [name, setName] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newStableId());
  const ids = { usage: useId(), hint: useId() };
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  // The deleted workspaces count too: read them now, so the numbers are the server's.
  useEffect(() => {
    void directory.loadDeleted(server);
  }, [directory, server]);

  const { owned, deleted, limit } = directory.ownership(server);
  const full = limit !== undefined && owned >= limit;

  const submit = async () => {
    const next = name.trim();
    if (next === "") return setError(t.empty);
    setBusy(true);
    setError(null);
    try {
      const made = await directory.createWorkspace(server, { name: next, exportRestricted: restricted }, key.current);
      if (!live.current) return;
      onCreated(made);
    } catch (e) {
      if (!live.current) return;
      setBusy(false);
      if (e instanceof QuotaExceeded && e.quota === "workspaceCreationsPerDay") setError(t.tooManyToday);
      else if (e instanceof QuotaExceeded && e.quota === "workspacesPerAccount") {
        setError(t.atLimit(e.limit ?? limit ?? owned));
        void directory.loadDeleted(server);
      } else setError(t.createFailed(message(e)));
      // A refusal is an answer: the next attempt is a new request with its own key.
      key.current = newStableId();
    }
  };

  return createPortal(
    <Modal title={t.newOn(serverLabel)} onClose={onClose}>
      <p className="share-intro">{t.newIntro}</p>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>{t.name}</span>
          <input
            data-autofocus
            name="workspace-name"
            className="input"
            value={name}
            maxLength={WORKSPACE_NAME_MAX}
            disabled={busy}
            autoComplete="off"
            aria-describedby={limit !== undefined ? ids.usage : undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="ws-check">
          <input type="checkbox" name="export-restricted" checked={restricted} disabled={busy} aria-describedby={ids.hint} onChange={(event) => setRestricted(event.target.checked)} />
          <span>{t.restrict}</span>
        </label>
        <p id={ids.hint} className="share-note ws-check-hint">
          {t.restrictHint}
        </p>
        {limit !== undefined && (
          <div id={ids.usage} className="ws-usage" data-full={full || undefined}>
            <p className="share-note">{full ? t.atLimit(limit) : t.count(owned, limit)}</p>
            {deleted > 0 && <p className="share-note">{t.countDeleted(deleted)}</p>}
          </div>
        )}
        {deleted > 0 && (
          <div>
            <button type="button" className="sec-link" onClick={onShowDeleted}>
              {t.recentlyDeletedCount(deleted)}
            </button>
          </div>
        )}
        {error !== null && (
          <p role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        <div className="move-actions">
          <Button variant="quiet" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="primary" type="submit" disabled={busy || full}>
            {busy ? t.creating : t.create}
          </Button>
        </div>
      </form>
    </Modal>,
    shellRoot(),
  );
}
