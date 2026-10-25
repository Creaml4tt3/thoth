import { useCallback, useEffect, useState } from "react";
import type { ConnectedApps, ConnectedAppsLogEntry, ConnectedAppsSettings as Settings } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { copyText } from "@thoth/app-ui/editor/link-cards.ts";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { displayPath } from "../settings/path.ts";
import { folderName } from "./names.ts";
import "./connected-apps.css";

/**
 * Settings → Connected apps (ADR-0021): the switch (off by default), which Private Spaces apps may read (each ticked
 * on purpose), the apps that connected with the user's Allow or Deny, the setup to paste into an app, and the request
 * log. An app's name is the one it gave; the section says so.
 */
export function ConnectedAppsSettings({ connectedApps }: { connectedApps: ConnectedApps }) {
  const { platform, connection } = useSession();
  const t = useDesktopStrings().connectedApps;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const [log, setLog] = useState<ConnectedAppsLogEntry[] | null>(null);

  const reload = useCallback(() => connectedApps.settings().then(setSettings, () => undefined), [connectedApps]);
  useEffect(() => {
    void reload();
    void platform.recentVaults().then(setRecent, () => undefined);
    let live = true;
    let stop: (() => void) | undefined;
    // An app that connects, or an answer given in another window, changes the list.
    void connectedApps.onPending(() => void reload()).then((remove) => (live ? (stop = remove) : remove()));
    return () => {
      live = false;
      stop?.();
    };
  }, [connectedApps, platform, reload]);

  const change = async (run: () => Promise<Settings>) => {
    setFailure(null);
    try {
      setSettings(await run());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      void reload();
    }
  };

  const section = (body: React.ReactNode) => (
    <section aria-labelledby="set-connected-apps" className="set-section connected-apps" data-testid="connected-apps-settings">
      <h2 id="set-connected-apps">{t.title}</h2>
      <p className="muted">{t.intro}</p>
      {body}
    </section>
  );
  if (!settings) return section(null);
  if (!settings.available) return section(<p className="muted">{t.unavailable}</p>);

  const roots = [...new Set([connection.root, ...recent, ...settings.spaces])];
  const toggleSpace = (root: string, on: boolean) => {
    const spaces = on ? [...settings.spaces, root] : settings.spaces.filter((s) => s !== root);
    void change(() => connectedApps.configure({ spaces }));
  };
  const setup = settings.setup ? JSON.stringify({ mcpServers: { thoth: settings.setup } }, null, 2) : null;
  const copySetup = async () => {
    if (!setup) return;
    try {
      await copyText(setup);
      setCopy("done");
    } catch {
      setCopy("failed");
    }
  };

  return section(
    <>
      <div className="set-toggle">
        <input
          id="mcp-enabled"
          type="checkbox"
          role="switch"
          checked={settings.enabled}
          onChange={(e) => void change(() => connectedApps.configure({ enabled: e.target.checked }))}
          aria-describedby="mcp-enabled-hint"
        />
        <label htmlFor="mcp-enabled">{t.enable}</label>
        <small id="mcp-enabled-hint" className="muted">
          {t.enableHint}
        </small>
      </div>
      {settings.enabled && !settings.listening && settings.error && (
        <p role="alert" className="alert alert-danger">
          {t.notListening(settings.error)}
        </p>
      )}
      {failure && (
        <p role="alert" className="alert alert-danger">
          {failure}
        </p>
      )}

      <fieldset className="mcp-spaces">
        <legend>{t.spaces}</legend>
        <p className="muted small">{t.spacesHint}</p>
        {roots.map((root) => (
          <label key={root} className="mcp-space">
            <input type="checkbox" checked={settings.spaces.includes(root)} onChange={(e) => toggleSpace(root, e.target.checked)} />
            <span className="mcp-space-name">{folderName(root)}</span>
            <span className="mono muted small mcp-space-path" title={root}>
              {displayPath(root)}
            </span>
          </label>
        ))}
      </fieldset>

      <h3 id="set-mcp-apps">{t.apps}</h3>
      <p className="muted small">{t.selfReported}</p>
      {settings.apps.length === 0 && settings.pending.length === 0 ? (
        <p className="muted">{t.noApps}</p>
      ) : (
        <ul className="mcp-apps" aria-labelledby="set-mcp-apps">
          {settings.pending.map((name) => (
            <li key={`pending:${name}`} aria-label={name} className="mcp-app">
              <span className="mcp-app-name">{name}</span>
              <span className="badge">{t.waiting}</span>
            </li>
          ))}
          {settings.apps.map((app) => (
            <li key={app.name} aria-label={app.name} className="mcp-app">
              <span className="mcp-app-name">{app.name}</span>
              <span className={`badge ${app.allowed ? "badge-allowed" : "badge-denied"}`}>{app.allowed ? t.allowed : t.denied}</span>
              <span className="mcp-app-actions">
                <Button variant="ghost" small onClick={() => void change(() => connectedApps.decide(app.name, !app.allowed))}>
                  {app.allowed ? t.revoke : t.allow}
                </Button>
                <Button variant="quiet" small onClick={() => void change(() => connectedApps.forget(app.name))}>
                  {t.remove}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {setup && (
        <>
          <h3>{t.setup}</h3>
          <p className="muted small">{t.setupHint}</p>
          <pre className="mcp-setup mono" data-testid="mcp-setup" tabIndex={0}>
            {setup}
          </pre>
          <div className="set-actions">
            <Button variant="ghost" small onClick={() => void copySetup()}>
              {t.copySetup}
            </Button>
            <span role="status" className="muted">
              {copy === "done" ? t.copied : copy === "failed" ? t.copyFailed : ""}
            </span>
          </div>
        </>
      )}

      <h3>{t.log}</h3>
      <p className="muted small">{t.logHint}</p>
      <div className="set-actions">
        <Button variant="ghost" small onClick={() => void connectedApps.log().then(setLog, () => setLog([]))}>
          {log ? t.refreshLog : t.showLog}
        </Button>
      </div>
      {log && <RequestLog entries={log} />}
    </>,
  );
}

function RequestLog({ entries }: { entries: ConnectedAppsLogEntry[] }) {
  const t = useDesktopStrings().connectedApps;
  if (entries.length === 0) return <p className="muted">{t.noRequests}</p>;
  const when = (time: string) => {
    const date = new Date(time);
    return Number.isNaN(date.getTime()) ? time : t.when(date);
  };
  const tool = (name: string) => (t.tools as Record<string, string>)[name] ?? t.tools.unknown;
  const result = (entry: ConnectedAppsLogEntry) => (entry.ok ? t.answered : ((t.refused as Record<string, string>)[entry.error ?? ""] ?? t.failed(entry.error ?? "?")));
  return (
    <div className="mcp-log-wrap">
      <table className="mcp-log" aria-label={t.logLabel}>
        <thead>
          <tr>
            <th scope="col">{t.columns.time}</th>
            <th scope="col">{t.columns.app}</th>
            <th scope="col">{t.columns.tool}</th>
            <th scope="col">{t.columns.pages}</th>
            <th scope="col">{t.columns.result}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={`${entry.time}-${i}`} data-ok={entry.ok}>
              <td className="mcp-log-time">{when(entry.time)}</td>
              <td>{entry.app}</td>
              <td>{tool(entry.tool)}</td>
              <td className="mcp-log-paths">
                {entry.paths.map((p) => (
                  <span key={p} className="mono">
                    {p}
                  </span>
                ))}
              </td>
              <td>{result(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
