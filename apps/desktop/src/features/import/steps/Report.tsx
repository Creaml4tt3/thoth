import type { ImportReport } from "@thoth/importer-core";
import { Button } from "../../../ui/Button.tsx";
import { SEVERITY_ORDER } from "../warnings.ts";
import { Stat, WarningList, type WarningGroup } from "./Preview.tsx";

const HEADLINE: Record<string, string> = {
  completed: "Import complete",
  cancelled: "Import cancelled",
  failed: "Import finished with errors",
};

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
  const groups = groupsOf(report);
  const total = report.imported.pages + report.imported.attachments + report.imported.databases;
  return (
    <div className="wz-step" data-testid="import-report">
      <h3 className="wz-q" role="status">
        {HEADLINE[report.state] ?? "Import finished"}
      </h3>
      <div className="wz-stats" role="group" aria-label="Import results">
        <Stat label="pages imported" value={report.imported.pages} />
        <Stat label="attachments" value={report.imported.attachments} />
        <Stat label="databases / CSV" value={report.imported.databases} />
        <Stat label="skipped" value={report.skipped} />
        <Stat label="failed" value={report.failed.length} />
        <Stat label="warnings" value={report.warnings.length} />
      </div>
      {report.failed.length > 0 && (
        <section aria-labelledby="wz-failed">
          <h4 id="wz-failed" className="label">
            Failed items
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
          Links: {report.links.resolved} resolved, {report.links.unresolved} unresolved, {report.links.ambiguous} ambiguous.
        </p>
      )}
      <section aria-labelledby="wz-rwarn">
        <h4 id="wz-rwarn" className="label">
          Warnings
        </h4>
        {groups.length === 0 ? <p className="muted">No warnings.</p> : <WarningList groups={groups} />}
      </section>
      <p className="wz-safe">Your source was only read. It was not changed, moved or deleted.</p>
      <div className="wz-actions">
        {report.state !== "completed" && (
          <Button variant="ghost" onClick={onResume}>
            Resume
          </Button>
        )}
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
        {total > 0 && (
          <Button variant="primary" onClick={onOpenFolder} title={destinationRoot || undefined} aria-label={`Open imported folder ${destinationRoot || "(top level)"}`}>
            <span className="wz-open-label">Open {destinationRoot ? `“${destinationRoot.slice(destinationRoot.lastIndexOf("/") + 1)}”` : "imported pages"}</span>
          </Button>
        )}
      </div>
    </div>
  );
}

