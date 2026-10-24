import { useEffect, useRef, useState, type KeyboardEvent } from "react";

interface Props {
  value: string;
  label: string;
  maxLength: number;
  /** Called with the new, trimmed, non-empty text; resolves when it is saved. Throw to keep editing. */
  onCommit(next: string): Promise<void>;
  /** Called when editing ends without a change (Escape, an empty or unchanged text), or after a save. */
  onDone(): void;
}

/** The inline editor that takes a tree row's place while it is renamed: Enter saves, Escape cancels, leaving the field saves. */
export function RenameInput({ value, label, maxLength, onCommit, onDone }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const finished = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = async (save: boolean) => {
    if (finished.current) return;
    const next = text.trim();
    if (!save || next === "" || next === value) {
      finished.current = true;
      onDone();
      return;
    }
    finished.current = true;
    setBusy(true);
    try {
      await onCommit(next);
    } catch {
      // The caller shows the reason; the old name stays.
    }
    onDone();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation(); // typing a name is not tree navigation
    if (event.key === "Enter") {
      event.preventDefault();
      void finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      void finish(false);
    }
  };

  return <input ref={ref} className="tree-rename" aria-label={label} value={text} maxLength={maxLength} disabled={busy} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} onBlur={() => void finish(true)} />;
}
