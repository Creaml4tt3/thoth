import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ModuleModel, Modules } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useDesktopStrings } from "../../strings/index.ts";
import { createModuleService } from "./service.ts";
import "../updates/updates.css";

/**
 * Settings → Modules (ADR-0055): OCR, a separate download. Two choices, Fast and Second opinion, each with its size,
 * Download / Update / Remove / Cancel and a plain line for each failure; and "Update OCR models automatically" (off by
 * default). Nothing is downloaded until the person clicks.
 */
export function ModulesSettings({ host }: { host: Modules }) {
  const t = useDesktopStrings().modules;
  const service = useMemo(() => createModuleService(host), [host]);
  const status = useSyncExternalStore(service.subscribe, service.getState);
  // Opening the section reads the signed model list (plan §5a), so an update shows.
  useEffect(() => void service.refresh(), [service]);

  return (
    <section aria-labelledby="set-modules" className="set-section">
      <h2 id="set-modules">{t.title}</h2>
      <h3>{t.ocrTitle}</h3>
      {status && !status.available ? (
        <p className="muted">{t.unavailable}</p>
      ) : (
        <>
          <p className="muted">{t.ocrNote}</p>
          {status?.models.map((m) => <ModelRow key={m.id} model={m} status={status} service={service} />)}
          {status && (
            <div className="set-toggle">
              <input
                id="modules-auto"
                type="checkbox"
                role="switch"
                checked={status.autoUpdate}
                aria-describedby="modules-auto-hint"
                onChange={(e) => void service.setAutoUpdate(e.target.checked)}
              />
              <label htmlFor="modules-auto">{t.autoUpdate}</label>
              <small id="modules-auto-hint" className="muted">
                {t.autoUpdateHint}
              </small>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ModelRow({ model, status, service }: { model: ModuleModel; status: NonNullable<ReturnType<ReturnType<typeof createModuleService>["getState"]>>; service: ReturnType<typeof createModuleService> }) {
  const t = useDesktopStrings().modules;
  const name = model.id === "fast" ? t.fast : t.second;
  const job = status.job;
  const mine = job.state !== "idle" && job.model === model.id;
  const busy = job.state === "downloading" || job.state === "checking";
  const id = `module-${model.id}`;
  return (
    <div role="group" aria-labelledby={`${id}-name`} aria-describedby={`${id}-note`} className="set-sub">
      <p>
        <b id={`${id}-name`}>{name}</b>
      </p>
      <p id={`${id}-note`} className="muted">
        {model.id === "fast" ? t.fastNote : t.secondNote}
      </p>
      {model.installed && <p className="muted">{t.uses(t.mb(model.size))}</p>}
      {model.update && <p>{t.updateReady(t.mb(model.downloadSize))}</p>}
      {mine && job.state === "downloading" && (
        <div className="update-progress-row">
          <progress className="update-progress" aria-label={t.progressLabel} {...(job.total ? { max: job.total, value: job.received } : {})} />
          <span className="update-progress-text">{job.received > 0 ? t.progress(job.received, job.total) : t.downloading}</span>
        </div>
      )}
      {mine && job.state === "checking" && <p role="status">{t.checking}</p>}
      <div className="set-actions">
        {mine && job.state === "downloading" ? (
          <Button variant="ghost" small onClick={() => void service.cancel()}>
            {t.cancel}
          </Button>
        ) : (
          <>
            {!model.installed && (
              <Button variant="primary" small disabled={busy} onClick={() => void service.install(model.id)}>
                {t.download(t.mb(model.downloadSize))}
              </Button>
            )}
            {model.update && (
              <Button variant="primary" small disabled={busy} onClick={() => void service.install(model.id)}>
                {t.update}
              </Button>
            )}
            {model.installed && (
              <Button variant="ghost" small disabled={mine && busy} onClick={() => void service.remove(model.id)}>
                {t.remove}
              </Button>
            )}
          </>
        )}
      </div>
      {mine && job.state === "failed" && (
        // Cancelled is the person's own choice: said, not alarmed.
        <p role={job.reason === "cancelled" ? "status" : "alert"} className={job.reason === "cancelled" ? "muted" : "alert alert-danger"}>
          {t.failed[job.reason]}
        </p>
      )}
    </div>
  );
}
