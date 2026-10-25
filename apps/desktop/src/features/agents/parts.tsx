/**
 * Pieces of the agent UI shared by the prompt bubble (features/mascot), the review tab (AgentRunView) and the
 * assistant's settings (AgentSettings): detection status with fix instructions, transcript lines, the run's outcome,
 * the result of applying, and the run history with its saved details. Agent output is shown as plain text.
 */
import { useEffect, useRef } from "react";
import type { AgentEvent, AgentInstallationStatus, RunRecord } from "@thoth/agent-core";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { conflictCopyPath } from "@thoth/app-ui/editor/page-session.ts";
import { isMarkdownPath } from "@thoth/domain";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings, type DesktopStrings } from "../../strings/index.ts";
import { DiffView } from "./Review.tsx";
import type { AgentsService, AgentsState } from "./service.ts";
import { isAgentProvider, type AgentProviderId } from "./settings.ts";
import { tipIfClipped } from "@thoth/app-ui/ui/Tooltip.tsx";
import "./agents.css";

export type T = DesktopStrings["agents"];
export type ProviderStrings = T["providers"][AgentProviderId];

/** The strings of the agent a run or record names (an unknown one falls back to Claude Code's wording). */
export const providerOf = (t: T, id: string): ProviderStrings => t.providers[isAgentProvider(id) ? id : "claude"];

/** One agent CLI in the assistant's settings: what detection found, in a sentence and as short facts, and how to fix it. */
export function Status({ provider, status, checking, onCheck }: { provider: AgentProviderId; status: AgentInstallationStatus | null; checking: boolean; onCheck(): void }) {
  const strings = useDesktopStrings().agents;
  const t = { ...strings.status, ...strings.providers[provider] };
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
      case "sandbox_unavailable":
        body = { text: t.sandboxUnavailable(status.message), fix: t.sandboxFix };
        break;
      case "error":
        body = { text: t.error(status.message) };
        break;
    }
  return (
    <section className="agents-provider" aria-labelledby={`agents-status-${provider}`} aria-busy={checking || !status} data-provider={provider}>
      <div className="agents-provider-head">
        <h4 id={`agents-status-${provider}`}>{t.name}</h4>
        <ProviderFacts provider={provider} status={checking ? null : status} />
      </div>
      <p role="status" data-testid={`agent-status-${provider}`} data-state={checking || !status ? "checking" : status.state} className={body.ok ? "agents-ready" : undefined}>
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
      <div className="set-actions">
        <Button variant="ghost" small onClick={onCheck} disabled={checking}>
          {t.check}
        </Button>
      </div>
    </section>
  );
}

/** Version, sign-in and (for Codex) sandbox, as three short facts. */
function ProviderFacts({ provider, status }: { provider: AgentProviderId; status: AgentInstallationStatus | null }) {
  const t = useDesktopStrings().agents.facts;
  if (!status) return null;
  const facts: { key: string; text: string; ok: boolean | null }[] = [];
  if (status.state === "missing")
    return (
      <ul className="agents-facts" aria-label={t.label}>
        <li data-ok="false">{t.notInstalled}</li>
      </ul>
    );
  const version = "version" in status && typeof status.version === "string" ? status.version : null;
  facts.push({ key: "version", text: version ? t.version(version) : t.noVersion, ok: version !== null && status.state !== "too_old" && status.state !== "unsupported" });
  facts.push({ key: "login", text: status.state === "not_logged_in" ? t.signedOut : status.state === "ready" ? t.signedIn : t.unknown, ok: status.state === "ready" ? true : status.state === "not_logged_in" ? false : null });
  if (provider === "codex") facts.push({ key: "sandbox", text: status.state === "sandbox_unavailable" ? t.noSandbox : status.state === "ready" ? t.sandbox : t.unknown, ok: status.state === "ready" ? true : status.state === "sandbox_unavailable" ? false : null });
  return (
    <ul className="agents-facts" aria-label={t.label}>
      {facts.map((f) => (
        <li key={f.key} data-ok={f.ok === null ? undefined : String(f.ok)}>
          {f.text}
        </li>
      ))}
    </ul>
  );
}


export function EventLine({ event, t, p }: { event: AgentEvent; t: T["run"]; p: ProviderStrings }) {
  switch (event.type) {
    case "session":
      return <li className="muted">{p.session(event.model ?? p.name)}</li>;
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
      return <li className="muted">{p.retry(event.attempt)}</li>;
    case "result":
      if (event.costUsd !== undefined) return <li className="muted">{t.cost(event.costUsd.toFixed(4))}</li>;
      return event.tokens ? <li className="muted">{t.tokens(event.tokens.input, event.tokens.cachedInput, event.tokens.output)}</li> : null;
    case "error":
      return (
        <li className="agents-error">
          {errorText(event.code, t, p)} {event.code === "cli" && <span>{event.message}</span>}
        </li>
      );
    default:
      return null;
  }
}

/** What an error code means, in the words of the agent that reported it. */
export const errorText = (code: string, t: T["run"], p: ProviderStrings): string => p.errors[code] ?? t.errors[code] ?? p.errors["cli"]!;

/** A run that stopped at its time limit or used up its budget says so, whatever else happened. */
export function StoppedNotice({ record, t }: { record: RunRecord; t: T["run"] }) {
  const stopped = record.outcome?.stoppedBy;
  if (!stopped) return null;
  const minutes = record.task.timeoutMs === undefined ? null : Math.round(record.task.timeoutMs / 60_000);
  return (
    <p className="alert alert-warning" role="status" data-testid="agent-stopped" data-stopped={stopped}>
      {stopped === "time" ? t.stoppedTime(minutes) : t.stoppedBudget(record.task.maxBudgetUsd ?? null)}
    </p>
  );
}

export function Outcome({ record, t, p }: { record: RunRecord; t: T["run"]; p: ProviderStrings }) {
  if (record.state === "cancelled") return <p className="alert">{t.cancelled}</p>;
  if (record.state === "done") return <p className="alert">{t.noChanges}</p>;
  if (record.state !== "failed" || record.outcome?.stoppedBy) return null;
  const error = record.outcome?.error;
  return (
    <div className="alert alert-danger">
      <p>{t.failed}</p>
      {error && (
        <p>
          {errorText(error.code, t, p)} {(error.code === "cli" || error.code === "spawn" || error.code === "review") && error.message}
        </p>
      )}
    </div>
  );
}


export function Results({ state, agents, focus }: { state: AgentsState; agents: AgentsService; focus: boolean }) {
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

export function eventLines(events: readonly AgentEvent[], t: T["run"], p: ProviderStrings) {
  return events.filter((e) => e.type !== "log" && e.type !== "exit").map((event, i) => <EventLine key={i} event={event} t={t} p={p} />);
}

/** The cost column: the CLI's cost estimate (Claude Code), or the tokens it reported (Codex). */
export function costCell(r: RunRecord, t: T["history"]): string {
  if (r.outcome?.costUsd !== undefined) return t.costOf(r.outcome.costUsd);
  if (r.outcome?.tokens) return t.tokensOf(r.outcome.tokens.input + r.outcome.tokens.output);
  return t.noCost;
}

export function outcomeLabel(r: RunRecord, t: T["history"]): string {
  if (r.outcome?.stoppedBy === "time") return t.stoppedTime;
  if (r.outcome?.stoppedBy === "budget") return t.stoppedBudget;
  return t.states[r.state] ?? r.state;
}

export function HistoryDetail({ agents, detail }: { agents: AgentsService; detail: NonNullable<AgentsState["detail"]> }) {
  const t = useDesktopStrings().agents;
  const { record, details, loading } = detail;
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <section className="agents-detail" aria-labelledby="agents-detail-heading" aria-busy={loading}>
      <h4 id="agents-detail-heading" ref={ref} tabIndex={-1}>
        {t.history.detailsHeading}
      </h4>
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
          <h5>{t.history.transcript}</h5>
          <div role="log" aria-label={t.history.transcript}>
            <ol className="agents-log">{eventLines(details.events, t.run, providerOf(t, record.provider.id))}</ol>
          </div>
          <h5>{t.history.changes}</h5>
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

/** Earlier runs (date, task, agent, model, cost or tokens, outcome); a run waiting for review opens it with `onReview`. */
export function History({ state, agents, onReview }: { state: AgentsState; agents: AgentsService; onReview(id: string): void }) {
  const t = useDesktopStrings().agents.history;
  const { history, available, phase } = state;
  const idle = phase === "idle" || phase === "finished";
  return (
    <section className="agents-sub agents-history" aria-labelledby="agents-history-heading">
      <h3 id="agents-history-heading">{t.heading}</h3>
      {history.length === 0 ? (
        <p className="muted">{t.empty}</p>
      ) : (
        <div className="agents-table-wrap">
        <table className="agents-history-table">
          <thead>
            <tr>
              <th scope="col">{t.date}</th>
              <th scope="col">{t.task}</th>
              <th scope="col">{t.agent}</th>
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
                  <td className="agents-history-task" {...tipIfClipped(r.task.prompt)}>
                    {r.task.prompt.split("\n")[0]!.slice(0, 120)}
                  </td>
                  <td className="small" data-provider={r.provider.id}>
                    {r.provider.name}
                  </td>
                  <td className="mono small">{r.outcome?.model ?? r.task.model ?? t.defaultModel}</td>
                  <td className="small">{costCell(r, t)}</td>
                  <td>
                    <span className="badge badge-muted" data-state={r.state} data-stopped={r.outcome?.stoppedBy}>
                      {outcomeLabel(r, t)}
                    </span>
                  </td>
                  <td className="agents-history-actions">
                    {r.state === "review" && here?.review && idle && (
                      <Button variant="primary" small onClick={() => onReview(r.id)} aria-label={`${t.reviewAgain}: ${r.task.prompt.split("\n")[0]!.slice(0, 60)}`}>
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
        </div>
      )}
      {state.detail && <HistoryDetail agents={agents} detail={state.detail} />}
    </section>
  );
}

