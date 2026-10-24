import type { ImportReport } from "@thoth/importer-core";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useDesktopStrings } from "../../../strings/index.ts";
import { SEVERITY_ORDER } from "../warnings.ts";
import { Stat, WarningList, type WarningGroup } from "./Preview.tsx";

function groupsOf(report: ImportReport): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  for (const w of report.warnings) {
    const g = groups.get(w.code) ?? { code: w.code, severity: w.severity, count: 0, examples: [] };
    g.count++;
    if (SEVERITY_ORDER[w.severity]! < SEVERITY_ORDER[g.severity]!) g.severity = w.severity;
    if (g.examples.length < 5) g.examples.push({ sourcePath: w.sourcePath, message: w.message });
    groups.set(w.code, g);
  }
  return [...groups.values()].sort((a, b) => SEVERITY_ORDER[a.severity]! - SEVERITY_ORDER[b.severity]! || b.count - a.count);
}

/** Steps 9 and 10: the report, a way to open the result, and the "source untouched" note. */
export function Report({ report, destinationRoot, onOpenFolder, onResume, onDone }: { report: ImportReport; destinationRoot: string; onOpenFolder(): void; onResume(): void; onDone(): void }) {
  const w = useDesktopStrings().wizard;
  const t = w.report;
  const groups = groupsOf(report);
  const total = report.imported.pages + report.imported.attachments + report.imported.databases;
  return (
    <div className="wz-step" data-testid="import-report">
      <h3 className="wz-q" role="status">
        {report.state === "completed" || report.state === "cancelled" || report.state === "failed" ? t.headline[report.state] : t.headline.other}
      </h3>
      <div className="wz-stats" role="group" aria-label={t.results}>
        <Stat label={t.stats.pages} value={report.imported.pages} />
        <Stat label={t.stats.attachments} value={report.imported.attachments} />
        <Stat label={t.stats.databases} value={report.imported.databases} />
        <Stat label={t.stats.skipped} value={report.skipped} />
        <Stat label={t.stats.failed} value={report.failed.length} />
        <Stat label={t.stats.warnings} value={report.warnings.length} />
      </div>
      {report.failed.length > 0 && (
        <section aria-labelledby="wz-failed">
          <h4 id="wz-failed" className="label">
            {t.failedItems}
          </h4>
          <ul className="wz-examples">
            {report.failed.map((f) => (
              <li key={f.sourcePath} className="mono">
                {f.sourcePath}: {f.error}
              </li>
            ))}
          </ul>
        </section>
      )}
      {report.links && (
        <p className="muted">
          {t.links(report.links.resolved, report.links.unresolved, report.links.ambiguous)}
        </p>
      )}
      <section aria-labelledby="wz-rwarn">
        <h4 id="wz-rwarn" className="label">
          {w.preview.warnings}
        </h4>
        {groups.length === 0 ? <p className="muted">{w.preview.noWarnings}</p> : <WarningList groups={groups} />}
      </section>
      <p className="wz-safe">{t.safe}</p>
      <div className="wz-actions">
        {report.state !== "completed" && (
          <Button variant="ghost" onClick={onResume}>
            {w.source.resume}
          </Button>
        )}
        <Button variant="ghost" onClick={onDone}>
          {w.close}
        </Button>
        {total > 0 && (
          <Button variant="primary" onClick={onOpenFolder} title={destinationRoot || undefined} aria-label={t.openLabel(destinationRoot || null)}>
            <span className="wz-open-label">{t.open(destinationRoot ? destinationRoot.slice(destinationRoot.lastIndexOf("/") + 1) : null)}</span>
          </Button>
        )}
      </div>
    </div>
  );
}

