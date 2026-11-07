import { useCallback, useEffect, useState } from "react";
import type { ConnectedApps, ConnectedAppsLogEntry, ConnectedAppsSettings as Settings, SetupApp } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { copyText } from "@thoth/app-ui/editor/link-cards.ts";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { displayPath } from "../settings/path.ts";
import { folderName } from "./names.ts";
import "./connected-apps.css";

/**
 * The one-time "copy the setup again" notice (ADR-0031): the identifier change moved the socket the setup names, so an
 * app set up before stops connecting. Webview storage starts empty after that change, so the notice shows to whoever
 * has apps on record when first looking here, until they dismiss it or copy the setup. Someone with no apps the first
 * time they look is marked as having seen it: any app they set up later uses the setup shown now.
 */
export const SETUP_NOTICE_KEY = "thoth.desktop.connectedApps.setupNoticeSeen";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage can be disabled; the notice then shows each time until dismissed
  }
}

const noticeSeen = () => storage()?.getItem(SETUP_NOTICE_KEY) === "1";
function markNoticeSeen() {
  try {
    storage()?.setItem(SETUP_NOTICE_KEY, "1");
  } catch {
    // full or disabled storage: shown again next time
  }
}

/**
 * Settings → Connected apps (ADR-0021): the switch (off by default), which Private Spaces apps may read (each ticked
 * on purpose), the apps that connected with the user's Allow or Deny, the setup to paste into an app, and the request
 * log. An app's name is the one it gave; the section says so.
 */
export function ConnectedAppsSettings({ connectedApps }: { connectedApps: ConnectedApps }) {
  const { platform, connection, openMemories } = useSession();
  const t = useDesktopStrings().connectedApps;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const [log, setLog] = useState<ConnectedAppsLogEntry[] | null>(null);
  const [notice, setNotice] = useState<boolean | null>(null);

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

  // Decided once, from the first settings seen.
  useEffect(() => {
    if (!settings || notice !== null) return;
    const show = !noticeSeen() && settings.apps.length > 0;
    if (!show) markNoticeSeen();
    setNotice(show);
  }, [settings, notice]);
  const dismissNotice = () => {
    markNoticeSeen();
    setNotice(false);
  };

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
      dismissNotice();
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
      {notice && setup && (
        <div role="note" aria-labelledby="mcp-setup-moved" className="alert alert-warning mcp-setup-moved">
          <p id="mcp-setup-moved">
            <strong>{t.setupMoved.title}</strong>
          </p>
          <p>{t.setupMoved.body}</p>
          <div className="set-actions">
            <Button variant="ghost" small onClick={dismissNotice}>
              {t.setupMoved.dismiss}
            </Button>
          </div>
        </div>
      )}
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
            {settings.spaces.includes(root) && settings.memoryFolders?.[root] && <span className="muted small mcp-space-memory">{t.memoryFolder(settings.memoryFolders[root])}</span>}
          </label>
        ))}
      </fieldset>

      {/* ADR-0052 rule 5: on by default; off, every memory waits for review as a proposal. */}
      <div className="set-toggle">
        <input
          id="mcp-memories"
          type="checkbox"
          role="switch"
          checked={settings.memories !== false}
          onChange={(e) => void change(() => connectedApps.configure({ memories: e.target.checked }))}
          aria-describedby="mcp-memories-hint"
        />
        <label htmlFor="mcp-memories">{t.memories}</label>
        <small id="mcp-memories-hint" className="muted">
          {t.memoriesHint}
        </small>
      </div>
      <div className="set-actions">
        <Button variant="ghost" small onClick={openMemories}>
          {t.memoriesView.open}
        </Button>
      </div>

      <SkillLinks connectedApps={connectedApps} on={settings.skillLinks?.includes(connection.root) ?? false} onChange={() => void reload()} />

      <h3 id="set-mcp-apps">{t.apps}</h3>
      <p className="muted small">{t.selfReported}</p>
      <p id="mcp-propose-hint" className="muted small">
        {t.mayProposeHint}
      </p>
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
          {settings.apps.map((app, i) => (
            <li key={app.name} aria-label={app.name} className="mcp-app">
              <span className="mcp-app-name">{app.name}</span>
              <span className={`badge ${app.allowed ? "badge-allowed" : "badge-denied"}`}>{app.allowed ? t.allowed : t.denied}</span>
              {app.allowed && (
                <span className="set-toggle mcp-app-propose">
                  {/* ADR-0048: off until the user turns it on; each change still waits for review. */}
                  <input
                    id={`mcp-propose-${i}`}
                    type="checkbox"
                    role="switch"
                    checked={app.propose === true}
                    onChange={(e) => void change(() => connectedApps.mayPropose(app.name, e.target.checked))}
                    aria-describedby="mcp-propose-hint"
                  />
                  <label htmlFor={`mcp-propose-${i}`}>{t.mayPropose}</label>
                  {settings.proposers.includes(app.name) && <span className="badge">{t.waiting}</span>}
                </span>
              )}
              {app.allowed && settings.memories !== false && (
                <span className="set-toggle mcp-app-propose">
                  <input
                    id={`mcp-remember-${i}`}
                    type="checkbox"
                    role="switch"
                    checked={app.remember !== false}
                    onChange={(e) => void change(() => connectedApps.mayRemember(app.name, e.target.checked))}
                    aria-describedby="mcp-memories-hint"
                  />
                  <label htmlFor={`mcp-remember-${i}`}>{t.mayRemember}</label>
                </span>
              )}
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
          {settings.setup && <SetupCards connectedApps={connectedApps} setup={settings.setup} />}
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

/**
 * "Use this Private Space's skills in Claude Code and Codex" (ADR-0052 rule 7): the host links each `Skills/<name>`
 * folder into the home folder's skills folders, never over anything there, and says what it linked.
 */
function SkillLinks({ connectedApps, on, onChange }: { connectedApps: ConnectedApps; on: boolean; onChange(): void }) {
  const { connection } = useSession();
  const t = useDesktopStrings().connectedApps.skills;
  const [said, setSaid] = useState<{ text: string; alert?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const turn = async (next: boolean) => {
    setBusy(true);
    try {
      const report = await connectedApps.skillLinks(connection.root, next);
      setSaid({ text: report.on ? [t.linked(report.linked), report.skipped.length > 0 ? t.skipped(report.skipped) : ""].filter(Boolean).join(" ") : t.off });
    } catch (error) {
      setSaid({ text: t.failed(error instanceof Error ? error.message : String(error)), alert: true });
    } finally {
      setBusy(false);
      onChange();
    }
  };
  return (
    <>
      <h3 id="set-mcp-skills">{t.title}</h3>
      <div className="set-toggle">
        <input id="mcp-skill-links" type="checkbox" role="switch" checked={on} disabled={busy} onChange={(e) => void turn(e.target.checked)} aria-describedby="mcp-skill-links-hint" />
        <label htmlFor="mcp-skill-links">{t.toggle}</label>
        <small id="mcp-skill-links-hint" className="muted">
          {t.hint}
        </small>
      </div>
      <p role="status" className="muted small">
        {said && !said.alert ? said.text : ""}
      </p>
      {said?.alert && (
        <p role="alert" className="alert alert-danger small">
          {said.text}
        </p>
      )}
    </>
  );
}

const SETUP_APPS: SetupApp[] = ["claude-code", "codex", "claude-desktop", "cursor"];

/** A word for a POSIX shell: as it is when it is safe, else in single quotes. */
const shellWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

/**
 * Set up an app (ADR-0052 rule 10): one card per app, each saying what it changes; the host edits the app's own
 * settings (backing up the file first) or runs Claude Code's own command. A `thoth` server already there is replaced
 * only when the user says so. Any other agent gets a prompt to copy.
 */
function SetupCards({ connectedApps, setup }: { connectedApps: ConnectedApps; setup: { command: string; args: string[] } }) {
  const t = useDesktopStrings().connectedApps.cards;
  const [said, setSaid] = useState<Partial<Record<SetupApp | "other", { text: string; alert?: boolean; replace?: boolean }>>>({});
  const [busy, setBusy] = useState<SetupApp | null>(null);
  const command = ["claude", "mcp", "add", "--scope", "user", "thoth", "--", setup.command, ...setup.args].map(shellWord).join(" ");
  const say = (app: SetupApp | "other", text: string, more: { alert?: boolean; replace?: boolean } = {}) => setSaid((s) => ({ ...s, [app]: { text, ...more } }));
  const run = async (app: SetupApp, replace = false) => {
    const name = t.apps[app].name;
    setBusy(app);
    try {
      const done = await connectedApps.install(app, replace);
      const text = done.status === "already" ? t.already(name) : done.status === "replaced" ? t.replaced(name) : t.added(name);
      say(app, done.backup ? `${text} ${t.backup(done.backup)}` : text);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "EEXIST") say(app, t.exists(name), { replace: true });
      else if (code === "UNAVAILABLE") say(app, t.notThere(name), { alert: true });
      else say(app, t.failed(error instanceof Error ? error.message : String(error)), { alert: true });
    } finally {
      setBusy(null);
    }
  };
  const copy = (key: SetupApp | "other", text: string) =>
    void copyText(text).then(
      () => say(key, t.copied),
      () => say(key, t.failed(""), { alert: true }),
    );
  const result = (key: SetupApp | "other") => {
    const r = said[key];
    return (
      <>
        <p role="status" className="muted small">
          {r && !r.alert ? r.text : ""}
        </p>
        {r?.alert && (
          <p role="alert" className="alert alert-danger small">
            {r.text}
          </p>
        )}
      </>
    );
  };
  return (
    <>
      <p className="muted small">{t.lede}</p>
      <ul className="mcp-cards" data-testid="mcp-setup-cards">
        {SETUP_APPS.map((app) => (
          <li key={app} className="mcp-card" aria-labelledby={`mcp-card-${app}`}>
            <b id={`mcp-card-${app}`}>{t.apps[app].name}</b>
            <span className="muted small">{t.apps[app].what}</span>
            <div className="set-actions">
              <Button variant="primary" small disabled={busy !== null} onClick={() => void run(app)} aria-describedby={`mcp-card-${app}`}>
                {t.setUp}
              </Button>
              {said[app]?.replace && (
                <Button variant="ghost" small disabled={busy !== null} onClick={() => void run(app, true)}>
                  {t.replace}
                </Button>
              )}
              {app === "claude-code" && (
                <Button variant="ghost" small onClick={() => copy(app, command)}>
                  {t.copyCommand}
                </Button>
              )}
            </div>
            {result(app)}
          </li>
        ))}
        <li className="mcp-card" aria-labelledby="mcp-card-other">
          <b id="mcp-card-other">{t.other}</b>
          <span className="muted small">{t.otherWhat}</span>
          <div className="set-actions">
            <Button variant="ghost" small onClick={() => copy("other", t.otherPrompt)}>
              {t.copyPrompt}
            </Button>
          </div>
          {result("other")}
        </li>
      </ul>
    </>
  );
}
