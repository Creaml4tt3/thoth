/**
 * The Agent Hub's state for one open Private Space (ADR-0007): detection, the task being written, the current run
 * (its streamed events, then its proposed changes and the apply results) and the run history. It wraps `AgentHub`
 * from `@thoth/agent-core` in a store the views read with `useSyncExternalStore`, so a run goes on while another tab
 * is shown. Nothing here reaches the vault except through `AgentHub.apply` (compare-and-swap) after the user chose.
 */
import { AgentHub, AgentUnavailableError, StagingError, type AgentEvent, type AgentHost, type AgentInstallationStatus, type ApplyResult, type ProposedChange, type RunRecord } from "@thoth/agent-core";
import { CLAUDE_PROVIDER_ID, createClaudeProvider, isModelName } from "@thoth/agent-claude";
import type { Vault } from "@thoth/local-store";

/** The newest events kept on screen for one run. */
const MAX_EVENTS = 2000;

export type RunPhase = "idle" | "starting" | "running" | "cancelling" | "review" | "applying" | "finished";

export interface Draft {
  selection: string[];
  prompt: string;
  model: string;
  budget: string;
}

export type DraftProblem = "needContext" | "needTask" | "badModel" | "badBudget";

export interface AgentsState {
  status: AgentInstallationStatus | null;
  checking: boolean;
  draft: Draft;
  phase: RunPhase;
  record: RunRecord | null;
  events: AgentEvent[];
  changes: ProposedChange[] | null;
  /** Paths the user chose to apply (review). */
  approved: string[];
  results: ApplyResult[] | null;
  /** An error that is not part of a run's outcome (staging refused, CLI not ready, apply failed). */
  error: string | null;
  history: RunRecord[];
  /** Runs recovery found interrupted at start; null once dismissed. */
  recovered: number | null;
}

export interface AgentsService {
  subscribe(listener: () => void): () => void;
  getState(): AgentsState;
  detect(): Promise<void>;
  setDraft(patch: Partial<Draft>): void;
  /** Problems with the draft, in the order the form shows them. */
  draftProblems(): DraftProblem[];
  start(): Promise<void>;
  cancel(): Promise<void>;
  setApproved(paths: string[]): void;
  apply(): Promise<void>;
  discard(): Promise<void>;
  saveCopy(path: string, name: (attempt: number) => string): Promise<void>;
  /** Back to the form (after a run ended); keeps the selection. */
  newTask(): Promise<void>;
  recover(): Promise<void>;
  dismissRecovered(): void;
  dispose(): Promise<void>;
}

const EMPTY_DRAFT: Draft = { selection: [], prompt: "", model: "", budget: "" };

export function createAgentsService(vault: Vault, host: AgentHost, options: { now?: () => number; onApplied?: () => void } = {}): AgentsService {
  const hub = new AgentHub({ vault, host, providers: [createClaudeProvider(host)], ...(options.now ? { now: options.now } : {}) });
  const listeners = new Set<() => void>();
  let state: AgentsState = { status: null, checking: false, draft: EMPTY_DRAFT, phase: "idle", record: null, events: [], changes: null, approved: [], results: null, error: null, history: [], recovered: null };
  let disposed = false;

  const set = (patch: Partial<AgentsState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const refreshHistory = async () => set({ history: await hub.history().catch(() => state.history) });

  const service: AgentsService = {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,

    async detect() {
      set({ checking: true });
      const status = await hub.provider(CLAUDE_PROVIDER_ID).detect();
      set({ status, checking: false });
    },

    setDraft(patch) {
      set({ draft: { ...state.draft, ...patch } });
    },

    draftProblems() {
      const { selection, prompt, model, budget } = state.draft;
      const problems: DraftProblem[] = [];
      if (selection.length === 0) problems.push("needContext");
      if (prompt.trim() === "") problems.push("needTask");
      if (model.trim() !== "" && !isModelName(model.trim())) problems.push("badModel");
      if (budget.trim() !== "") {
        const n = Number(budget.trim());
        if (!Number.isFinite(n) || n <= 0 || n > 1000) problems.push("badBudget");
      }
      return problems;
    },

    async start() {
      if (state.phase !== "idle" && state.phase !== "finished") return;
      if (service.draftProblems().length > 0) return;
      const { selection, prompt, model, budget } = state.draft;
      set({ phase: "starting", error: null, events: [], changes: null, approved: [], results: null, record: null });
      try {
        const { record, finished } = await hub.start(
          { provider: CLAUDE_PROVIDER_ID, prompt, selection, ...(model.trim() ? { model: model.trim() } : {}), ...(budget.trim() ? { maxBudgetUsd: Number(budget.trim()) } : {}) },
          (event) => {
            const events = state.events.length >= MAX_EVENTS ? [...state.events.slice(1), event] : [...state.events, event];
            set({ events });
          },
        );
        set({ phase: service.getState().phase === "cancelling" ? "cancelling" : "running", record });
        void refreshHistory();
        const done = await finished;
        const changes = hub.changes(done.id);
        set({
          record: done,
          changes: done.state === "review" ? changes : null,
          approved: done.state === "review" ? (changes ?? []).filter((c) => c.problem === undefined).map((c) => c.path) : [],
          phase: done.state === "review" ? "review" : "finished",
        });
      } catch (error) {
        if (error instanceof AgentUnavailableError) set({ status: error.status, phase: "idle", error: null });
        else set({ phase: "idle", error: error instanceof StagingError ? error.message : message(error) });
      }
      await refreshHistory();
    },

    async cancel() {
      if (state.phase !== "running" || !state.record) return;
      set({ phase: "cancelling" });
      await hub.cancel(state.record.id).catch((error: unknown) => set({ error: message(error) }));
    },

    setApproved(paths) {
      set({ approved: paths });
    },

    async apply() {
      if (state.phase !== "review" || !state.record) return;
      set({ phase: "applying", error: null });
      try {
        const results = await hub.apply(state.record.id, state.approved);
        set({ results, phase: "finished", record: hub.current(state.record.id) ?? state.record });
        if (results.some((r) => r.result === "applied")) options.onApplied?.();
      } catch (error) {
        set({ phase: "review", error: message(error) });
      }
      await refreshHistory();
    },

    async discard() {
      if (state.phase !== "review" || !state.record) return;
      try {
        await hub.discard(state.record.id);
        set({ phase: "finished", results: [], record: hub.current(state.record.id) ?? state.record });
      } catch (error) {
        set({ error: message(error) });
      }
      await refreshHistory();
    },

    async saveCopy(path, name) {
      if (!state.record) return;
      try {
        await hub.saveCopy(state.record.id, path, name);
        set({ record: hub.current(state.record.id) ?? state.record, error: null });
        options.onApplied?.();
      } catch (error) {
        set({ error: message(error) });
      }
      await refreshHistory();
    },

    async newTask() {
      if (state.phase === "running" || state.phase === "cancelling" || state.phase === "starting" || state.phase === "applying") return;
      if (state.record && state.phase !== "review") await hub.close(state.record.id);
      set({ phase: "idle", record: null, events: [], changes: null, approved: [], results: null, error: null, draft: { ...state.draft, prompt: "" } });
    },

    async recover() {
      const { interrupted } = await hub.recover().catch(() => ({ interrupted: [] as string[] }));
      if (interrupted.length > 0) set({ recovered: interrupted.length });
      await refreshHistory();
    },

    dismissRecovered() {
      set({ recovered: null });
    },

    async dispose() {
      disposed = true;
      listeners.clear();
      await hub.dispose();
    },
  };
  return service;
}
