/**
 * The sidebar's Assistant section (ADR-0007 amendment of 2026-10-26): the runs of this Private Space, newest first,
 * from the run records (the history). The five newest are shown; "Show N more" lists the rest (up to the history's
 * limit) and "Show less" folds them again. Each row is the task's first line and its state in words (a run going or
 * waiting for review also gets a dot, never colour alone); it opens the run's session tab, and the run of the current
 * tab is marked. Not shown where agents cannot run, nor before the first run.
 *
 * It is one of the sidebar's reorderable sections (id `agents`, ADR-0019 amendment), placed by `SidebarSections`.
 */
import { useId, useState, useSyncExternalStore } from "react";
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
  const runs = state.history;
  const shown = expanded ? runs : runs.slice(0, SHOWN_RUNS);
  const more = runs.length - SHOWN_RUNS;
  return (
    <div className="agents-section">
      <ul className="agents-rows" id={list}>
        {shown.map((r) => {
          const live = state.record?.id === r.id && GOING.has(state.phase);
          const st = live ? "running" : r.state;
          const label = live ? all.history.states["running"]! : outcomeLabel(r, all.history);
          const open = st === "running" || st === "staging" || st === "review";
          const title = taskTitle(r.task.prompt) || all.session.tab;
          return (
            <li key={r.id}>
              <button type="button" className="agents-row" data-state={st} aria-current={r.id === current ? "page" : undefined} onClick={() => openAgentRun(r.id)}>
                <span className="agents-row-task" {...tipIfClipped(title)}>
                  {title}
                </span>
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
