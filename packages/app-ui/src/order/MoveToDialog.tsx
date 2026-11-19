import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { shellRoot } from "./ContextMenu.tsx";

export interface Destination {
  /** Opaque to the dialog: a page id, a folder path, or "" for the top level. */
  id: string;
  label: string;
  depth: number;
  folder: boolean;
}

interface Props {
  /** The title of what moves. */
  name: string;
  destinations: Destination[];
  /** Selected when the dialog opens: where the page is now. */
  initial: string;
  /** Resolves with an error message to show (the dialog stays open), or null when the move is done. */
  onMove(destination: string): Promise<string | null>;
  onClose(): void;
  /** "Duplicate to…" (ADR-0047): the same picker in its own words; the copy may also go where the original is. */
  as?: { title: string; destination: string; action: string; busy: string; notes(destination: string): readonly string[] };
}

/** "Move to…": pick the page or folder to move into. The same dialog serves both trees. */
export function MoveToDialog({ name, destinations, initial, onMove, onClose, as }: Props) {
  const t = useStrings().tree;
  const labelId = useId();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const failure = await onMove(value);
    setBusy(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return createPortal(
    <Modal title={as?.title ?? t.moveDialog.title(name)} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <span id={labelId}>{as?.destination ?? t.moveDialog.destination}</span>
          <Select data-autofocus className="move-list" aria-labelledby={labelId} value={value} onChange={setValue} options={destinations.map((d) => ({ value: d.id, label: `${"\u00a0\u00a0".repeat(d.depth)}${d.label}` }))} />
        </div>
        {as?.notes(value).map((note) => (
          <p key={note} className="share-note">
            {note}
          </p>
        ))}
        {error !== null && error !== "" && (
          <p role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        <div className="move-actions">
          <Button variant="quiet" onClick={onClose}>
            {t.moveDialog.cancel}
          </Button>
          <Button variant="primary" type="submit" disabled={busy || (!as && value === initial)}>
            {as ? (busy ? as.busy : as.action) : t.moveDialog.move}
          </Button>
        </div>
      </form>
    </Modal>,
    shellRoot(),
  );
}
