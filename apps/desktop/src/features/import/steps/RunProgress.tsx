import { Button } from "@thoth/app-ui/ui/Button.tsx";
import type { RunView } from "../useImportRun.ts";

const PHASES = [
  { id: "staging", label: "Reading and converting" },
  { id: "verifying", label: "Verifying" },
  { id: "committing", label: "Adding to your Private Space" },
] as const;

/** Step 8: progress by phase, Cancel, and per-item errors as they happen. */
export function RunProgress({ view, onCancel }: { view: RunView; onCancel(): void }) {
  return (
    <div className="wz-step">
      <h3 className="wz-q">{view.cancelling ? "Cancelling…" : "Importing"}</h3>
      <ul className="wz-phases">
        {PHASES.map((phase) => {
          const p = view.progress[phase.id];
          return (
            <li key={phase.id}>
              <label htmlFor={`wz-p-${phase.id}`}>{phase.label}</label>
              <progress id={`wz-p-${phase.id}`} max={p?.total ?? 1} value={p?.done ?? 0} aria-label={phase.label} />
              <span className="muted mono">{p ? `${p.done} / ${p.total}` : "waiting"}</span>
            </li>
          );
        })}
      </ul>
      {view.failed.length > 0 && (
        <section aria-labelledby="wz-errs">
          <h4 id="wz-errs" className="label">
            Items with errors ({view.failed.length})
          </h4>
          <ul className="wz-examples" role="list">
            {view.failed.map((f) => (
              <li key={f.sourcePath} className="mono">
                {f.sourcePath}: {f.error}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="muted">You can cancel at any time. Cancelling keeps what was already added, and you can resume later.</p>
      <div className="wz-actions">
        <Button variant="danger" onClick={onCancel} disabled={view.cancelling}>
          Cancel import
        </Button>
      </div>
    </div>
  );
}
