import type { ImportManifest, ImportPreview } from "@thoth/importer-core";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { describeWarning, SEVERITY_ORDER } from "../warnings.ts";

export interface WarningGroup {
  code: string;
  severity: string;
  count: number;
  examples: { sourcePath?: string | undefined; message: string }[];
}

/** Groups every warning in a manifest (and source rejections) by code, worst severity first. */
export function groupWarnings(manifest: ImportManifest): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  for (const w of [...manifest.warnings, ...manifest.items.flatMap((i) => i.warnings)]) {
    const g = groups.get(w.code) ?? { code: w.code, severity: w.severity, count: 0, examples: [] };
    g.count++;
    if (SEVERITY_ORDER[w.severity]! < SEVERITY_ORDER[g.severity]!) g.severity = w.severity;
    if (g.examples.length < 5) g.examples.push({ sourcePath: w.sourcePath, message: w.message });
    groups.set(w.code, g);
  }
  return [...groups.values()].sort((a, b) => SEVERITY_ORDER[a.severity]! - SEVERITY_ORDER[b.severity]! || b.count - a.count);
}

export function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="wz-stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export function WarningList({ groups }: { groups: WarningGroup[] }) {
  if (groups.length === 0) return <p className="muted">No warnings.</p>;
  return (
    <ul className="wz-warnings">
      {groups.map((g) => {
        const info = describeWarning(g.code);
        return (
          <li key={g.code} data-severity={g.severity}>
            <details>
              <summary>
                <b>{info.title}</b> <span className="badge badge-muted">{g.count}</span> <span className="mono muted">{g.code}</span>
              </summary>
              <p>{info.explanation}</p>
              <ul className="wz-examples">
                {g.examples.map((e, i) => (
                  <li key={i} className="mono">
                    {e.sourcePath ? `${e.sourcePath}: ` : ""}
                    {e.message}
                  </li>
                ))}
                {g.count > g.examples.length && <li className="muted">and {g.count - g.examples.length} more</li>}
              </ul>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/** Step 5: what the scan found. */
export function Preview({ preview, manifest, onBack, onNext }: { preview: ImportPreview; manifest: ImportManifest; onBack(): void; onNext(): void }) {
  const groups = groupWarnings(manifest);
  const { links } = preview;
  return (
    <div className="wz-step">
      <h3 className="wz-q">
        Preview of <span className="wz-name">{preview.sourceLabel}</span>
      </h3>
      <div className="wz-stats" role="group" aria-label="Import contents">
        <Stat label="pages" value={preview.pages} />
        <Stat label="folders" value={preview.folders} />
        <Stat label="attachments" value={preview.attachments} />
        <Stat label="databases / CSV" value={preview.databases} />
        <Stat label="skipped" value={preview.skipped} />
      </div>
      <section aria-labelledby="wz-links">
        <h4 id="wz-links" className="label">
          Links
        </h4>
        <div className="wz-stats" role="group" aria-label="Links">
          <Stat label="resolved" value={links.resolved} />
          <Stat label="unresolved" value={links.unresolved} />
          <Stat label="ambiguous" value={links.ambiguous} />
          <Stat label="external" value={links.external} />
        </div>
      </section>
      {preview.previousImports.length > 0 && (
        <p role="note" className="alert alert-warning">
          This exact content was already imported {preview.previousImports.length === 1 ? "once" : `${preview.previousImports.length} times`} (into {preview.previousImports.map((p) => p.destinationRoot || "the top level").join(", ")}). Importing again creates separate copies.
        </p>
      )}
      {preview.duplicateTitles.length > 0 && (
        <section aria-labelledby="wz-dups">
          <h4 id="wz-dups" className="label">
            Duplicate titles ({preview.duplicateTitles.length})
          </h4>
          <p className="muted">Pages sharing a title are never merged. Each is kept as its own file.</p>
          <ul className="wz-examples">
            {preview.duplicateTitles.slice(0, 5).map((d) => (
              <li key={d.title}>
                <b>{d.title}</b> <span className="muted mono">{d.sourcePaths.length} pages</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {preview.collisions.length > 0 && (
        <section aria-labelledby="wz-coll">
          <h4 id="wz-coll" className="label">
            Name collisions ({preview.collisions.length})
          </h4>
          <p className="muted">These would clash with an existing file or each other. The destination step decides whether they are renamed or skipped.</p>
        </section>
      )}
      <section aria-labelledby="wz-warn">
        <h4 id="wz-warn" className="label">
          Warnings
        </h4>
        <WarningList groups={groups} />
      </section>
      <p className="wz-safe">Your source is only read. Thoth never changes, moves or deletes it.</p>
      <div className="wz-actions">
        <Button variant="quiet" onClick={onBack}>
          Choose another source
        </Button>
        <Button variant="primary" onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}
