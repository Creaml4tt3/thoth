import { Button } from "@thoth/app-ui/ui/Button.tsx";

export interface WizardOptions {
  conflictPolicy: "rename" | "skip";
  addIdentityFrontmatter: boolean;
}

/** Step 7: conflict handling and identity frontmatter. */
export function Options({ value, onChange, busy, error, onBack, onStart }: { value: WizardOptions; onChange(v: WizardOptions): void; busy: boolean; error: string | null; onBack(): void; onStart(): void }) {
  return (
    <div className="wz-step">
      <fieldset className="wz-choices">
        <legend className="wz-q">If a file with the same name already exists</legend>
        {(["rename", "skip"] as const).map((policy) => (
          <label key={policy} className="wz-choice" data-selected={value.conflictPolicy === policy}>
            <input type="radio" name="conflict" checked={value.conflictPolicy === policy} onChange={() => onChange({ ...value, conflictPolicy: policy })} />
            <span>
              <b>{policy === "rename" ? "Keep both (rename the new one)" : "Skip it"}</b>
              <span className="muted">{policy === "rename" ? "The imported file gets a number added. Nothing is overwritten." : "The existing file stays and the imported one is not added."}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="wz-choice wz-check" data-selected={value.addIdentityFrontmatter}>
        <input type="checkbox" checked={value.addIdentityFrontmatter} onChange={(e) => onChange({ ...value, addIdentityFrontmatter: e.target.checked })} />
        <span>
          <b>Add identity frontmatter to imported pages</b>
          <span className="muted">Writes a thoth_id and where the page came from (thoth_source) at the top of each imported page. It keeps links and re-imports stable, and shows up as a small metadata block in the Markdown file. The source itself is never changed.</span>
        </span>
      </label>
      {error && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
      <div className="wz-actions">
        <Button variant="quiet" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button variant="primary" onClick={onStart} disabled={busy}>
          {busy ? "Preparing…" : "Start import"}
        </Button>
      </div>
    </div>
  );
}
