/**
 * Settings → Thoth assistant (the Agent Hub as settings, ADR-0007): the agents (Claude Code and Codex: detection,
 * version, sign-in, Codex's sandbox, and how to fix each), permissions and default limits, the run history (with its
 * saved transcripts and diffs, retention and "Delete history now"), usage per agent per day, week or month, and the
 * mascot's own settings. Tasks are started from the mascot; nothing here runs an agent.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { BUDGET_CHOICES_USD, RETENTION_CHOICES_DAYS, TIME_LIMIT_MINUTES } from "@thoth/agent-core";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { MascotSettings } from "../mascot/MascotSettings.tsx";
import { History, Status } from "./parts.tsx";
import { AGENT_PROVIDERS, type AgentSettings as Settings } from "./settings.ts";
import type { AgentsService, AgentsState } from "./service.ts";
import { usageRows, usageTotals, type UsagePeriod, type UsageRow } from "./usage.ts";

function Providers({ state, agents }: { state: AgentsState; agents: AgentsService }) {
  const t = useDesktopStrings().agents;
  return (
    <section className="agents-sub" aria-labelledby="agents-providers-heading">
      <h3 id="agents-providers-heading">{t.providersHeading}</h3>
      <p className="muted">{t.providersLede}</p>
      <div className="agents-providers">
        {AGENT_PROVIDERS.map((id) => (
          <Status key={id} provider={id} status={state.statuses[id] ?? null} checking={state.checking} onCheck={() => void agents.detect()} />
        ))}
      </div>
      <p className="alert alert-warning agents-caution small" role="note">
        {t.providers.claude.caution} {t.providers.codex.caution}
      </p>
    </section>
  );
}

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange(next: boolean): void }) {
  return (
    <div className="set-toggle">
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={`${id}-hint`} />
      <label htmlFor={id}>{label}</label>
      <small id={`${id}-hint`} className="muted">
        {hint}
      </small>
    </div>
  );
}

function Permissions({ settings, agents }: { settings: Settings; agents: AgentsService }) {
  const all = useDesktopStrings().agents;
  const t = all.permissions;
  const f = all.form;
  const s = all.settings;
  return (
    <section className="agents-sub" aria-labelledby="agents-permissions-heading">
      <h3 id="agents-permissions-heading">{t.heading}</h3>
      <p className="muted">{t.lede}</p>
      <div className="set-toggles">
        <Toggle id="agents-allow-private" label={t.private} hint={t.privateHint} checked={settings.allowPrivate} onChange={(v) => agents.updateSettings({ allowPrivate: v })} />
        <Toggle id="agents-allow-whole" label={t.wholeSpace} hint={t.wholeSpaceHint} checked={settings.allowWholeSpace} onChange={(v) => agents.updateSettings({ allowWholeSpace: v })} />
        <Toggle id="agents-allow-workspace" label={t.workspace} hint={t.workspaceHint} checked={settings.allowWorkspace} onChange={(v) => agents.updateSettings({ allowWorkspace: v })} />
      </div>
      <fieldset className="agents-limits">
        <legend>{t.limits}</legend>
        <div className="xfer-grid">
          <label className="field">
            <span>{s.time}</span>
            <select className="input" value={settings.timeMinutes} onChange={(e) => agents.updateSettings({ timeMinutes: Number(e.target.value) })}>
              {TIME_LIMIT_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {f.timeOption(m)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{s.budget}</span>
            <select className="input" value={settings.budgetUsd === null ? "none" : String(settings.budgetUsd)} onChange={(e) => agents.updateSettings({ budgetUsd: e.target.value === "none" ? null : Number(e.target.value) })} aria-describedby="agents-codex-note">
              {BUDGET_CHOICES_USD.map((b) => (
                <option key={b} value={b}>
                  {f.budgetOption(b)}
                </option>
              ))}
              <option value="none">{f.noLimit}</option>
            </select>
          </label>
        </div>
        <p id="agents-codex-note" className="muted small">
          {t.codexNote}
        </p>
      </fieldset>
    </section>
  );
}

function RunHistory({ state, agents }: { state: AgentsState; agents: AgentsService }) {
  const { openAgentReview } = useSession();
  const t = useDesktopStrings().agents;
  const s = t.settings;
  const [confirming, setConfirming] = useState(false);
  const waiting = state.history.filter((r) => r.state === "review" && state.available[r.id]?.review).length;
  return (
    <>
      {state.recovered !== null && (
        <p role="status" className="alert alert-warning">
          {t.recovered(state.recovered)}{" "}
          <Button variant="quiet" small onClick={() => agents.dismissRecovered()}>
            {t.dismiss}
          </Button>
        </p>
      )}
      {waiting > 0 && state.phase === "idle" && (
        <p role="status" className="alert alert-warning" data-testid="agent-awaiting">
          {t.awaiting(waiting)}
        </p>
      )}
      {state.notice?.kind === "reviewGone" && (
        <p role="alert" className="alert alert-danger" data-testid="agent-notice" data-kind="reviewGone">
          {t.notice["reviewGone"] as string}
        </p>
      )}
      <History
        state={state}
        agents={agents}
        onReview={(id) =>
          void agents.reopenReview(id).then(() => {
            if (agents.getState().phase === "review") openAgentReview();
          })
        }
      />
      <section className="agents-sub agents-settings" aria-labelledby="agents-settings-heading">
        <h3 id="agents-settings-heading" className="sr-only">
          {s.heading}
        </h3>
        <div className="field">
          <label htmlFor="agents-retention">{s.retention}</label>
          <select id="agents-retention" className="input set-narrow" value={settings(state).retentionDays} onChange={(e) => agents.updateSettings({ retentionDays: Number(e.target.value) })} aria-describedby="agents-retention-hint">
            {RETENTION_CHOICES_DAYS.map((d) => (
              <option key={d} value={d}>
                {s.retentionOption(d)}
              </option>
            ))}
          </select>
          <small id="agents-retention-hint" className="muted">
            {s.retentionHint}
          </small>
        </div>
        <div className="set-actions">
          {confirming ? (
            <div role="group" aria-label={s.clear} className="agents-confirm">
              <span>{s.clearConfirm}</span>{" "}
              <Button
                variant="danger"
                small
                onClick={() => {
                  setConfirming(false);
                  void agents.clearHistory();
                }}
              >
                {s.clearYes}
              </Button>{" "}
              <Button variant="ghost" small onClick={() => setConfirming(false)}>
                {s.clearNo}
              </Button>
            </div>
          ) : (
            <Button variant="ghost" small onClick={() => setConfirming(true)}>
              {s.clear}
            </Button>
          )}
        </div>
        {state.cleared !== null && (
          <p role="status" className="muted" data-testid="agent-cleared">
            {s.cleared(state.cleared)}
          </p>
        )}
      </section>
    </>
  );
}

const settings = (state: AgentsState) => state.settings;

function label(row: UsageRow, period: UsagePeriod, lang: string | undefined, weekOf: (d: string) => string): string {
  const d = new Date(row.start);
  if (period === "month") return d.toLocaleDateString(lang, { month: "short", year: "numeric" });
  const day = d.toLocaleDateString(lang, { month: "short", day: "numeric" });
  return period === "week" ? weekOf(day) : day;
}

/** Runs per period as bars (Claude Code in the accent, Codex in ink), with the numbers in a table for screen readers and for exact values. */
function Usage({ state, now }: { state: AgentsState; now: () => number }) {
  const t = useDesktopStrings().agents.usage;
  const h = useDesktopStrings().agents.history;
  const [period, setPeriod] = useState<UsagePeriod>("day");
  const lang = typeof document !== "undefined" ? document.documentElement.lang || undefined : undefined;
  const rows = usageRows(state.history, period, now());
  const totals = usageTotals(rows);
  const peak = Math.max(1, ...rows.map((r) => r.claude.runs + r.codex.runs));
  const labels = rows.map((r) => label(r, period, lang, t.weekOf));
  const all = totals.runs + totals.codexRuns;
  const { providers } = useDesktopStrings().agents;
  const short = (row: UsageRow, i: number) => (period === "week" ? new Date(row.start).toLocaleDateString(lang, { month: "short", day: "numeric" }) : labels[i]!);
  return (
    <section className="agents-sub agents-usage" aria-labelledby="agents-usage-heading">
      <div className="agents-sub-head">
        <h3 id="agents-usage-heading">{t.heading}</h3>
        <label className="agents-inline-field">
          <span>{t.period}</span>
          <select className="input" value={period} onChange={(e) => setPeriod(e.target.value as UsagePeriod)}>
            {(["day", "week", "month"] as const).map((p) => (
              <option key={p} value={p}>
                {t.periods[p]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">{t.lede}</p>
      <ul className="agents-legend" aria-hidden="true">
        <li data-provider="claude">{providers.claude.name}</li>
        <li data-provider="codex">{providers.codex.name}</li>
      </ul>
      <div className="agents-chart" role="img" aria-label={t.chart(all, labels[0]!, labels[labels.length - 1]!)} data-testid="agent-usage-chart">
        {rows.map((row, i) => (
          <div key={row.key} className="agents-chart-col" data-runs={row.claude.runs + row.codex.runs}>
            <div className="agents-chart-bars">
              {row.codex.runs > 0 && <span className="agents-bar" data-provider="codex" style={{ height: `${(row.codex.runs / peak) * 100}%` }} />}
              {row.claude.runs > 0 && <span className="agents-bar" data-provider="claude" style={{ height: `${(row.claude.runs / peak) * 100}%` }} />}
            </div>
            <span className="agents-chart-label">{short(row, i)}</span>
          </div>
        ))}
      </div>
      {all === 0 && <p className="muted small">{t.none}</p>}
      <details className="agents-usage-table">
        <summary>{t.table}</summary>
        <div className="agents-table-wrap">
          <table className="agents-history-table">
            <thead>
              <tr>
                <th scope="col">{t.when}</th>
                <th scope="col" className="num">
                  {t.claudeRuns}
                </th>
                <th scope="col" className="num">
                  {t.cost}
                </th>
                <th scope="col" className="num">
                  {t.codexRuns}
                </th>
                <th scope="col" className="num">
                  {t.tokens}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.key}>
                  <th scope="row">{labels[i]}</th>
                  <td className="num">{row.claude.runs}</td>
                  <td className="num">{row.claude.runs > 0 ? h.costOf(row.claude.costUsd) : "–"}</td>
                  <td className="num">{row.codex.runs}</td>
                  <td className="num">{row.codex.runs > 0 ? row.codex.tokens.toLocaleString(lang) : "–"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t.total}</th>
                <td className="num">{totals.runs}</td>
                <td className="num">{totals.runs > 0 ? h.costOf(totals.costUsd) : "–"}</td>
                <td className="num">{totals.codexRuns}</td>
                <td className="num">{totals.codexRuns > 0 ? totals.tokens.toLocaleString(lang) : "–"}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </details>
    </section>
  );
}

function Body({ agents, focus }: { agents: AgentsService; focus: boolean }) {
  const t = useDesktopStrings().agents;
  const { options } = useSession();
  const state = useSyncExternalStore(agents.subscribe, agents.getState);
  useEffect(() => {
    if (!agents.getState().status && !agents.getState().checking) void agents.detect();
  }, [agents]);
  useEffect(() => {
    if (focus) document.getElementById("set-agents")?.scrollIntoView({ block: "start" });
  }, [focus]);
  return (
    <section aria-labelledby="set-agents" className="set-section agents" data-testid="assistant-settings">
      <h2 id="set-agents">{t.title}</h2>
      <p className="muted">{t.lede}</p>
      <Providers state={state} agents={agents} />
      <Permissions settings={state.settings} agents={agents} />
      <RunHistory state={state} agents={agents} />
      <Usage state={state} now={() => options.now().getTime()} />
      <MascotSettings />
    </section>
  );
}

/** The section; nothing where the host cannot run agent CLIs (the web client, a test host without agents). */
export function AgentSettings({ focus = false }: { focus?: boolean }) {
  const { agents } = useSession();
  if (!agents) return null;
  return <Body agents={agents} focus={focus} />;
}
