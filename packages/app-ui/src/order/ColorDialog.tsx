import { useState } from "react";
import { createPortal } from "react-dom";
import { TEXT_COLORS, type TextColor } from "@thoth/editor";
import { useStrings } from "../strings/index.ts";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";
import { shellRoot } from "./ContextMenu.tsx";
import { FolderIcon } from "./icons.tsx";

interface Props {
  /** The folder, as the tree shows it. */
  name: string;
  current: TextColor | null;
  /** Resolves with the reason it failed (the dialog stays open), or null when it is done. */
  onPick(color: TextColor | null): Promise<string | null>;
  onClose(): void;
}

/**
 * "Color…" from a folder's menu (0.2.6): eight label colors and None, as a radio group. A choice applies at once and
 * closes the dialog; the current one has focus, so Enter keeps it.
 */
export function ColorDialog({ name, current, onPick, onClose }: Props) {
  const t = useStrings().tree.colorDialog;
  const names = useStrings().editor.styles.colorNames;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices: (TextColor | null)[] = [...TEXT_COLORS, null];

  const pick = async (color: TextColor | null) => {
    setBusy(true);
    setError(null);
    const failure = await onPick(color);
    setBusy(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return createPortal(
    <Modal title={t.title(name)} onClose={onClose}>
      <div className="form">
        <div className="color-choices" role="radiogroup" aria-label={t.label}>
          {choices.map((color) => (
            <button
              key={color ?? "none"}
              type="button"
              role="radio"
              className="color-choice"
              aria-checked={color === current}
              disabled={busy}
              data-autofocus={color === current ? "" : undefined}
              onClick={() => void pick(color)}
            >
              <FolderIcon open={false} color={color} />
              {color === null ? t.none : names[color]}
            </button>
          ))}
        </div>
        {error !== null && (
          <p role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        <div className="move-actions">
          <Button variant="quiet" onClick={onClose}>
            {t.cancel}
          </Button>
        </div>
      </div>
    </Modal>,
    shellRoot(),
  );
}
