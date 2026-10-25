/**
 * Review of an agent's proposed changes (ADR-0007 rule 5): one row per file with a checkbox, a line diff for pages
 * (the editor's conflict diff), and the reason when a change can never be applied. Nothing is written until Apply.
 */
import { useMemo } from "react";
import type { ProposedChange } from "@thoth/agent-core";
import { lineDiff } from "@thoth/app-ui/editor/ConflictDialog.tsx";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useDesktopStrings } from "../../strings/index.ts";

export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function Diff({ change }: { change: ProposedChange }) {
  const t = useDesktopStrings().agents.review;
  const lines = useMemo(() => lineDiff(change.before ?? "", change.after ?? ""), [change.before, change.after]);
  return (
    <>
      <div className="diff-head" aria-hidden="true">
        <span className="diff-key" data-side="theirs">
          {t.before}
        </span>
        <span className="diff-key" data-side="mine">
          {t.after}
        </span>
      </div>
      <div className="diff" role="group" aria-label={t.differences(change.path)} tabIndex={0}>
        {lines.map((row, i) => (
          <div key={i} className={`diff-line diff-${row.kind}`} data-kind={row.kind}>
            <i aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}</i>
            <span>{row.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function Review({ changes, approved, busy, onApproved, onApply, onDiscard }: { changes: readonly ProposedChange[]; approved: readonly string[]; busy: boolean; onApproved(paths: string[]): void; onApply(): void; onDiscard(): void }) {
  const t = useDesktopStrings().agents.review;
  const applicable = changes.filter((c) => c.problem === undefined).map((c) => c.path);
  const chosen = new Set(approved);
  const toggle = (path: string) => onApproved(chosen.has(path) ? approved.filter((p) => p !== path) : [...approved, path]);
  return (
    <section className="set-section agents-review" aria-labelledby="agents-review-heading">
      <h2 id="agents-review-heading">{t.heading}</h2>
      <p className="muted">{t.lede}</p>
      {applicable.length > 1 && (
        <div className="set-actions">
          <Button variant="quiet" small onClick={() => onApproved(applicable)} disabled={busy}>
            {t.all}
          </Button>
          <Button variant="quiet" small onClick={() => onApproved([])} disabled={busy}>
            {t.none}
          </Button>
        </div>
      )}
      <ul className="agents-changes">
        {changes.map((change) => (
          <li key={change.path} className="agents-change" data-change={change.change} data-problem={change.problem}>
            <div className="agents-change-head">
              <label className="xfer-check">
                <input type="checkbox" checked={chosen.has(change.path)} disabled={busy || change.problem !== undefined} onChange={() => toggle(change.path)} aria-label={t.approve(change.path)} />
                <b className="mono agents-path">{change.path}</b>
              </label>
              <span className="badge badge-muted" data-kind={change.change}>
                {t.kinds[change.change]}
              </span>
            </div>
            {change.problem && (
              <p className="alert alert-danger small" role="note">
                {t.problems[change.problem]}
              </p>
            )}
            {!change.problem && change.stale && (
              <p className="alert alert-warning small" role="note">
                {t.stale}
              </p>
            )}
            {!change.problem && change.change === "deleted" && <p className="muted small">{t.deleted}</p>}
            {!change.problem && change.page && <Diff change={change} />}
            {!change.problem && !change.page && change.change !== "deleted" && change.afterSize !== null && <p className="muted small">{t.file(bytes(change.afterSize))}</p>}
          </li>
        ))}
      </ul>
      <div className="set-actions">
        <Button variant="primary" onClick={onApply} disabled={busy || approved.length === 0}>
          {busy ? t.applying : t.apply(approved.length)}
        </Button>
        <Button variant="ghost" onClick={onDiscard} disabled={busy}>
          {t.discard}
        </Button>
      </div>
    </section>
  );
}
