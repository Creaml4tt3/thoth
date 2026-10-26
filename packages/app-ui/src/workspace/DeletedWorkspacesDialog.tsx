import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { DeletedWorkspace, Workspace } from "@thoth/workspace-protocol";
import { shellRoot } from "../order/ContextMenu.tsx";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";
import { ConfirmByNameForm } from "./ConfirmByNameDialog.tsx";
import type { ServerDirectory } from "./directory.ts";

interface Props {
  directory: ServerDirectory;
  server: string;
  serverLabel: string;
  /** A workspace was restored: it is back in the sidebar, opened there. */
  onRestored?(workspace: Workspace): void;
  onClose(): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * "Recently deleted" (ADR-0025): the deleted workspaces the user owns and can still restore, with when each was deleted
 * and until when it can come back. Restore brings it back into the sidebar; "Delete permanently…" asks for its name,
 * inline, and removes it for good. Changes are told in a live region; failures are alerts.
 */
export function DeletedWorkspacesDialog({ directory, server, serverLabel, onRestored, onClose }: Props) {
  const strings = useStrings();
  const t = strings.workspaces;
  const state = useSyncExternalStore(directory.subscribe, directory.getState, directory.getState);
  const items = state.deleted[server];
  const [loaded, setLoaded] = useState(items !== undefined);
  const [purging, setPurging] = useState<DeletedWorkspace | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const listId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const day = useMemo(() => new Intl.DateTimeFormat(strings.lang, { dateStyle: "medium" }), [strings.lang]);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  useEffect(() => {
    void directory.loadDeleted(server).finally(() => live.current && setLoaded(true));
  }, [directory, server]);

  const restore = async (ws: DeletedWorkspace) => {
    setError(null);
    setSaid("");
    setBusy(ws.id);
    try {
      const back = await directory.restoreWorkspace(server, ws.id);
      if (!live.current) return;
      setSaid(t.restored(ws.name));
      heading.current?.focus();
      onRestored?.(back);
    } catch (e) {
      if (live.current) setError(t.restoreFailed(message(e)));
    } finally {
      if (live.current) setBusy(null);
    }
  };

  const purge = async (ws: DeletedWorkspace): Promise<string | null> => {
    setSaid("");
    try {
      await directory.purgeWorkspace(server, ws.id);
      if (!live.current) return null;
      setPurging(null);
      setSaid(t.purged(ws.name));
      heading.current?.focus();
      return null;
    } catch (e) {
      return t.purgeFailed(message(e));
    }
  };

  return createPortal(
    <Modal title={t.recentlyDeletedOn(serverLabel)} onClose={onClose} wide>
      <p className="share-intro">{t.deletedIntro}</p>
      <section className="share-active" aria-labelledby={listId}>
        <h3 id={listId} ref={heading} tabIndex={-1} className="share-heading">
          {t.deletedTitle}
        </h3>
        {!loaded && items === undefined ? (
          <p className="share-note">{t.loadingDeleted}</p>
        ) : !items || items.length === 0 ? (
          <p className="share-note">{t.noneDeleted}</p>
        ) : (
          <ul className="members-list" aria-labelledby={listId}>
            {items.map((ws) => (
              <li key={ws.id} className="member ws-deleted">
                <span className="member-name">
                  <span>{ws.name}</span>
                  <span className="share-note member-hint">{t.deletedLine(day.format(new Date(ws.deletedAt)), day.format(new Date(ws.restorableUntil)))}</span>
                </span>
                <Button small variant="ghost" aria-label={t.restoreLabel(ws.name)} disabled={busy !== null || purging !== null} onClick={() => void restore(ws)}>
                  {t.restore}
                </Button>
                <Button small variant="quiet" data-purge={ws.id} aria-label={t.purgeLabel(ws.name)} disabled={busy !== null || purging !== null} onClick={() => setPurging(ws)}>
                  {t.purge}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {purging && (
          <div className="members-confirm" role="group" aria-label={t.purgeTitle(purging.name)}>
            <p className="members-confirm-title">{t.purgeTitle(purging.name)}</p>
            <ConfirmByNameForm body={t.purgeBody} name={purging.name} confirmLabel={t.purgeConfirm} busyLabel={t.deleting} onConfirm={() => purge(purging)} onCancel={() => {
                const id = purging.id;
                setPurging(null);
                // Back to the button that asked, once it is enabled again.
                setTimeout(() => document.querySelector<HTMLElement>(`[data-purge="${CSS.escape(id)}"]`)?.focus(), 0);
              }}
            />
          </div>
        )}
      </section>
      <p role="status" className="share-said">
        {said}
      </p>
      {error !== null && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button variant="quiet" onClick={onClose}>
          {t.done}
        </Button>
      </div>
    </Modal>,
    shellRoot(),
  );
}
