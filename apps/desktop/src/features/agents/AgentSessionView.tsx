/**
 * A session tab (the "agent-run" tab target, ADR-0007 amendment of 2026-10-26): one run of the assistant, one tab.
 *
 * - The task (its first line as the title, the whole task below), the agent, the model, when it started and its state.
 * - The current run of this window, live: the transcript while it runs (with Cancel); the answer when it ends; the
 *   review (the existing review: one row per file, nothing written until Apply, then compare-and-swap) while it waits
 *   for review; the result after applying; the limit and outcome notices.
 * - Any other run, from its record and its local details (`AgentHub.details`): the answer and the transcript read back
 *   from the transcript, and what it proposed. When retention deleted them, the tab says so. A run another window owns
 *   (ADR-0019 rule 8) is read-only here: this window cannot cancel or review it, and the tab says where to go.
 *
 * A follow-up is a new run ("Ask again": the bubble with the same task and context); runs are one-shot.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentEvent, RunDetails, RunRecord } from "@thoth/agent-core";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Notice } from "@thoth/app-ui/ui/Notice.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { Review } from "./Review.tsx";
import { Answer, DetailChanges, EventLine, Outcome, Results, StoppedNotice, outcomeLabel, providerOf, taskTitle } from "./parts.tsx";
import type { AgentsService, AgentsState } from "./service.ts";

const RUNNING = new Set(["starting", "running", "cancelling"]);

/** The task, the agent, the model, the time and the state. */
function Head({ record, live }: { record: RunRecord; live: AgentsState["phase"] | null }) {
  const all = useDesktopStrings().agents;
  const t = all.session;
  const title = taskTitle(record.task.prompt);
  const running = live !== null && RUNNING.has(live);
  const label = running ? all.history.states["running"]! : outcomeLabel(record, all.history);
  return (
    <>
      <h1 className="page-title agents-session-title">{title}</h1>
      {record.task.prompt.trim() !== title && <p className="agents-prompt">{record.task.prompt}</p>}
      <dl className="agents-session-facts" aria-label={t.facts}>
        <div>
          <dt>{t.agent}</dt>
          <dd data-provider={record.provider.id}>{record.provider.name}</dd>
        </div>
        <div>
          <dt>{t.model}</dt>
          <dd className="mono">{record.outcome?.model ?? record.task.model ?? t.defaultModel}</dd>
        </div>
        <div>
          <dt>{t.started}</dt>
          <dd>
            <time dateTime={new Date(record.createdAt).toISOString()}>{new Date(record.createdAt).toLocaleString()}</time>
          </dd>
        </div>
        <div>
          <dt>{t.state}</dt>
          <dd>
            <span className="badge badge-muted" data-state={running ? "running" : record.state} data-stopped={record.outcome?.stoppedBy}>
              {label}
            </span>
          </dd>
        </div>
      </dl>
    </>
  );
}

function Transcript({ events, record, open = false }: { events: readonly AgentEvent[]; record: RunRecord; open?: boolean }) {
  const all = useDesktopStrings().agents;
  const shown = events.filter((e) => e.type !== "log" && e.type !== "exit");
  if (shown.length === 0) return null;
  const p = providerOf(all, record.provider.id);
  const log = (
    <div role="log" aria-label={all.run.transcript} className="agents-session-log">
      <ol className="agents-log">
        {shown.map((event, i) => (
          <EventLine key={i} event={event} t={all.run} p={p} />
        ))}
      </ol>
    </div>
  );
  // While it runs the transcript is the view; after, it is folded under the answer.
  if (open) return log;
  return (
    <details className="agents-transcript">
      <summary>{all.session.transcript}</summary>
      {log}
    </details>
  );
}

/** The run this window is running (or reviewing, or just finished): bound to the Agent service's state. */
function Live({ agents, state }: { agents: AgentsService; state: AgentsState }) {
  const all = useDesktopStrings().agents;
  const { record, phase } = state;
  const p = providerOf(all, record!.provider.id);
  const running = RUNNING.has(phase);
  const reviewing = (phase === "review" || phase === "applying") && state.changes !== null;
  const finished = phase === "finished";
  return (
    <>
      <Head record={record!} live={phase} />
      {running && (
        <div className="agents-session-run" aria-busy="true">
          <p role="status" className="muted">
            {phase === "cancelling" ? all.run.cancelling : all.run.working}
          </p>
          <Transcript events={state.events} record={record!} open />
          <div className="set-actions">
            <Button variant="danger" onClick={() => void agents.cancel()} disabled={phase !== "running"}>
              {phase === "cancelling" ? all.run.cancelling : all.run.cancel}
            </Button>
          </div>
        </div>
      )}
      {!running && <StoppedNotice record={record!} t={all.run} />}
      {!running && state.answer !== null && <Answer text={state.answer} id="session-answer" level={2} />}
      {reviewing && state.changes && (
        <Review changes={state.changes} approved={state.approved} busy={phase === "applying"} onApproved={(paths) => agents.setApproved(paths)} onApply={() => void agents.apply()} onDiscard={() => void agents.discard()} />
      )}
      {phase === "review" && state.error && (
        <p role="alert" className="alert alert-danger">
          {state.error}
        </p>
      )}
      {finished && state.results === null && <Outcome record={record!} t={all.run} p={p} answered={state.answer !== null} />}
      {finished && state.results !== null && <Results state={state} agents={agents} focus={finished} />}
      {!running && <Transcript events={state.events} record={record!} />}
    </>
  );
}

/** Any other run: its record, and what its local details still hold. */
function Stored({ agents, state, record }: { agents: AgentsService; state: AgentsState; record: RunRecord }) {
  const all = useDesktopStrings().agents;
  const t = all.session;
  const { alone } = useSession();
  const [details, setDetails] = useState<RunDetails | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setDetails(undefined);
    void agents.runDetails(record.id).then((d) => live && setDetails(d));
    return () => {
      live = false;
    };
  }, [agents, record.id, record.updatedAt]);
  const going = record.state === "running" || record.state === "staging";
  // A run waiting for review may be another window's while other windows are open (ADR-0019 rule 8).
  const elsewhere = going || (record.state === "review" && !alone);
  const idle = state.phase === "idle" || state.phase === "finished";
  const reviewable = record.state === "review" && !elsewhere && idle && state.available[record.id]?.review === true;
  const p = providerOf(all, record.provider.id);
  return (
    <>
      <Head record={record} live={null} />
      {elsewhere && (
        <p className="alert alert-warning" role="note" data-testid="agent-elsewhere">
          {t.elsewhere}
        </p>
      )}
      {reviewable && (
        <div className="set-actions">
          <Button variant="primary" onClick={() => void agents.reopenReview(record.id)}>
            {t.reviewAgain}
          </Button>
        </div>
      )}
      {!going && <StoppedNotice record={record} t={all.run} />}
      {details === undefined ? (
        <p role="status" className="muted">
          {t.loading}
        </p>
      ) : details === null ? (
        !going && (
          <p className="alert" role="note" data-testid="agent-details-gone">
            {t.detailsGone}
          </p>
        )
      ) : (
        <>
          {!going && details.answer !== null && <Answer text={details.answer} id="session-answer" level={2} />}
          {!going && <Outcome record={record} t={all.run} p={p} answered={details.answer !== null} />}
          <Transcript events={details.events} record={record} open={going} />
          {record.changes.length > 0 && (
            <section className="agents-sub" aria-labelledby="session-changes-heading">
              <h2 id="session-changes-heading">{t.changes}</h2>
              <DetailChanges record={record} changes={details.changes} />
            </section>
          )}
        </>
      )}
    </>
  );
}

function Session({ agents, run }: { agents: AgentsService; run: string }) {
  const all = useDesktopStrings().agents;
  const t = all.session;
  const { openSettings, assistant } = useSession();
  const state = useSyncExternalStore(agents.subscribe, agents.getState);
  const current = state.record?.id === run;
  const record = current ? state.record : (state.history.find((r) => r.id === run) ?? null);
  const [looked, setLooked] = useState(false);
  // A run that is not in the list yet (another window's, or the list was not read yet): read it once.
  useEffect(() => {
    if (record || looked) return;
    void agents.refresh().finally(() => setLooked(true));
  }, [agents, record, looked]);
  const idle = state.phase === "idle" || state.phase === "finished";
  const askAgain = () =>
    void agents.askAgain(run).then((ok) => {
      if (ok) assistant?.openBubble();
    });
  return (
    <div className="page-scroll">
      <div className="page-col settings agents agents-session" data-run={run}>
        {!record ? (
          <>
            <h1 className="page-title">{t.tab}</h1>
            <p className="muted" role="status">
              {looked ? t.missing : t.loading}
            </p>
          </>
        ) : current ? (
          <Live agents={agents} state={state} />
        ) : (
          <Stored agents={agents} state={state} record={record} />
        )}
        <div className="set-actions">
          {record && idle && !(current && RUNNING.has(state.phase)) && (
            <Button variant={current && state.phase === "finished" ? "primary" : "ghost"} onClick={askAgain}>
              {t.askAgain}
            </Button>
          )}
          {current && state.phase === "finished" && (
            <Button variant="ghost" onClick={() => void agents.newTask()}>
              {all.applied.newTask}
            </Button>
          )}
          <Button variant="quiet" onClick={() => openSettings("agents")}>
            {useDesktopStrings().mascot.bubble.settings}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AgentSessionView({ run }: { run: string }) {
  const { agents } = useSession();
  const t = useDesktopStrings().agents;
  if (!agents) return <Notice title={t.title} detail={t.unavailable} />;
  return <Session agents={agents} run={run} />;
}
