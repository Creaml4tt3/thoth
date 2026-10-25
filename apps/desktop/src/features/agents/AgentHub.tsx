/**
 * The Agent Hub tab (spec 3.3, ADR-0007): whether Claude Code can be used and how to fix it, a task with its pages,
 * the live transcript with Cancel, the review of proposed changes, the result, and earlier runs (metadata only).
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
import { ContextPicker } from "./ContextPicker.tsx";
import { Review } from "./Review.tsx";
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

function TaskForm({ state, agents }: { state: AgentsState; agents: AgentsService }) {
  const t = useDesktopStrings().agents.form;
  const [tried, setTried] = useState(false);
  const problems = agents.draftProblems();
  const ready = state.status?.state === "ready";
  const busy = state.phase === "starting";
  const start = () => {
    setTried(true);
    if (problems.length === 0) void agents.start();
  };
  return (
    <section className="set-section agents-form" aria-labelledby="agents-form-heading">
      <h2 id="agents-form-heading">{t.heading}</h2>
      <ContextPicker selection={state.draft.selection} onChange={(selection) => agents.setDraft({ selection })} disabled={busy} />
      <label className="field">
        <span>{t.task}</span>
        <textarea className="input agents-task" rows={4} value={state.draft.prompt} placeholder={t.taskHint} onChange={(e) => agents.setDraft({ prompt: e.target.value })} disabled={busy} />
      </label>
      <div className="xfer-grid">
        <label className="field">
          <span>{t.model}</span>
          <input className="input" value={state.draft.model} list="agents-models" onChange={(e) => agents.setDraft({ model: e.target.value })} disabled={busy} aria-describedby="agents-model-hint" spellCheck={false} autoCapitalize="off" />
          <datalist id="agents-models">
            <option value="sonnet" />
            <option value="opus" />
            <option value="haiku" />
          </datalist>
          <small id="agents-model-hint" className="muted">
            {t.modelHint}
          </small>
        </label>
        <label className="field">
          <span>{t.budget}</span>
          <input className="input" inputMode="decimal" value={state.draft.budget} onChange={(e) => agents.setDraft({ budget: e.target.value })} disabled={busy} aria-describedby="agents-budget-hint" />
          <small id="agents-budget-hint" className="muted">
            {t.budgetHint}
          </small>
        </label>
      </div>
      {tried && problems.length > 0 && (
        <ul role="alert" className="alert alert-danger agents-problems">
          {problems.map((p) => (
            <li key={p}>{t[p]}</li>
          ))}
        </ul>
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

function Outcome({ record, t }: { record: RunRecord; t: T["run"] }) {
  if (record.state === "cancelled") return <p className="alert">{t.cancelled}</p>;
  if (record.state === "done") return <p className="alert">{t.noChanges}</p>;
  if (record.state !== "failed") return null;
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
      <ol className="agents-log" role="log" aria-label={t.transcript} aria-live="polite">
        {shown.map((event, i) => (
          <EventLine key={i} event={event} t={t} />
        ))}
      </ol>
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
                  {c.result === "applied"
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

function History({ history }: { history: readonly RunRecord[] }) {
  const t = useDesktopStrings().agents.history;
  return (
    <section className="set-section agents-history" aria-labelledby="agents-history-heading">
      <h2 id="agents-history-heading">{t.heading}</h2>
      {history.length === 0 ? (
        <p className="muted">{t.empty}</p>
      ) : (
        <ul className="agents-history-list">
          {history.map((r) => (
            <li key={r.id}>
              <details>
                <summary>
                  <span className="agents-history-task">{r.task.prompt.split("\n")[0]!.slice(0, 120)}</span>{" "}
                  <span className="badge badge-muted" data-state={r.state}>
                    {t.states[r.state] ?? r.state}
                  </span>
                </summary>
                <p className="muted small">
                  <time dateTime={new Date(r.createdAt).toISOString()}>{new Date(r.createdAt).toLocaleString()}</time> · {r.provider.name}
                  {r.provider.version ? ` ${r.provider.version}` : ""} · {t.summary(r.context.length, r.changes.filter((c) => c.result === "applied").length)}
                </p>
                <ul className="xfer-list mono small">
                  {r.context.map((c) => (
                    <li key={c.path}>{c.path}</li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
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
        <History history={state.history} />
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
