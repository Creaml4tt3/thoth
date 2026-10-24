import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useDesktopStrings } from "../../../strings/index.ts";
import type { RunView } from "../useImportRun.ts";

const PHASES = ["staging", "verifying", "committing"] as const;

/** Step 8: progress by phase, Cancel, and per-item errors as they happen. */
export function RunProgress({ view, onCancel }: { view: RunView; onCancel(): void }) {
  const t = useDesktopStrings().wizard.run;
  return (
    <div className="wz-step">
      <h3 className="wz-q">{view.cancelling ? t.cancelling : t.title}</h3>
      <ul className="wz-phases">
        {PHASES.map((phase) => {
          const p = view.progress[phase];
          const label = t.phases[phase];
          return (
            <li key={phase}>
              <label htmlFor={`wz-p-${phase}`}>{label}</label>
              <progress id={`wz-p-${phase}`} max={p?.total ?? 1} value={p?.done ?? 0} aria-label={label} />
              <span className="muted mono">{p ? `${p.done} / ${p.total}` : t.waiting}</span>
            </li>
          );
        })}
      </ul>
      {view.failed.length > 0 && (
        <section aria-labelledby="wz-errs">
          <h4 id="wz-errs" className="label">
            {t.errors(view.failed.length)}
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
      <p className="muted">{t.note}</p>
      <div className="wz-actions">
        <Button variant="danger" onClick={onCancel} disabled={view.cancelling}>
          {t.cancel}
        </Button>
      </div>
    </div>
  );
}
