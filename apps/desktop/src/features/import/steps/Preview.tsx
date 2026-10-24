import type { ImportManifest, ImportPreview } from "@thoth/importer-core";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useDesktopStrings } from "../../../strings/index.ts";
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
  const w = useDesktopStrings().wizard;
  if (groups.length === 0) return <p className="muted">{w.preview.noWarnings}</p>;
  return (
    <ul className="wz-warnings">
      {groups.map((g) => {
        const info = describeWarning(g.code, w);
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
                {g.count > g.examples.length && <li className="muted">{w.preview.andMore(g.count - g.examples.length)}</li>}
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
  const w = useDesktopStrings().wizard;
  const t = w.preview;
  const groups = groupWarnings(manifest);
  const { links } = preview;
  return (
    <div className="wz-step">
      <h3 className="wz-q">
        {t.of}
        <span className="wz-name">{preview.sourceLabel}</span>
      </h3>
      <div className="wz-stats" role="group" aria-label={t.contents}>
        <Stat label={t.stats.pages} value={preview.pages} />
        <Stat label={t.stats.folders} value={preview.folders} />
        <Stat label={t.stats.attachments} value={preview.attachments} />
        <Stat label={t.stats.databases} value={preview.databases} />
        <Stat label={t.stats.skipped} value={preview.skipped} />
      </div>
      <section aria-labelledby="wz-links">
        <h4 id="wz-links" className="label">
          {t.links}
        </h4>
        <div className="wz-stats" role="group" aria-label={t.links}>
          <Stat label={t.linkStats.resolved} value={links.resolved} />
          <Stat label={t.linkStats.unresolved} value={links.unresolved} />
          <Stat label={t.linkStats.ambiguous} value={links.ambiguous} />
          <Stat label={t.linkStats.external} value={links.external} />
        </div>
      </section>
      {preview.previousImports.length > 0 && (
        <p role="note" className="alert alert-warning">
          {t.already(preview.previousImports.length, preview.previousImports.map((p) => p.destinationRoot || w.source.topLevel).join(", "))}
        </p>
      )}
      {preview.duplicateTitles.length > 0 && (
        <section aria-labelledby="wz-dups">
          <h4 id="wz-dups" className="label">
            {t.duplicates(preview.duplicateTitles.length)}
          </h4>
          <p className="muted">{t.duplicatesNote}</p>
          <ul className="wz-examples">
            {preview.duplicateTitles.slice(0, 5).map((d) => (
              <li key={d.title}>
                <b>{d.title}</b> <span className="muted mono">{t.pagesCount(d.sourcePaths.length)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {preview.collisions.length > 0 && (
        <section aria-labelledby="wz-coll">
          <h4 id="wz-coll" className="label">
            {t.collisions(preview.collisions.length)}
          </h4>
          <p className="muted">{t.collisionsNote}</p>
        </section>
      )}
      <section aria-labelledby="wz-warn">
        <h4 id="wz-warn" className="label">
          {t.warnings}
        </h4>
        <WarningList groups={groups} />
      </section>
      <p className="wz-safe">{t.safe}</p>
      <div className="wz-actions">
        <Button variant="quiet" onClick={onBack}>
          {t.another}
        </Button>
        <Button variant="primary" onClick={onNext}>
          {w.continue}
        </Button>
      </div>
    </div>
  );
}
