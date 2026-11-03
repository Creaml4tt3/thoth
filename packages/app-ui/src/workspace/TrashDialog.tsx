import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { roleCan, type Role, type TrashItem } from "@thoth/workspace-protocol";
import type { WorkspaceClient } from "@thoth/workspace-client";
import { shellRoot } from "../order/ContextMenu.tsx";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";

interface Props {
  client: Pick<WorkspaceClient, "listTrash" | "restoreTrashedPage" | "purgeTrashedPage">;
  workspace: { id: string; name: string; role: Role };
  /** Pages came back or went for good: read the tree again. */
  onChanged(): void;
  onClose(): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The Trash of a workspace (ADR-0043): deleted pages and folders kept for 30 days. Owners and managers see all of it,
 * restore anything and delete anything for good (asked first, inline); editors see and restore what they deleted.
 * Changes are told in a live region; failures are alerts.
 */
export function TrashDialog({ client, workspace, onChanged, onClose }: Props) {
  const strings = useStrings();
  const t = strings.trash;
  const manage = roleCan(workspace.role, "manage");
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [purging, setPurging] = useState<TrashItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const ids = { list: useId(), confirm: useId() };
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const day = useMemo(() => new Intl.DateTimeFormat(strings.lang, { dateStyle: "medium" }), [strings.lang]);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const reload = async () => {
    try {
      const next = await client.listTrash(workspace.id);
      if (live.current) setItems(next);
    } catch (e) {
      if (!live.current) return;
      setItems((prev) => prev ?? []);
      setError(t.loadFailed(message(e)));
    }
  };
  useEffect(() => void reload(), [client, workspace.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (purging) confirmButton.current?.focus();
  }, [purging]);

  const act = async (job: () => Promise<unknown>, done: string, failed: (detail: string) => string) => {
    setBusy(true);
    setError(null);
    setSaid("");
    try {
      await job();
      if (!live.current) return;
      setPurging(null);
      setSaid(done);
      heading.current?.focus();
      onChanged();
    } catch (e) {
      if (live.current) setError(failed(message(e)));
    } finally {
      if (live.current) setBusy(false);
      await reload();
    }
  };

  const title = (item: TrashItem) => item.title || strings.tabs.untitled;

  return createPortal(
    <Modal title={t.title(workspace.name)} onClose={onClose} wide>
      <p className="share-intro">{manage ? t.introManage : t.introEditor}</p>
      <section className="share-active" aria-labelledby={ids.list}>
        <h3 id={ids.list} ref={heading} tabIndex={-1} className="share-heading">
          {t.list}
        </h3>
        {items === null ? (
          <p className="share-note">{t.loading}</p>
        ) : items.length === 0 ? (
          <p className="share-note">{t.empty}</p>
        ) : (
          <ul className="members-list" aria-labelledby={ids.list}>
            {items.map((item) => (
              <li key={item.pageId} className="member ws-deleted">
                <span className="member-name">
                  <span>{title(item)}</span>
                  <span className="share-note member-hint">{t.line(item.kind === "folder", item.pagesBelow, item.deletedByName, day.format(new Date(item.deletedAt)), day.format(new Date(item.restorableUntil)))}</span>
                </span>
                <Button small variant="ghost" aria-label={t.restoreLabel(title(item))} disabled={busy || purging !== null} onClick={() => void act(() => client.restoreTrashedPage(workspace.id, item.pageId), t.restored(title(item)), t.restoreFailed)}>
                  {t.restore}
                </Button>
                {manage && (
                  <Button small variant="quiet" data-purge={item.pageId} aria-label={t.purgeLabel(title(item))} disabled={busy || purging !== null} onClick={() => setPurging(item)}>
                    {t.purge}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {purging && (
          <div className="members-confirm" role="group" aria-labelledby={ids.confirm}>
            <p id={ids.confirm} className="members-confirm-title">
              {t.purgeTitle(title(purging))}
            </p>
            <p className="share-note">{t.purgeBody(purging.pagesBelow)}</p>
            <div className="move-actions">
              <Button
                variant="quiet"
                small
                disabled={busy}
                onClick={() => {
                  const id = purging.pageId;
                  setPurging(null);
                  // Back to the button that asked, once it is enabled again.
                  setTimeout(() => document.querySelector<HTMLElement>(`[data-purge="${CSS.escape(id)}"]`)?.focus(), 0);
                }}
              >
                {t.cancel}
              </Button>
              <Button ref={confirmButton} variant="danger" small disabled={busy} onClick={() => void act(() => client.purgeTrashedPage(workspace.id, purging.pageId), t.purged(title(purging)), t.purgeFailed)}>
                {t.purgeConfirm}
              </Button>
            </div>
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
