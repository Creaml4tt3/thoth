import { useEffect, useState, useSyncExternalStore } from "react";
import type { UpdateSettings as HostUpdateSettings } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { InstallPanel } from "./InstallPanel.tsx";
import type { UpdateService } from "./service.ts";
import "./updates.css";

/**
 * Settings → Updates (ADR-0022): "Tell me when a new version is out" (on by default; off means the host makes no request
 * at all) and "Check now". Only where the host has an update notice. The choice is the host's, kept in the app data folder.
 * ADR-0034 adds "Download and install updates in the app" (on by default), shown only where this copy can update
 * itself, and the update's state with the same buttons as the popup.
 */
export function UpdateSettings() {
  const { platform, updates: service } = useSession();
  const host = platform.updates;
  return host && service ? <Section host={host} service={service} /> : null;
}

function Section({ host, service }: { host: NonNullable<ReturnType<typeof useSession>["platform"]["updates"]>; service: UpdateService }) {
  const t = useDesktopStrings().updates;
  const [settings, setSettings] = useState<HostUpdateSettings | null>(null);
  const state = useSyncExternalStore(service.subscribe, service.getState);
  const { status, latest, install } = state;

  useEffect(() => {
    let live = true;
    host
      .settings()
      .then((s) => live && setSettings(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [host]);

  if (!settings?.available) return null;
  const message = { idle: "", checking: t.checking, current: t.upToDate, available: t.available(latest?.version ?? ""), failed: t.failed, off: t.off }[status];
  return (
    <section aria-labelledby="set-general" className="set-section update-settings">
      <h2 id="set-general">{t.general}</h2>
      <div className="set-toggle">
        <input
          id="update-notify"
          type="checkbox"
          role="switch"
          checked={settings.notify}
          aria-describedby="update-notify-hint"
          onChange={(e) => void host.setNotify(e.target.checked).then(setSettings, () => undefined)}
        />
        <label htmlFor="update-notify">{t.notify}</label>
        <small id="update-notify-hint" className="muted">
          {t.notifyHint}
        </small>
      </div>
      {settings.canInstall && (
        <div className="set-toggle">
          <input
            id="update-install"
            type="checkbox"
            role="switch"
            checked={settings.install !== false}
            aria-describedby="update-install-hint"
            onChange={(e) => void host.setInstall(e.target.checked).then(setSettings, () => undefined)}
          />
          <label htmlFor="update-install">{t.install}</label>
          <small id="update-install-hint" className="muted">
            {t.installHint}
          </small>
        </div>
      )}
      <p className="muted">{t.current(settings.current)}</p>
      <div className="set-actions">
        <Button variant="ghost" small disabled={!settings.notify || status === "checking"} onClick={() => void service.checkNow()}>
          {t.checkNow}
        </Button>
        {status === "available" && latest?.inApp && settings.install !== false && install.phase === "idle" && (
          <Button variant="primary" small onClick={() => void service.update()}>
            {t.update}
          </Button>
        )}
        <span role="status" className="muted" data-testid="update-check-status">
          {message}
        </span>
      </div>
      <InstallPanel service={service} state={state} />
    </section>
  );
}
