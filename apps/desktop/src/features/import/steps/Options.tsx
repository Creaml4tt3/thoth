import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useDesktopStrings } from "../../../strings/index.ts";

export interface WizardOptions {
  conflictPolicy: "rename" | "skip";
  addIdentityFrontmatter: boolean;
}

/** Step 7: conflict handling and identity frontmatter. */
export function Options({ value, onChange, busy, error, onBack, onStart }: { value: WizardOptions; onChange(v: WizardOptions): void; busy: boolean; error: string | null; onBack(): void; onStart(): void }) {
  const w = useDesktopStrings().wizard;
  const t = w.options;
  return (
    <div className="wz-step">
      <fieldset className="wz-choices">
        <legend className="wz-q">{t.question}</legend>
        {(["rename", "skip"] as const).map((policy) => (
          <label key={policy} className="wz-choice" data-selected={value.conflictPolicy === policy}>
            <input type="radio" name="conflict" checked={value.conflictPolicy === policy} onChange={() => onChange({ ...value, conflictPolicy: policy })} />
            <span>
              <b>{t[policy].title}</b>
              <span className="muted">{t[policy].hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="wz-choice wz-check" data-selected={value.addIdentityFrontmatter}>
        <input type="checkbox" checked={value.addIdentityFrontmatter} onChange={(e) => onChange({ ...value, addIdentityFrontmatter: e.target.checked })} />
        <span>
          <b>{t.identity}</b>
          <span className="muted">{t.identityHint}</span>
        </span>
      </label>
      {error && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
      <div className="wz-actions">
        <Button variant="quiet" onClick={onBack} disabled={busy}>
          {w.back}
        </Button>
        <Button variant="primary" onClick={onStart} disabled={busy}>
          {busy ? t.preparing : t.start}
        </Button>
      </div>
    </div>
  );
}
