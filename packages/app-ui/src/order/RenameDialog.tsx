import { useState } from "react";
import { createPortal } from "react-dom";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";
import { shellRoot } from "./ContextMenu.tsx";

interface Props {
  /** The name now, shown in the title and in the field. */
  name: string;
  maxLength?: number;
  /** Resolves with the reason it failed (the dialog stays open), or null when it is done. */
  onRename(next: string): Promise<string | null>;
  onClose(): void;
}

/** "Rename…" from the palette: a field with the current name. The trees rename in place (F2); this is the same change by command. */
export function RenameDialog({ name, maxLength, onRename, onClose }: Props) {
  const t = useStrings().tree;
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const next = value.trim();
    if (next === "") return setError(t.renameDialog.empty);
    if (next === name) return onClose();
    setBusy(true);
    setError(null);
    const failure = await onRename(next);
    setBusy(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return createPortal(
    <Modal title={t.renameDialog.title(name)} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>{t.renameDialog.name}</span>
          <input data-autofocus className="input" value={value} maxLength={maxLength} disabled={busy} onChange={(event) => setValue(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
        </label>
        {error !== null && error !== "" && (
          <p role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        <div className="move-actions">
          <Button variant="quiet" onClick={onClose}>
            {t.renameDialog.cancel}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {t.renameDialog.rename}
          </Button>
        </div>
      </form>
    </Modal>,
    shellRoot(),
  );
}
