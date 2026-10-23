import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { checkDestination } from "../model.ts";

/** Step 6: where the import lands. Workspace destinations come later. */
export function Destination({ value, onChange, onBack, onNext }: { value: string; onChange(v: string): void; onBack(): void; onNext(): void }) {
  const check = checkDestination(value);
  return (
    <div className="wz-step">
      <fieldset className="wz-choices">
        <legend className="wz-q">Where should the imported pages go?</legend>
        <label className="wz-choice" data-selected="true">
          <input type="radio" name="space" checked readOnly />
          <span>
            <b>
              Private Space <span className="badge badge-private">Local</span>
            </b>
            <span className="muted">Files stay on your computer as Markdown.</span>
          </span>
        </label>
        <label className="wz-choice" data-disabled="true">
          <input type="radio" name="space" disabled />
          <span>
            <b>Workspace</b>
            <span className="muted">Coming later</span>
          </span>
        </label>
      </fieldset>
      <label className="field">
        <span>Folder inside your Private Space (leave empty for the top level)</span>
        <input className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!check.ok} aria-describedby="wz-dest-hint" />
      </label>
      <p id="wz-dest-hint" className={check.ok ? "muted" : "alert alert-danger"} role={check.ok ? undefined : "alert"}>
        {check.ok ? "Imported files are added here. Nothing existing is overwritten." : check.reason}
      </p>
      <div className="wz-actions">
        <Button variant="quiet" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" disabled={!check.ok} onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}
