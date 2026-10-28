import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import type { InstallState } from "@thoth/platform";
import { useDesktopStrings } from "../../strings/index.ts";
import type { UpdateService, UpdateServiceState } from "./service.ts";

type Strings = ReturnType<typeof useDesktopStrings>["updates"];

/** The heading for an update past "is out": updating, ready, or not installed. */
export function installTitle(t: Strings, install: InstallState, version: string): string {
  if (install.phase === "ready") return t.readyTitle(install.version);
  if (install.phase === "restarting") return t.readyTitle(version);
  if (install.phase === "failed") return t.failedTitle(version);
  return t.downloadingTitle(version);
}

/**
 * An in-app update past the click on Update (ADR-0034), with its buttons: progress and Cancel; Restart now (or why it
 * did not restart: a save failed, or assistant runs are going); the failure, with Try again where it may help and the
 * Download button always. Shared by the popup and Settings → Updates. Nothing for `idle`.
 */
export function InstallPanel({ service, state, messageId, extra }: { service: UpdateService; state: UpdateServiceState; messageId?: string; extra?: ReactNode }) {
  const t = useDesktopStrings().updates;
  const { install, problem } = state;
  if (install.phase === "idle") return null;
  const download = (
    <Button variant={install.phase === "failed" ? "primary" : "ghost"} small onClick={() => void service.download()}>
      {t.download}
    </Button>
  );
  let message: ReactNode;
  let actions: ReactNode;
  switch (install.phase) {
    case "downloading": {
      const { received, total } = install;
      message = (
        <>
          <progress className="update-progress" aria-label={t.progressLabel} {...(total ? { max: total, value: received } : {})} />
          <span className="update-progress-text">{received > 0 ? t.progress(received, total) : t.downloading}</span>
        </>
      );
      actions = (
        <Button variant="ghost" small onClick={() => void service.cancel()}>
          {t.cancel}
        </Button>
      );
      break;
    }
    case "ready":
      message = problem?.kind === "save" ? t.saveFailed : problem?.kind === "busy" ? t.busy(problem.runs) : install.installed ? t.readyInstalled : t.readyOnRestart;
      actions =
        problem?.kind === "busy" ? (
          <Button variant="primary" small onClick={() => void service.restart({ evenIfRunning: true })}>
            {t.restartAnyway}
          </Button>
        ) : (
          <Button variant="primary" small onClick={() => void service.restart()}>
            {problem?.kind === "save" ? t.tryAgain : t.restartNow}
          </Button>
        );
      break;
    case "restarting":
      message = t.restarting;
      actions = null;
      break;
    case "failed":
      message = t.failedReason[install.reason];
      actions = (
        <>
          {download}
          {/* A signature that did not check out will not check out again. */}
          {install.reason !== "verify" && (
            <Button variant="ghost" small onClick={() => void service.update()}>
              {t.tryAgain}
            </Button>
          )}
        </>
      );
      break;
  }
  return (
    <div className="update-install" data-phase={install.phase} data-testid="update-install">
      <p id={messageId} className={problem && install.phase === "ready" ? "update-problem" : undefined}>
        {message}
      </p>
      {(actions || extra) && (
        <div className="update-actions">
          {actions}
          {extra}
        </div>
      )}
    </div>
  );
}

/**
 * What the polite status line says about an update: once at the start, at each quarter and at the end of a download,
 * and when it is ready or failed. Never once per chunk.
 */
export function useInstallAnnouncement(install: InstallState, version: string | undefined): string {
  const t = useDesktopStrings().updates;
  const [said, setSaid] = useState("");
  const last = useRef("");
  useEffect(() => {
    if (!version) return;
    let key = "";
    let text = "";
    if (install.phase === "downloading") {
      const percent = install.total ? Math.min(100, Math.floor((install.received / install.total) * 4) * 25) : 0;
      key = `d${percent}`;
      text = t.announceProgress(version, percent);
    } else if (install.phase === "ready") {
      key = "ready";
      text = t.announceReady(install.version);
    } else if (install.phase === "failed") {
      key = `failed-${install.reason}`;
      text = `${t.announceFailed(version)} ${t.failedReason[install.reason]}`;
    } else if (install.phase === "restarting") {
      key = "restarting";
      text = t.restarting;
    }
    if (key && key !== last.current) {
      last.current = key;
      setSaid(text);
    }
  }, [install, version, t]);
  return said;
}
