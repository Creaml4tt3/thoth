import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";
import { shellRoot } from "./ContextMenu.tsx";

interface Props {
  /** The page or folder, as the tree shows it. */
  name: string;
  /** What happens, in plain words: where it goes, and what goes with it. */
  body: string;
  /** Resolves with the reason it failed (the dialog stays open), or null when it is done. */
  onDelete(): Promise<string | null>;
  onClose(): void;
}

/** "Delete…" from a tree's menu: says what goes, and asks first. Cancel has focus, so Enter alone never deletes. */
export function DeleteDialog({ name, body, onDelete, onClose }: Props) {
  const t = useStrings().tree.deleteDialog;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const submit = async () => {
    setBusy(true);
    setError(null);
    const failure = await onDelete();
    if (!live.current) return;
    setBusy(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return createPortal(
    <Modal title={t.title(name)} onClose={onClose}>
      <div className="form">
        <p className="share-note">{body}</p>
        {error !== null && (
          <p role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        <div className="move-actions">
          <Button variant="quiet" data-autofocus onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void submit()}>
            {busy ? t.deleting : t.delete}
          </Button>
        </div>
      </div>
    </Modal>,
    shellRoot(),
  );
}
