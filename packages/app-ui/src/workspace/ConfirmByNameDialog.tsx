import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shellRoot } from "../order/ContextMenu.tsx";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";

interface FormProps {
  /** What happens, in plain words. */
  body: string;
  /** What has to be typed to confirm: the workspace's name. */
  name: string;
  confirmLabel: string;
  busyLabel: string;
  /** Resolves with the reason it failed (the form stays), or null when it is done. */
  onConfirm(): Promise<string | null>;
  onCancel(): void;
}

/**
 * A destructive step that asks for the thing's name first (ADR-0025: deleting a workspace, deleting one permanently).
 * The button stays off until the typed name matches (spaces around it do not matter); the label says what to type.
 * The field takes focus, so the keyboard answers the question next.
 */
export function ConfirmByNameForm({ body, name, confirmLabel, busyLabel, onConfirm, onCancel }: FormProps) {
  const t = useStrings().workspaces;
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyId = useId();
  const field = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => {
    field.current?.focus();
    return () => {
      live.current = false;
    };
  }, []);
  const matches = typed.trim() === name.trim();

  const submit = async () => {
    if (!matches) return;
    setBusy(true);
    setError(null);
    const failure = await onConfirm();
    if (!live.current) return;
    setBusy(false);
    if (failure !== null) setError(failure);
  };

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p id={bodyId} className="share-note ws-confirm-body">
        {body}
      </p>
      <label className="field">
        <span>{t.typeToConfirm(name)}</span>
        <input
          ref={field}
          data-autofocus
          className="input"
          value={typed}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={bodyId}
          onChange={(event) => setTyped(event.target.value)}
        />
      </label>
      {error !== null && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
      <div className="move-actions">
        <Button variant="quiet" onClick={onCancel}>
          {t.cancel}
        </Button>
        <Button variant="danger" type="submit" disabled={busy || !matches}>
          {busy ? busyLabel : confirmLabel}
        </Button>
      </div>
    </form>
  );
}

/** `ConfirmByNameForm` in its own dialog (deleting a workspace from its row or the palette). */
export function ConfirmByNameDialog({ title, onClose, ...form }: Omit<FormProps, "onCancel"> & { title: string; onClose(): void }) {
  return createPortal(
    <Modal title={title} onClose={onClose}>
      <ConfirmByNameForm {...form} onCancel={onClose} />
    </Modal>,
    shellRoot(),
  );
}
