/**
 * The Agent Hub tab (spec 3.3, ADR-0007): whether Claude Code can be used and how to fix it, a task with its context
 * and limits, the live transcript with Cancel, the review of proposed changes, the result, earlier runs (date, task,
 * model, cost, outcome; their transcript and changes open from local details) and the Agent Hub's settings.
 * Agent output is shown as plain text.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentEvent, AgentInstallationStatus, RunRecord } from "@thoth/agent-core";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Notice } from "@thoth/app-ui/ui/Notice.tsx";
import { conflictCopyPath } from "@thoth/app-ui/editor/page-session.ts";
import { isMarkdownPath } from "@thoth/domain";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings, type DesktopStrings } from "../../strings/index.ts";
import { BUDGET_CHOICES_USD, RETENTION_CHOICES_DAYS, TIME_LIMIT_MINUTES } from "@thoth/agent-core";
import { ContextPicker } from "./ContextPicker.tsx";
import { DiffView, Review } from "./Review.tsx";
import type { AgentsService, AgentsState } from "./service.ts";
import "./agents.css";

type T = DesktopStrings["agents"];

function Status({ status, checking, onCheck }: { status: AgentInstallationStatus | null; checking: boolean; onCheck(): void }) {
  const t = useDesktopStrings().agents.status;
  let body: { text: string; fix?: string; list?: string[]; listLabel?: string; ok?: boolean };
  if (!status || checking) body = { text: t.checking };
  else
    switch (status.state) {
      case "ready":
        body = { text: t.ready(status.version), ok: true };
        break;
      case "missing":
        body = { text: t.missing, fix: t.missingFix, list: status.searched, listLabel: t.searched };
        break;
      case "too_old":
        body = { text: t.tooOld(status.version, status.minimum), fix: t.tooOldFix };
        break;
      case "unsupported":
        body = { text: t.unsupported(status.version), fix: t.unsupportedFix, list: status.missingFlags };
        break;
      case "not_logged_in":
        body = { text: t.notLoggedIn, fix: t.notLoggedInFix };
        break;
      case "error":
        body = { text: t.error(status.message) };
        break;
    }
  return (
    <section className="set-section agents-status" aria-labelledby="agents-status-heading" aria-busy={checking || !status}>
      <h2 id="agents-status-heading">{t.heading}</h2>
      <p role="status" data-testid="agent-status" data-state={checking || !status ? "checking" : status.state} className={body.ok ? "agents-ready" : undefined}>
        {body.text}
      </p>
      {body.list && body.list.length > 0 && (
        <div className="small">
          {body.listLabel && <p className="muted">{body.listLabel}</p>}
          <ul className="xfer-list mono">
            {body.list.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {body.fix && <p className="muted">{body.fix}</p>}
      {status && !body.ok && (
        <div className="set-actions">
          <Button variant="ghost" small onClick={onCheck} disabled={checking}>
            {t.check}
          </Button>
        </div>
      )}
    </section>
  );
}

const usd = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

function TaskForm({ state, agents }: { state: AgentsState; agents: AgentsService }) {
  const t = useDesktopStrings().agents.form;
  const notices = useDesktopStrings().agents.notice;
  const [tried, setTried] = useState(false);
  const problems = agents.draftProblems();
  const ready = state.status?.state === "ready";
  const busy = state.phase === "starting";
  const { settings, draft } = state;
  const start = () => {
    setTried(true);
    if (problems.length === 0) void agents.start();
  };
  const defaultTime = t.timeOption(settings.timeMinutes);
  const defaultBudget = settings.budgetUsd === null ? t.noLimit : t.budgetOption(settings.budgetUsd);
  const notice = state.notice;
  const noticeText = (() => {
    if (!notice) return null;
    if (notice.kind === "reviewGone") return notices["reviewGone"] as string;
    const entry = notices[notice.refusal];
    return typeof entry === "function" ? entry(notice.workspace) : (entry ?? null);
  })();
  return (
    <section className="set-section agents-form" aria-labelledby="agents-form-heading">
      <h2 id="agents-form-heading">{t.heading}</h2>
      <ContextPicker state={state} agents={agents} disabled={busy} />
      <label className="field">
        <span>{t.task}</span>
        <textarea className="input agents-task" rows={4} value={draft.prompt} placeholder={t.taskHint} onChange={(e) => agents.setDraft({ prompt: e.target.value })} disabled={busy} />
      </label>
      <div className="xfer-grid">
        <label className="field">
          <span>{t.model}</span>
          <input className="input" value={draft.model} list="agents-models" onChange={(e) => agents.setDraft({ model: e.target.value })} disabled={busy} aria-describedby="agents-model-hint" spellCheck={false} autoCapitalize="off" />
          <datalist id="agents-models">
            <option value="sonnet" />
            <option value="opus" />
            <option value="haiku" />
          </datalist>
          <small id="agents-model-hint" className="muted">
            {t.modelHint}
          </small>
        </label>
      </div>
      <fieldset className="agents-limits" disabled={busy}>
        <legend>{t.limits}</legend>
        <div className="xfer-grid">
          <label className="field">
            <span>{t.timeLimit}</span>
            <select className="input" value={String(draft.timeMinutes)} onChange={(e) => agents.setDraft({ timeMinutes: e.target.value === "default" ? "default" : Number(e.target.value) })}>
              <option value="default">{t.useDefault(defaultTime)}</option>
              {TIME_LIMIT_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {t.timeOption(m)}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <label htmlFor="agents-budget">{t.budget}</label>
            <select id="agents-budget" className="input" value={String(draft.budget)} onChange={(e) => agents.setDraft({ budget: e.target.value === "default" ? "default" : e.target.value === "none" ? "none" : Number(e.target.value) })} aria-describedby="agents-budget-hint">
              <option value="default">{t.useDefault(defaultBudget)}</option>
              {BUDGET_CHOICES_USD.map((b) => (
                <option key={b} value={b}>
                  {t.budgetOption(b)}
                </option>
              ))}
              <option value="none">{t.noLimit}</option>
            </select>
            <small id="agents-budget-hint" className="muted">
              {t.budgetHint}
            </small>
          </div>
        </div>
      </fieldset>
      {tried && problems.length > 0 && (
        <ul role="alert" className="alert alert-danger agents-problems">
          {problems.map((p) => (
            <li key={p}>{t[p]}</li>
          ))}
        </ul>
      )}
      {noticeText && (
        <p role="alert" className="alert alert-danger" data-testid="agent-notice" data-kind={notice?.kind === "refused" ? notice.refusal : notice?.kind}>
          {noticeText}
        </p>
      )}
      {state.error && (
        <p role="alert" className="alert alert-danger">
          {state.error}
        </p>
      )}
      <div className="set-actions">
        <Button variant="primary" onClick={start} disabled={!ready || busy}>
          {busy ? t.starting : t.start}
        </Button>
      </div>
    </section>
  );
}

function EventLine({ event, t }: { event: AgentEvent; t: T["run"] }) {
  switch (event.type) {
    case "session":
      return <li className="muted">{t.session(event.model ?? "Claude Code")}</li>;
    case "text":
      return <li className="agents-text">{event.text}</li>;
    case "tool":
      return (
        <li className="agents-tool">
          <span>{t.tool[event.tool] ?? event.tool}</span> {event.target && <span className="mono">{event.target}</span>}
        </li>
      );
    case "denied":
      return (
        <li className="agents-denied">
          {t.denied(event.tool)} <span className="muted">{event.message}</span>
        </li>
      );
    case "tool_error":
      return (
        <li className="muted">
          {t.toolError}: {event.message}
        </li>
      );
    case "retry":
      return <li className="muted">{t.retry(event.attempt)}</li>;
    case "result":
      return event.costUsd !== undefined ? <li className="muted">{t.cost(event.costUsd.toFixed(4))}</li> : null;
    case "error":
      return (
        <li className="agents-error">
          {t.errors[event.code] ?? t.errors["cli"]} {event.code === "cli" && <span>{event.message}</span>}
        </li>
      );
    default:
      return null;
  }
}

/** A run that stopped at its time limit or used up its budget says so, whatever else happened. */
function StoppedNotice({ record, t }: { record: RunRecord; t: T["run"] }) {
  const stopped = record.outcome?.stoppedBy;
  if (!stopped) return null;
  const minutes = record.task.timeoutMs === undefined ? null : Math.round(record.task.timeoutMs / 60_000);
  return (
    <p className="alert alert-warning" role="status" data-testid="agent-stopped" data-stopped={stopped}>
      {stopped === "time" ? t.stoppedTime(minutes) : t.stoppedBudget(record.task.maxBudgetUsd ?? null)}
    </p>
  );
}

function Outcome({ record, t }: { record: RunRecord; t: T["run"] }) {
  if (record.state === "cancelled") return <p className="alert">{t.cancelled}</p>;
  if (record.state === "done") return <p className="alert">{t.noChanges}</p>;
  if (record.state !== "failed" || record.outcome?.stoppedBy) return null;
  const error = record.outcome?.error;
  return (
    <div className="alert alert-danger">
      <p>{t.failed}</p>
      {error && (
        <p>
          {t.errors[error.code] ?? t.errors["cli"]} {(error.code === "cli" || error.code === "spawn" || error.code === "review") && error.message}
        </p>
      )}
    </div>
  );
}

function RunPanel({ state, agents }: { state: AgentsState; agents: AgentsService }) {
  const t = useDesktopStrings().agents.run;
  const shown = state.events.filter((e) => e.type !== "log" && e.type !== "exit");
  const logs = state.events.filter((e): e is Extract<AgentEvent, { type: "log" }> => e.type === "log");
  const live = state.phase === "starting" || state.phase === "running" || state.phase === "cancelling";
  return (
    <section className="set-section agents-run" aria-labelledby="agents-run-heading" aria-busy={live}>
      <h2 id="agents-run-heading">{t.heading}</h2>
      {state.record && <p className="agents-prompt">{state.record.task.prompt}</p>}
      {live && (
        <p role="status" className="muted">
          {state.phase === "cancelling" ? t.cancelling : t.working}
        </p>
      )}
      {/* The log role goes on a wrapper: on the list itself it would take away the list's semantics. */}
      <div role="log" aria-label={t.transcript} aria-live="polite">
        <ol className="agents-log">
          {shown.map((event, i) => (
            <EventLine key={i} event={event} t={t} />
          ))}
        </ol>
      </div>
      {logs.length > 0 && (
        <details className="agents-stderr">
          <summary>Claude Code ({logs.length})</summary>
          <pre className="mono">{logs.map((l) => l.text).join("\n")}</pre>
        </details>
      )}
      {(state.phase === "running" || state.phase === "cancelling") && (
        <div className="set-actions">
          <Button variant="danger" onClick={() => void agents.cancel()} disabled={state.phase === "cancelling"}>
            {state.phase === "cancelling" ? t.cancelling : t.cancel}
          </Button>
        </div>
      )}
      {(state.phase === "finished" || state.phase === "review" || state.phase === "applying") && state.record && <StoppedNotice record={state.record} t={t} />}
      {state.phase === "finished" && state.record && <Outcome record={state.record} t={t} />}
    </section>
  );
}

function Results({ state, agents, focus }: { state: AgentsState; agents: AgentsService; focus: boolean }) {
  const { openPage, options } = useSession();
  const t = useDesktopStrings().agents.applied;
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  const record = state.record!;
  const discarded = record.state === "discarded";
  return (
    <section className="set-section agents-results" aria-labelledby="agents-results-heading">
      <h2 id="agents-results-heading" ref={ref} tabIndex={-1}>
        {t.heading}
      </h2>
      {discarded ? (
        <p role="status">{t.discarded}</p>
      ) : (
        record.changes.length > 0 && (
          <ul className="agents-changes">
            {record.changes.map((c) => (
              <li key={c.path} className="agents-change" data-result={c.result ?? "rejected"}>
                <b className="mono agents-path">{c.path}</b>
                <span>
                  {c.problem === "read_only"
                    ? t.readOnly
                    : c.result === "applied"
                    ? t.applied
                    : c.result === "conflict"
                      ? t.conflict
                      : c.result === "copied"
                        ? t.copied(c.copy ?? "")
                        : c.result === "failed"
                          ? t.failed(c.error ?? "")
                          : t.rejected}
                </span>
                <span className="set-actions">
                  {c.result === "conflict" && c.change !== "deleted" && (
                    <Button variant="ghost" small onClick={() => void agents.saveCopy(c.path, (n) => conflictCopyPath(c.path, options.now(), n))}>
                      {t.keepCopy}
                    </Button>
                  )}
                  {c.result === "applied" && c.change !== "deleted" && isMarkdownPath(c.path) && (
                    <Button variant="quiet" small onClick={() => openPage(c.path)}>
                      {t.open(c.path)}
                    </Button>
                  )}
                  {c.result === "copied" && c.copy && isMarkdownPath(c.copy) && (
                    <Button variant="quiet" small onClick={() => openPage(c.copy!)}>
                      {t.open(c.copy)}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )
      )}
      {state.error && (
        <p role="alert" className="alert alert-danger">
          {state.error}
        </p>
      )}
    </section>
  );
}

function eventLines(events: readonly AgentEvent[], t: T["run"]) {
  return events.filter((e) => e.type !== "log" && e.type !== "exit").map((event, i) => <EventLine key={i} event={event} t={t} />);
}

function outcomeLabel(r: RunRecord, t: T["history"]): string {
  if (r.outcome?.stoppedBy === "time") return t.stoppedTime;
  if (r.outcome?.stoppedBy === "budget") return t.stoppedBudget;
  return t.states[r.state] ?? r.state;
}

function HistoryDetail({ agents, detail }: { agents: AgentsService; detail: NonNullable<AgentsState["detail"]> }) {
  const t = useDesktopStrings().agents;
  const { record, details, loading } = detail;
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <section className="set-section agents-detail" aria-labelledby="agents-detail-heading" aria-busy={loading}>
      <h3 id="agents-detail-heading" ref={ref} tabIndex={-1}>
        {t.history.detailsHeading}
      </h3>
      <p className="agents-prompt">{record.task.prompt}</p>
      <p className="muted small">{t.history.localOnly}</p>
      {loading ? (
        <p role="status" className="muted">
          {t.history.loading}
        </p>
      ) : !details ? (
        <p className="muted">{t.history.noDetails}</p>
      ) : (
        <>
          <h4>{t.history.transcript}</h4>
          <div role="log" aria-label={t.history.transcript}>
            <ol className="agents-log">{eventLines(details.events, t.run)}</ol>
          </div>
          <h4>{t.history.changes}</h4>
          {details.changes === null ? (
            <p className="muted">{t.history.noReview}</p>
          ) : details.changes.length === 0 ? (
            <p className="muted">{t.history.noChanges}</p>
          ) : (
            <ul className="agents-changes">
              {details.changes.map((c) => {
                const recorded = record.changes.find((r) => r.path === c.path);
                return (
                  <li key={c.path} className="agents-change" data-change={c.change} data-problem={c.problem}>
                    <div className="agents-change-head">
                      <b className="mono agents-path">{c.path}</b>
                      <span className="badge badge-muted">{t.review.kinds[c.change]}</span>
                      {recorded?.result === "applied" && <span className="badge badge-muted">{t.applied.applied}</span>}
                    </div>
                    {c.problem ? (
                      <p className={c.problem === "read_only" ? "alert alert-warning small" : "alert alert-danger small"} role="note">
                        {t.review.problems[c.problem] ?? c.problem}
                      </p>
                    ) : c.omitted ? (
                      <p className="muted small">{t.history.omitted}</p>
                    ) : c.page ? (
                      <>
                        {c.change === "modified" && c.original === null && <p className="muted small">{t.history.noOriginal}</p>}
                        <DiffView path={c.path} before={c.original} after={c.after} />
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <div className="set-actions">
        <Button variant="ghost" small onClick={() => agents.closeDetails()}>
          {t.history.closeDetails}
        </Button>
      </div>
    </section>
  );
}

function History({ state, agents }: { state: AgentsState; agents: AgentsService }) {
  const t = useDesktopStrings().agents.history;
  const { history, available, phase } = state;
  const idle = phase === "idle" || phase === "finished";
  return (
    <section className="set-section agents-history" aria-labelledby="agents-history-heading">
      <h2 id="agents-history-heading">{t.heading}</h2>
      {history.length === 0 ? (
        <p className="muted">{t.empty}</p>
      ) : (
        <table className="agents-history-table">
          <thead>
            <tr>
              <th scope="col">{t.date}</th>
              <th scope="col">{t.task}</th>
              <th scope="col">{t.model}</th>
              <th scope="col">{t.cost}</th>
              <th scope="col">{t.outcome}</th>
              <th scope="col">
                <span className="sr-only">{t.openDetails}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {history.map((r) => {
              const here = available[r.id];
              return (
                <tr key={r.id} data-state={r.state}>
                  <td>
                    <time dateTime={new Date(r.createdAt).toISOString()}>{new Date(r.createdAt).toLocaleString()}</time>
                  </td>
                  <td className="agents-history-task" title={r.task.prompt}>
                    {r.task.prompt.split("\n")[0]!.slice(0, 120)}
                  </td>
                  <td className="mono small">{r.outcome?.model ?? r.task.model ?? t.defaultModel}</td>
                  <td className="small">{r.outcome?.costUsd === undefined ? t.noCost : t.costOf(r.outcome.costUsd)}</td>
                  <td>
                    <span className="badge badge-muted" data-state={r.state} data-stopped={r.outcome?.stoppedBy}>
                      {outcomeLabel(r, t)}
                    </span>
                  </td>
                  <td className="agents-history-actions">
                    {r.state === "review" && here?.review && idle && (
                      <Button variant="primary" small onClick={() => void agents.reopenReview(r.id)} aria-label={`${t.reviewAgain}: ${r.task.prompt.split("\n")[0]!.slice(0, 60)}`}>
                        {t.reviewAgain}
                      </Button>
                    )}
                    {(here?.transcript || here?.review) && (
                      <Button variant="quiet" small onClick={() => void agents.openDetails(r.id)} aria-label={`${t.openDetails}: ${r.task.prompt.split("\n")[0]!.slice(0, 60)}`}>
                        {t.openDetails}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {state.detail && <HistoryDetail agents={agents} detail={state.detail} />}
    </section>
  );
}

function Settings({ state, agents }: { state: AgentsState; agents: AgentsService }) {
  const t = useDesktopStrings().agents;
  const f = t.form;
  const s = t.settings;
  const { settings } = state;
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="set-section agents-settings" aria-labelledby="agents-settings-heading">
      <h2 id="agents-settings-heading">{s.heading}</h2>
      <p className="muted">{s.lede}</p>
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
          <select className="input" value={settings.budgetUsd === null ? "none" : String(settings.budgetUsd)} onChange={(e) => agents.updateSettings({ budgetUsd: e.target.value === "none" ? null : Number(e.target.value) })}>
            {BUDGET_CHOICES_USD.map((b) => (
              <option key={b} value={b}>
                {f.budgetOption(b)}
              </option>
            ))}
            <option value="none">{f.noLimit}</option>
          </select>
        </label>
        <div className="field">
          <label htmlFor="agents-retention">{s.retention}</label>
          <select id="agents-retention" className="input" value={settings.retentionDays} onChange={(e) => agents.updateSettings({ retentionDays: Number(e.target.value) })} aria-describedby="agents-retention-hint">
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
          <Button variant="ghost" onClick={() => setConfirming(true)}>
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
  );
}

function Body({ agents }: { agents: AgentsService }) {
  const t = useDesktopStrings().agents;
  const state = useSyncExternalStore(agents.subscribe, agents.getState);
  useEffect(() => {
    if (!agents.getState().status && !agents.getState().checking) void agents.detect();
  }, [agents]);
  const showRun = state.phase !== "idle";
  // Runs that were waiting for review when Thoth closed and can be opened again.
  const waiting = state.history.filter((r) => r.state === "review" && state.available[r.id]?.review).length;
  const finished = state.phase === "finished" && state.record !== null;
  return (
    <div className="page-scroll">
      <div className="page-col settings agents">
        <h1 className="page-title">{t.title}</h1>
        <p className="muted">{t.lede}</p>
        <p className="alert alert-warning agents-caution" role="note">
          {t.caution}
        </p>
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
        <Status status={state.status} checking={state.checking} onCheck={() => void agents.detect()} />
        {!showRun && <TaskForm state={state} agents={agents} />}
        {showRun && <RunPanel state={state} agents={agents} />}
        {(state.phase === "review" || state.phase === "applying") && state.changes && (
          <Review changes={state.changes} approved={state.approved} busy={state.phase === "applying"} onApproved={(paths) => agents.setApproved(paths)} onApply={() => void agents.apply()} onDiscard={() => void agents.discard()} />
        )}
        {state.phase === "review" && state.error && (
          <p role="alert" className="alert alert-danger">
            {state.error}
          </p>
        )}
        {finished && state.results !== null && <Results state={state} agents={agents} focus={finished} />}
        {finished && (
          <div className="set-actions">
            <Button variant="primary" onClick={() => void agents.newTask()}>
              {t.applied.newTask}
            </Button>
          </div>
        )}
        <History state={state} agents={agents} />
        <Settings state={state} agents={agents} />
      </div>
    </div>
  );
}

export function AgentHubView() {
  const { agents } = useSession();
  const t = useDesktopStrings().agents;
  if (!agents) return <Notice title={t.title} detail={t.unavailable} />;
  return <Body agents={agents} />;
}
