import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useDesktopStrings } from "../../../strings/index.ts";
import { checkDestination } from "../model.ts";

/** Step 6: where the import lands. Workspace destinations come later. */
export function Destination({ value, onChange, onBack, onNext }: { value: string; onChange(v: string): void; onBack(): void; onNext(): void }) {
  const strings = useDesktopStrings();
  const w = strings.wizard;
  const t = w.destination;
  const check = checkDestination(value);
  return (
    <div className="wz-step">
      <fieldset className="wz-choices">
        <legend className="wz-q">{t.question}</legend>
        <label className="wz-choice" data-selected="true">
          <input type="radio" name="space" checked readOnly />
          <span>
            <b>
              {strings.settings.privateSpace} <span className="badge badge-private">{strings.shell.local}</span>
            </b>
            <span className="muted">{t.privateNote}</span>
          </span>
        </label>
        <label className="wz-choice" data-disabled="true">
          <input type="radio" name="space" disabled />
          <span>
            <b>{t.workspace}</b>
            <span className="muted">{t.later}</span>
          </span>
        </label>
      </fieldset>
      <label className="field">
        <span>{t.folder}</span>
        <input className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!check.ok} aria-describedby="wz-dest-hint" />
      </label>
      <p id="wz-dest-hint" className={check.ok ? "muted" : "alert alert-danger"} role={check.ok ? undefined : "alert"}>
        {check.ok ? t.ok : t[check.reason]}
      </p>
      <div className="wz-actions">
        <Button variant="quiet" onClick={onBack}>
          {w.back}
        </Button>
        <Button variant="primary" disabled={!check.ok} onClick={onNext}>
          {w.continue}
        </Button>
      </div>
    </div>
  );
}
