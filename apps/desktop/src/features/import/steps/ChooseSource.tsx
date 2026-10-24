import { useEffect, useState } from "react";
import type { ImportManifest } from "@thoth/importer-core";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import type { ImportService } from "../service.ts";
import { useDesktopStrings } from "../../../strings/index.ts";
import type { System } from "../model.ts";

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
  const w = useDesktopStrings().wizard;
  const t = w.source;
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
        <legend className="wz-q">{t.question}</legend>
        {(["notion", "obsidian"] as const).map((id) => (
          <label key={id} className="wz-choice" data-selected={system === id}>
            <input type="radio" name="system" value={id} checked={system === id} onChange={() => onSystem(id)} />
            <span>
              <b>{id === "notion" ? "Notion" : "Obsidian"}</b>
              <span className="muted">{t.hints[id]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="wz-actions">
        <Button variant="primary" onClick={onNext}>
          {w.continue}
        </Button>
      </div>
      {jobs.length > 0 && (
        <section className="wz-jobs" aria-labelledby="wz-jobs-title">
          <h3 id="wz-jobs-title" className="label">
            {t.unfinished}
          </h3>
          <ul>
            {jobs.map((job) => {
              const done = job.items.filter((i) => i.state === "committed").length;
              const total = job.items.filter((i) => i.state !== "skipped").length;
              return (
                <li key={job.jobId} className="wz-job">
                  <span>
                    <b>{job.sourceLabel}</b> <span className="badge badge-muted">{job.state === "cancelled" || job.state === "failed" ? t.state[job.state] : t.state.interrupted}</span>
                    <span className="muted wz-sub">
                      {t.progress(done, total, job.options.destinationRoot || t.topLevel)}
                    </span>
                  </span>
                  <Button variant="ghost" small disabled={resumeDisabled} onClick={() => onResume(job)} aria-label={t.resumeLabel(job.sourceLabel)}>
                    {t.resume}
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
