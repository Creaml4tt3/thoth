/**
 * The review tab (the "agents" tab target): what the current run proposed, with the existing review (one row per
 * file, a line diff for pages, nothing written until Apply, then compare-and-swap), and the result of applying with
 * "keep the agent's version as a copy" for a conflict. The mascot opens it when a run waits for review. The task
 * itself is written in the mascot's bubble; the run history and settings are in Settings → Thoth assistant.
 */
import { useSyncExternalStore } from "react";
import type { AgentEvent } from "@thoth/agent-core";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Notice } from "@thoth/app-ui/ui/Notice.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { Review } from "./Review.tsx";
import { EventLine, Outcome, Results, StoppedNotice, providerOf } from "./parts.tsx";
import type { AgentsService } from "./service.ts";

function Body({ agents }: { agents: AgentsService }) {
  const all = useDesktopStrings().agents;
  const t = all.runView;
  const { openSettings } = useSession();
  const state = useSyncExternalStore(agents.subscribe, agents.getState);
  const { record, phase } = state;
  const p = providerOf(all, record?.provider.id ?? state.provider);
  const reviewing = (phase === "review" || phase === "applying") && state.changes !== null;
  const finished = phase === "finished" && record !== null;
  const shown = state.events.filter((e): e is AgentEvent => e.type !== "log" && e.type !== "exit");
  return (
    <div className="page-scroll">
      <div className="page-col settings agents">
        <h1 className="page-title">{t.title}</h1>
        {!record ? (
          <p className="muted">{t.none}</p>
        ) : (
          <>
            <p className="agents-prompt">{record.task.prompt}</p>
            {(reviewing || finished) && <StoppedNotice record={record} t={all.run} />}
            {reviewing && state.changes && (
              <Review changes={state.changes} approved={state.approved} busy={phase === "applying"} onApproved={(paths) => agents.setApproved(paths)} onApply={() => void agents.apply()} onDiscard={() => void agents.discard()} />
            )}
            {phase === "review" && state.error && (
              <p role="alert" className="alert alert-danger">
                {state.error}
              </p>
            )}
            {finished && state.results === null && <Outcome record={record} t={all.run} p={p} />}
            {finished && state.results !== null && <Results state={state} agents={agents} focus={finished} />}
            {shown.length > 0 && (
              <details className="agents-transcript">
                <summary>{t.transcript}</summary>
                <div role="log" aria-label={all.run.transcript}>
                  <ol className="agents-log">
                    {shown.map((event, i) => (
                      <EventLine key={i} event={event} t={all.run} p={p} />
                    ))}
                  </ol>
                </div>
              </details>
            )}
          </>
        )}
        <div className="set-actions">
          {finished && (
            <Button variant="primary" onClick={() => void agents.newTask()}>
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

export function AgentRunView() {
  const { agents } = useSession();
  const t = useDesktopStrings().agents;
  if (!agents) return <Notice title={t.title} detail={t.unavailable} />;
  return <Body agents={agents} />;
}
