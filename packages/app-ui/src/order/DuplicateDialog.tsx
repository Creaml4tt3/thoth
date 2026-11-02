import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";
import { shellRoot } from "./ContextMenu.tsx";

interface Props {
  /** The page or folder, as the tree shows it. */
  name: string;
  /** How many pages are inside it (they are copied too). */
  pages: number;
  /** What the copy is, in plain words, one paragraph each (what is copied, team limits). */
  notes: readonly string[];
  /** Resolves with the reason it failed (the dialog stays open), or null when it is done. */
  onDuplicate(): Promise<string | null>;
  onClose(): void;
}

/** "Duplicate" from a tree's menu, for a folder with pages in it, or where the copy loses its team limits: asks first. */
export function DuplicateDialog({ name, pages, notes, onDuplicate, onClose }: Props) {
  const t = useStrings().tree.duplicateDialog;
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
    const failure = await onDuplicate();
    if (!live.current) return;
    setBusy(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return createPortal(
    <Modal title={t.title(name, pages)} onClose={onClose}>
      <div className="form">
        {notes.map((note) => (
          <p key={note} className="share-note">
            {note}
          </p>
        ))}
        {error !== null && (
          <p role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        <div className="move-actions">
          <Button variant="quiet" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="primary" data-autofocus disabled={busy} onClick={() => void submit()}>
            {busy ? t.duplicating : t.duplicate}
          </Button>
        </div>
      </div>
    </Modal>,
    shellRoot(),
  );
}
