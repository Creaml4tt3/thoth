/**
 * The sidebar's Assistant section (ADR-0007 amendments of 2026-10-26): the conversations of this Private Space, the
 * one with the newest turn first, from the run records (the history). The five newest are shown; "Show N more" lists
 * the rest (up to the history's limit) and "Show less" folds them again. Each row is the first question's first line,
 * how many questions it has (from two on), and the newest turn's state in words when it is going or waiting for review
 * (with a dot, never colour alone); it opens the conversation's session tab, and the current tab's is marked. Not shown
 * where agents cannot run, nor before the first run.
 *
 * It is one of the sidebar's reorderable sections (id `agents`, ADR-0019 amendment), placed by `SidebarSections`.
 */
import { useId, useMemo, useState, useSyncExternalStore } from "react";
import type { RunRecord } from "@thoth/agent-core";
import { tipIfClipped } from "@thoth/app-ui/ui/Tooltip.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { AGENTS_SECTION } from "../shell/sections.ts";
import type { SidebarSection } from "../shell/SidebarSections.tsx";
import { outcomeLabel, taskTitle } from "./parts.tsx";
import type { AgentsService } from "./service.ts";

/** How many runs the section shows before "Show N more". */
export const SHOWN_RUNS = 5;
/** The section's id in the sidebar's order. */
export const AGENTS_SECTION_ID = AGENTS_SECTION;

const GOING = new Set(["starting", "running", "cancelling"]);
const NO_RUNS: readonly RunRecord[] = [];
const NO_SUBSCRIPTION = () => () => undefined;

function Runs({ agents, current }: { agents: AgentsService; current: string | null }) {
  const all = useDesktopStrings().agents;
  const t = all.sidebar;
  const { openAgentRun } = useSession();
  const state = useSyncExternalStore(agents.subscribe, agents.getState);
  const [expanded, setExpanded] = useState(false);
  const list = `${useId()}-list`;
  // One row per conversation (ADR-0007, "Conversations"): its first question, how many there are, its newest state.
  const conversations = useMemo(() => agents.conversations(), [agents, state.history, state.record]);
  const shown = expanded ? conversations : conversations.slice(0, SHOWN_RUNS);
  const more = conversations.length - SHOWN_RUNS;
  return (
    <div className="agents-section">
      <ul className="agents-rows" id={list}>
        {shown.map(({ id, turns }) => {
          const first = turns[0]!;
          const r = turns.at(-1)!;
          const live = state.record?.id === r.id && GOING.has(state.phase);
          const st = live ? "running" : r.state;
          const label = live ? all.history.states["running"]! : outcomeLabel(r, all.history);
          const open = st === "running" || st === "staging" || st === "review";
          const title = taskTitle(first.task.prompt) || all.session.tab;
          return (
            <li key={id}>
              <button type="button" className="agents-row" data-state={st} data-turns={turns.length} aria-current={id === current ? "page" : undefined} onClick={() => openAgentRun(id)}>
                <span className="agents-row-task" {...tipIfClipped(title)}>
                  {title}
                </span>
                {turns.length > 1 && <span className="agents-row-turns">{t.turns(turns.length)}</span>}
                {/* Only what still needs the person: a run going, or waiting for review. The tab says the rest. */}
                {open && (
                  <span className="agents-row-state" data-open="">
                    {label}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <button type="button" className="sec-link agents-more" aria-expanded={expanded} aria-controls={list} onClick={() => setExpanded((e) => !e)}>
          {expanded ? t.less : t.more(more)}
        </button>
      )}
    </div>
  );
}

/** The Assistant section, or null where agents cannot run or no run exists yet. `current`: the run of the current tab. */
export function useAgentsSection(current: string | null): SidebarSection | null {
  const { agents } = useSession();
  const t = useDesktopStrings().agents.sidebar;
  const history = useSyncExternalStore(agents?.subscribe ?? NO_SUBSCRIPTION, () => agents?.getState().history ?? NO_RUNS);
  if (!agents || history.length === 0) return null;
  return { id: AGENTS_SECTION, name: t.heading, label: t.heading, children: <Runs agents={agents} current={current} /> };
}
