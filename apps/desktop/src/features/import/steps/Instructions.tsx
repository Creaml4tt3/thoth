import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useDesktopStrings } from "../../../strings/index.ts";
import type { System } from "../model.ts";

/** Step 2: how to prepare or export the source. */
export function Instructions({ system, onBack, onNext }: { system: System; onBack(): void; onNext(): void }) {
  const w = useDesktopStrings().wizard;
  const how = w.how[system];
  return (
    <div className="wz-step">
      <h3 className="wz-q">{how.title}</h3>
      <ol className="wz-list">
        {how.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="muted">{how.note}</p>
      <div className="wz-actions">
        <Button variant="quiet" onClick={onBack}>
          {w.back}
        </Button>
        <Button variant="primary" onClick={onNext}>
          {w.ready}
        </Button>
      </div>
    </div>
  );
}
