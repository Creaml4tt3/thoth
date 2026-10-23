import { useMemo } from "react";
import { diffLines } from "diff";
import { Button } from "../../ui/Button.tsx";
import { Modal } from "../../ui/Modal.tsx";
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

const CHOICES: Record<Where, { id: ConflictChoice; title: string; hint: string }[]> = {
  disk: [
    { id: "mine", title: "Keep mine", hint: "Replace the file on disk with what is in the editor." },
    { id: "theirs", title: "Keep theirs", hint: "Reload the file from disk and drop my unsaved edits." },
    { id: "both", title: "Keep both", hint: "Save my version as a separate conflict copy, then reload the file from disk." },
  ],
  server: [
    { id: "mine", title: "Keep mine", hint: "Replace the version on the server with what is in the editor." },
    { id: "theirs", title: "Keep theirs", hint: "Load the version on the server and drop my unsaved edits." },
    { id: "both", title: "Keep both", hint: "Save my version as a new page in this workspace, then load the version on the server." },
  ],
};

const TEXT: Record<Where, { title: string; side: string; changed: string; deleted: string; group: string }> = {
  disk: { title: "This page changed on disk", side: "On disk", changed: "was changed outside Thoth", deleted: "was deleted or moved outside Thoth", group: "the version on disk" },
  server: { title: "This page changed on the server", side: "On the server", changed: "was changed by someone else", deleted: "was deleted on the server", group: "the version on the server" },
};

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
  const rows = useMemo(() => lineDiff(conflict.disk?.source ?? "", conflict.mine), [conflict]);
  const deleted = conflict.disk === null;
  const text = TEXT[where];
  return (
    <Modal title={text.title} wide>
      <p>
        <b>{name}</b> {deleted ? text.deleted : text.changed} while you have unsaved edits. Nothing has been overwritten. Choose what to keep.
      </p>
      <div className="diff-head" aria-hidden="true">
        <span className="diff-key" data-side="theirs">{text.side}</span>
        <span className="diff-key" data-side="mine">Your edits</span>
      </div>
      <div className="diff" role="group" aria-label={`Differences between ${text.group} and your edits`} tabIndex={0}>
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
        {CHOICES[where].map((choice) => (
          <button key={choice.id} type="button" className="conflict-choice" onClick={() => onChoose(choice.id)} data-autofocus={choice.id === "both" ? "" : undefined} aria-describedby={`conflict-${choice.id}`}>
            <b>{choice.title}</b>
            <span id={`conflict-${choice.id}`}>{choice.hint}</span>
          </button>
        ))}
      </div>
      <div className="modal-actions muted">
        <Button variant="quiet" small disabled>
          Choose one to continue
        </Button>
      </div>
    </Modal>
  );
}
