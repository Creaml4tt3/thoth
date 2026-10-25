import { useEffect, useState, useSyncExternalStore } from "react";
import type { UpdateSettings as HostUpdateSettings } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import type { UpdateService } from "./service.ts";
import "./updates.css";

/**
 * Settings → General (ADR-0022): "Tell me when a new version is out" (on by default; off means the host makes no request
 * at all) and "Check now". Only where the host has an update notice. The choice is the host's, kept in the app data folder.
 */
export function UpdateSettings() {
  const { platform, updates: service } = useSession();
  const host = platform.updates;
  return host && service ? <Section host={host} service={service} /> : null;
}

function Section({ host, service }: { host: NonNullable<ReturnType<typeof useSession>["platform"]["updates"]>; service: UpdateService }) {
  const t = useDesktopStrings().updates;
  const [settings, setSettings] = useState<HostUpdateSettings | null>(null);
  const { status, latest } = useSyncExternalStore(service.subscribe, service.getState);

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
      <p className="muted">{t.current(settings.current)}</p>
      <div className="set-actions">
        <Button variant="ghost" small disabled={!settings.notify || status === "checking"} onClick={() => void service.checkNow()}>
          {t.checkNow}
        </Button>
        <span role="status" className="muted" data-testid="update-check-status">
          {message}
        </span>
      </div>
    </section>
  );
}
