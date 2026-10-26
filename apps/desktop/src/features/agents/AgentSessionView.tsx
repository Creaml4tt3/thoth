/**
 * A session tab (the "agent-run" tab target, ADR-0007 amendments of 2026-10-26): one conversation of the assistant,
 * one tab. The tab's run is the conversation's id (its first turn's run id); a turn of it opens the same tab.
 *
 * - The first question's first line as the title; the agent, the model, when it started and the newest turn's state.
 * - Its turns, top to bottom: each question, then for this window's current run the live transcript (with Cancel),
 *   the answer, the existing review (one row per file, nothing written until Apply, then compare-and-swap) and the
 *   result; for any other turn its answer, transcript and proposed changes from the local details (or that they were
 *   deleted). A follow-up says how many earlier turns went with it as context.
 * - The composer: "Ask a follow-up" (Cmd/Ctrl+Enter sends) with the last turn's pages and settings, or "Change pages
 *   or settings…" in the bubble. Sending waits while a turn runs or waits for review, and while this window runs
 *   another task. A conversation another window owns (ADR-0019 rule 8) is read-only here, and the tab says where to go.
 *
 * Every turn is a one-shot run (no CLI session): the earlier questions and answers are quoted to the CLI, never kept in
 * the vault's records.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { AgentEvent, RunDetails, RunRecord } from "@thoth/agent-core";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Notice } from "@thoth/app-ui/ui/Notice.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { Review } from "./Review.tsx";
import { Answer, DetailChanges, EventLine, Outcome, Results, StoppedNotice, outcomeLabel, providerOf, taskTitle } from "./parts.tsx";
import type { AgentsService, AgentsState, FollowUpPlan } from "./service.ts";

const RUNNING = new Set(["starting", "running", "cancelling"]);
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The agent, the model, when the conversation started and the state of its newest turn. */
function Facts({ first, last, live }: { first: RunRecord; last: RunRecord; live: AgentsState["phase"] | null }) {
  const all = useDesktopStrings().agents;
  const t = all.session;
  const running = live !== null && RUNNING.has(live);
  const label = running ? all.history.states["running"]! : outcomeLabel(last, all.history);
  return (
    <dl className="agents-session-facts" aria-label={t.facts}>
      <div>
        <dt>{t.agent}</dt>
        <dd data-provider={last.provider.id}>{last.provider.name}</dd>
      </div>
      <div>
        <dt>{t.model}</dt>
        <dd className="mono">{last.outcome?.model ?? last.task.model ?? t.defaultModel}</dd>
      </div>
      <div>
        <dt>{t.started}</dt>
        <dd>
          <time dateTime={new Date(first.createdAt).toISOString()}>{new Date(first.createdAt).toLocaleString()}</time>
        </dd>
      </div>
      <div>
        <dt>{t.state}</dt>
        <dd>
          <span className="badge badge-muted" data-state={running ? "running" : last.state} data-stopped={last.outcome?.stoppedBy}>
            {label}
          </span>
        </dd>
      </div>
    </dl>
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

/** The turn this window is running (or reviewing, or just finished): bound to the Agent service's state. */
function LiveTurn({ agents, state, turn }: { agents: AgentsService; state: AgentsState; turn: number }) {
  const all = useDesktopStrings().agents;
  const { record, phase } = state;
  const p = providerOf(all, record!.provider.id);
  const running = RUNNING.has(phase);
  const reviewing = (phase === "review" || phase === "applying") && state.changes !== null;
  const finished = phase === "finished";
  return (
    <>
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
      {!running && state.answer !== null && <Answer text={state.answer} id={`turn-${turn}-answer`} />}
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

/** Any other turn: its record, and what its local details still hold. */
function StoredTurn({ agents, state, record, turn }: { agents: AgentsService; state: AgentsState; record: RunRecord; turn: number }) {
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
          {!going && details.answer !== null && <Answer text={details.answer} id={`turn-${turn}-answer`} />}
          {!going && <Outcome record={record} t={all.run} p={p} answered={details.answer !== null} />}
          <Transcript events={details.events} record={record} open={going} />
          {record.changes.length > 0 && (
            <section className="agents-sub" aria-labelledby={`turn-${turn}-changes`}>
              <h3 id={`turn-${turn}-changes`}>{t.changes}</h3>
              <DetailChanges record={record} changes={details.changes} />
            </section>
          )}
        </>
      )}
    </>
  );
}

/** One turn: the question, what went with it, then the run. */
function Turn({ agents, state, record, n }: { agents: AgentsService; state: AgentsState; record: RunRecord; n: number }) {
  const t = useDesktopStrings().agents.session;
  const heading = `turn-${n}-heading`;
  const context = record.conversation?.context;
  return (
    <li className="agents-turn" data-turn={n} data-run={record.id}>
      <section aria-labelledby={heading}>
        <h2 id={heading} className="agents-turn-heading">
          {t.question(n)}
        </h2>
        <p className="agents-prompt agents-turn-question">{record.task.prompt}</p>
        {n > 1 && context && (
          <p className="muted small agents-turn-context" data-testid="turn-context">
            {t.context(context.sent, context.earlier, context.deleted, context.notAllowed)}
          </p>
        )}
        {state.record?.id === record.id ? <LiveTurn agents={agents} state={state} turn={n} /> : <StoredTurn agents={agents} state={state} record={record} turn={n} />}
      </section>
    </li>
  );
}

/** "Same pages and settings as the last question: Claude Code, 2 pages, sonnet." */
function planSummary(plan: FollowUpPlan, all: ReturnType<typeof useDesktopStrings>["agents"]): string {
  const t = all.session;
  const what = [all.providers[plan.provider].name];
  if (plan.wholeSpace) what.push(t.wholeSpace);
  else if (plan.selection.length > 0) what.push(t.pages(plan.selection.length));
  if (plan.workspace.length > 0) what.push(t.workspacePages(plan.workspace.length));
  what.push(plan.model.trim() || t.defaultModel);
  return t.sameContext(what.join(", "));
}

/** The next question of the conversation. */
function Composer({ agents, state, conversation }: { agents: AgentsService; state: AgentsState; conversation: string }) {
  const all = useDesktopStrings().agents;
  const t = all.session;
  const { assistant } = useSession();
  const id = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const block = agents.followUpBlock(conversation);
  const plan = agents.followUpPlan(conversation);
  const compose = state.compose?.conversation === conversation ? state.compose.nonce : null;
  useEffect(() => {
    if (compose !== null) box.current?.focus();
  }, [compose, block === "elsewhere"]);
  if (block === "elsewhere")
    return (
      <p className="alert alert-warning agents-composer-elsewhere" role="note" data-testid="composer-elsewhere">
        {t.ownedElsewhere}
      </p>
    );
  if (block === "unknown" || !plan) return null;
  const canSend = block === null && text.trim() !== "" && !sending;
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setFailed(false);
    const ok = await agents.sendFollowUp(conversation, text);
    setSending(false);
    if (ok) setText("");
    else setFailed(true);
  };
  const change = () => {
    if (agents.editFollowUp(conversation, text)) assistant?.openBubble();
  };
  const ids = { hint: `${id}-hint`, block: `${id}-block` };
  const error = failed ? (state.error ?? t.sendFailed) : null;
  return (
    <form
      className="agents-composer"
      aria-labelledby={`${id}-label`}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label id={`${id}-label`} htmlFor={`${id}-text`} className="agents-composer-label">
        {t.composer}
      </label>
      <textarea
        id={`${id}-text`}
        ref={box}
        className="input"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-describedby={block ? `${ids.hint} ${ids.block}` : ids.hint}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <p id={ids.hint} className="muted small">
        {planSummary(plan, all)} {t.composerHint(IS_MAC)}
      </p>
      {plan.workspaceDropped && <p className="muted small">{t.workspaceDropped}</p>}
      {block && (
        <p id={ids.block} role="status" className="small agents-composer-blocked" data-testid="composer-blocked" data-block={block}>
          {t.blocked[block]}
        </p>
      )}
      {error && (
        <p role="alert" className="alert alert-danger small">
          {error}
        </p>
      )}
      <div className="set-actions">
        <Button variant="quiet" onClick={change} disabled={block !== null && block !== "notAllowed"}>
          {t.change}
        </Button>
        <Button variant="primary" type="submit" disabled={!canSend}>
          {sending ? t.sending : t.send}
        </Button>
      </div>
    </form>
  );
}

function Session({ agents, run }: { agents: AgentsService; run: string }) {
  const all = useDesktopStrings().agents;
  const t = all.session;
  const { openSettings, assistant } = useSession();
  const state = useSyncExternalStore(agents.subscribe, agents.getState);
  const conversation = agents.conversationOf(run);
  const turns = agents.conversation(conversation);
  const first = turns[0] ?? null;
  const last = turns.at(-1) ?? null;
  const current = last !== null && state.record?.id === last.id;
  const [looked, setLooked] = useState(false);
  // A run that is not in the list yet (another window's, or the list was not read yet): read it once.
  useEffect(() => {
    if (first || looked) return;
    void agents.refresh().finally(() => setLooked(true));
  }, [agents, first, looked]);
  const idle = state.phase === "idle" || state.phase === "finished";
  const askAgain = () =>
    void agents.askAgain(last!.id).then((ok) => {
      if (ok) assistant?.openBubble();
    });
  return (
    <div className="page-scroll">
      <div className="page-col settings agents agents-session" data-run={conversation}>
        {!first || !last ? (
          <>
            <h1 className="page-title">{t.tab}</h1>
            <p className="muted" role="status">
              {looked ? t.missing : t.loading}
            </p>
          </>
        ) : (
          <>
            <h1 className="page-title agents-session-title">{taskTitle(first.task.prompt)}</h1>
            <Facts first={first} last={last} live={current ? state.phase : null} />
            <ol className="agents-turns" aria-label={t.turns}>
              {turns.map((record, i) => (
                <Turn key={record.id} agents={agents} state={state} record={record} n={i + 1} />
              ))}
            </ol>
            <Composer agents={agents} state={state} conversation={conversation} />
          </>
        )}
        <div className="set-actions">
          {last && idle && !(current && RUNNING.has(state.phase)) && (
            <Button variant="ghost" onClick={askAgain}>
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
