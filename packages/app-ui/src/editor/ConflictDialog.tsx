import { useMemo } from "react";
import { diffLines } from "diff";
import { Button } from "../ui/Button.tsx";
import { Modal } from "../ui/Modal.tsx";
import { useStrings } from "../strings/index.ts";
import type { Conflict, ConflictChoice } from "./page-session.ts";

/** Line diff from the disk version to the editor's version. */
export function lineDiff(disk: string, mine: string): { kind: "same" | "add" | "del"; text: string }[] {
  const lines: { kind: "same" | "add" | "del"; text: string }[] = [];
  for (const part of diffLines(disk, mine)) {
    const kind = part.added ? "add" : part.removed ? "del" : "same";
    const chunk = part.value.endsWith("\n") ? part.value.slice(0, -1) : part.value;
    for (const text of chunk.split("\n")) lines.push({ kind, text });
  }
  return lines;
}

type Where = "disk" | "server";

const ORDER: readonly ConflictChoice[] = ["mine", "theirs", "both"];

interface Props {
  /** What to call the page (its path, or its title in a workspace). */
  name: string;
  where?: Where;
  conflict: Conflict;
  error: string | null;
  onChoose(choice: ConflictChoice): void;
}

/** Shown whenever the page changed elsewhere while there are unsaved edits. It cannot be dismissed without choosing. */
export function ConflictDialog({ name, where = "disk", conflict, error, onChoose }: Props) {
  const t = useStrings().conflict;
  const rows = useMemo(() => lineDiff(conflict.disk?.source ?? "", conflict.mine), [conflict]);
  const deleted = conflict.disk === null;
  const text = t.text[where];
  return (
    <Modal title={text.title} wide>
      <p>
        <b>{name}</b>
        {t.intro(deleted ? text.deleted : text.changed)}
      </p>
      <div className="diff-head" aria-hidden="true">
        <span className="diff-key" data-side="theirs">{text.side}</span>
        <span className="diff-key" data-side="mine">{t.yourEdits}</span>
      </div>
      <div className="diff" role="group" aria-label={t.differences(text.group)} tabIndex={0}>
        {rows.map((row, i) => (
          <div key={i} className={`diff-line diff-${row.kind}`} data-kind={row.kind}>
            <i aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}</i>
            <span>{row.text}</span>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
      <div className="conflict-choices">
        {ORDER.map((id) => (
          <button key={id} type="button" className="conflict-choice" onClick={() => onChoose(id)} data-autofocus={id === "both" ? "" : undefined} aria-describedby={`conflict-${id}`}>
            <b>{t.choices[where][id].title}</b>
            <span id={`conflict-${id}`}>{t.choices[where][id].hint}</span>
          </button>
        ))}
      </div>
      <div className="modal-actions muted">
        <Button variant="quiet" small disabled>
          {t.chooseToContinue}
        </Button>
      </div>
    </Modal>
  );
}
