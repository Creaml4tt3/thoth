import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import type { PageVisibility, Team } from "@thoth/workspace-protocol";
import type { WorkspaceClient } from "@thoth/workspace-client";
import { shellRoot } from "../order/ContextMenu.tsx";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";

interface Props {
  client: Pick<WorkspaceClient, "listTeams" | "getPageVisibility" | "setPageVisibility">;
  workspace: string;
  page: string;
  name: string;
  /** After a change: the tree is read again (who sees what changed). */
  onSaved(said: string): void;
  onClose(): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * "Visible to…" of a folder or page (ADR-0042), for owners and managers: everyone, or only some teams. The choice
 * applies to everything inside it.
 */
export function VisibilityDialog({ client, workspace, page, name, onSaved, onClose }: Props) {
  const t = useStrings().tree.visibility;
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [current, setCurrent] = useState<PageVisibility | null>(null);
  const [limited, setLimited] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const legend = useId();
  const errorId = useId();
  /** "Choose at least one team" is about the team boxes: they carry it (WCAG 3.3.1), as a field carries its error. */
  const noneChosen = error === t.pickOne;

  useEffect(() => {
    let live = true;
    Promise.all([client.listTeams(workspace), client.getPageVisibility(workspace, page)]).then(
      ([all, vis]) => {
        if (!live) return;
        setTeams(all);
        setCurrent(vis);
        setLimited(vis.teamIds !== null);
        setPicked(new Set(vis.teamIds ?? []));
      },
      (e: unknown) => live && setError(t.failed(message(e))),
    );
    return () => {
      live = false;
    };
  }, [client, workspace, page, t]);

  const save = async () => {
    if (limited && picked.size === 0) return setError(t.pickOne);
    setBusy(true);
    setError(null);
    try {
      await client.setPageVisibility(workspace, page, limited ? [...picked] : null);
      onSaved(t.saved(name));
      onClose();
    } catch (e) {
      setError(t.failed(message(e)));
      setBusy(false);
    }
  };

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
    if (noneChosen && next.size > 0) setError(null);
  };

  return createPortal(
    <Modal title={t.title(name)} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="share-intro">{t.intro}</p>
        {teams === null || current === null ? (
          error === null && <p className="share-note">{t.loading}</p>
        ) : (
          <fieldset className="share-expiry" aria-labelledby={legend}>
            <legend id={legend} className="sr-only">
              {t.title(name)}
            </legend>
            <label className="share-choice">
              <input type="radio" name="visibility" checked={!limited} disabled={busy} onChange={() => setLimited(false)} data-autofocus={!limited ? "" : undefined} />
              <span>{t.everyone}</span>
            </label>
            <label className="share-choice">
              <input type="radio" name="visibility" checked={limited} disabled={busy || teams.length === 0} onChange={() => setLimited(true)} data-autofocus={limited ? "" : undefined} />
              <span>{t.teams}</span>
            </label>
            {teams.length === 0 ? (
              <p className="share-note">{t.noTeams}</p>
            ) : (
              <div className="share-choices">
                {teams.map((team) => (
                  <label key={team.id} className="share-choice">
                    <input type="checkbox" aria-invalid={noneChosen || undefined} aria-describedby={noneChosen ? errorId : undefined} checked={picked.has(team.id)} disabled={busy || !limited} onChange={(event) => toggle(team.id, event.target.checked)} />
                    <span>{team.name}</span>
                  </label>
                ))}
              </div>
            )}
            {current.limitedAbove && <p className="share-note">{t.above}</p>}
          </fieldset>
        )}
        {error !== null && (
          <p id={errorId} role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        <div className="move-actions">
          <Button variant="quiet" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="primary" type="submit" disabled={busy || teams === null}>
            {busy ? t.saving : t.save}
          </Button>
        </div>
      </form>
    </Modal>,
    shellRoot(),
  );
}
