import { useEffect, useState } from "react";
import type { ImportManifest } from "@thoth/importer-core";
import { Button } from "../../../ui/Button.tsx";
import type { ImportService } from "../service.ts";
import type { System } from "../model.ts";

const STATE_LABEL: Record<string, string> = { cancelled: "Cancelled", failed: "Failed with errors" };

/** Step 1: Notion or Obsidian. Also lists unfinished jobs with Resume. */
export function ChooseSource({ service, revision, system, onSystem, onNext, onResume, resumeDisabled }: {
  service: ImportService;
  revision: number;
  system: System;
  onSystem(system: System): void;
  onNext(): void;
  onResume(job: ImportManifest): void;
  resumeDisabled: boolean;
}) {
  const [jobs, setJobs] = useState<ImportManifest[]>([]);
  useEffect(() => {
    let live = true;
    void service.listJobs().then((list) => live && setJobs(list)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [service, revision]);

  return (
    <div className="wz-step">
      <fieldset className="wz-choices">
        <legend className="wz-q">Where are your notes coming from?</legend>
        {(["notion", "obsidian"] as const).map((id) => (
          <label key={id} className="wz-choice" data-selected={system === id}>
            <input type="radio" name="system" value={id} checked={system === id} onChange={() => onSystem(id)} />
            <span>
              <b>{id === "notion" ? "Notion" : "Obsidian"}</b>
              <span className="muted">{id === "notion" ? "A Markdown & CSV export (ZIP, or the folder once extracted)." : "A vault folder, or a ZIP of one."}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="wz-actions">
        <Button variant="primary" onClick={onNext}>
          Continue
        </Button>
      </div>
      {jobs.length > 0 && (
        <section className="wz-jobs" aria-labelledby="wz-jobs-title">
          <h3 id="wz-jobs-title" className="label">
            Unfinished imports
          </h3>
          <ul>
            {jobs.map((job) => {
              const done = job.items.filter((i) => i.state === "committed").length;
              const total = job.items.filter((i) => i.state !== "skipped").length;
              return (
                <li key={job.jobId} className="wz-job">
                  <span>
                    <b>{job.sourceLabel}</b> <span className="badge badge-muted">{STATE_LABEL[job.state] ?? "Interrupted"}</span>
                    <span className="muted wz-sub">
                      {done} of {total} items imported into {job.options.destinationRoot || "the top level"}
                    </span>
                  </span>
                  <Button variant="ghost" small disabled={resumeDisabled} onClick={() => onResume(job)} aria-label={`Resume import of ${job.sourceLabel}`}>
                    Resume
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
