import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";
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
}

/** "Move to…": pick the page or folder to move into. The same dialog serves both trees. */
export function MoveToDialog({ name, destinations, initial, onMove, onClose }: Props) {
  const t = useStrings().tree;
  const selectId = useId();
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
    <Modal title={t.moveDialog.title(name)} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field" htmlFor={selectId}>
          <span>{t.moveDialog.destination}</span>
          <select id={selectId} className="input move-list" size={Math.min(8, Math.max(3, destinations.length))} value={value} onChange={(event) => setValue(event.target.value)} data-autofocus>
            {destinations.map((d) => (
              <option key={d.id} value={d.id}>
                {"\u00a0\u00a0".repeat(d.depth)}
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {error !== null && error !== "" && (
          <p role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        <div className="move-actions">
          <Button variant="quiet" onClick={onClose}>
            {t.moveDialog.cancel}
          </Button>
          <Button variant="primary" type="submit" disabled={busy || value === initial}>
            {t.moveDialog.move}
          </Button>
        </div>
      </form>
    </Modal>,
    shellRoot(),
  );
}
