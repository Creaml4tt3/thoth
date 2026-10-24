import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

interface Props {
  value: string;
  label: string;
  maxLength: number;
  /** When set, Enter on an empty field shows this and stays open; otherwise an empty field just ends editing. */
  emptyMessage?: string;
  /**
   * Called with the new, trimmed, non-empty text; resolves when it is saved. Throw to end editing (the caller shows
   * the reason), or throw a `RenameRejected` to keep the field open with its message next to it.
   */
  onCommit(next: string): Promise<void>;
  /** Called when editing ends without a change (Escape, an empty or unchanged text), or after a save. */
  onDone(): void;
}

/** Thrown by `onCommit` when the name is not acceptable: the field stays open and shows `message` until the text changes. */
export class RenameRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenameRejected";
  }
}

/** The inline editor that takes a tree row's place while it is renamed: Enter saves, Escape cancels, leaving the field saves. */
export function RenameInput({ value, label, maxLength, emptyMessage, onCommit, onDone }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const finished = useRef(false);
  const refocus = useRef(false);
  const problemId = useId();

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  // A rejected name leaves the field open: it was disabled while saving, so focus comes back to it (after a key press).
  useEffect(() => {
    if (!busy && refocus.current) {
      refocus.current = false;
      ref.current?.focus();
    }
  }, [busy]);

  const finish = async (save: boolean, byKey = false) => {
    if (finished.current) return;
    const next = text.trim();
    if (save && byKey && next === "" && emptyMessage !== undefined) {
      setProblem(emptyMessage);
      return;
    }
    if (!save || next === "" || next === value) {
      finished.current = true;
      onDone();
      return;
    }
    finished.current = true;
    setBusy(true);
    try {
      await onCommit(next);
    } catch (error) {
      if (error instanceof RenameRejected) {
        finished.current = false;
        refocus.current = byKey;
        setProblem(error.message);
        setBusy(false);
        return;
      }
      // The caller shows the reason; the old name stays.
    }
    onDone();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation(); // typing a name is not tree navigation
    if (event.key === "Enter") {
      event.preventDefault();
      void finish(true, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      void finish(false);
    }
  };

  return (
    <>
      <input
        ref={ref}
        className="tree-rename"
        aria-label={label}
        aria-invalid={problem !== null || undefined}
        aria-describedby={problem !== null ? problemId : undefined}
        value={text}
        maxLength={maxLength}
        disabled={busy}
        onChange={(event) => {
          setText(event.target.value);
          setProblem(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => void finish(true)}
      />
      {problem !== null && (
        <span id={problemId} role="alert" className="tree-rename-problem">
          {problem}
        </span>
      )}
    </>
  );
}
