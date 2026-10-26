/**
 * The assistant's agent state for one open Private Space (ADR-0007): detection, the task being written (in the
 * mascot's prompt bubble), the current run (its streamed events, then its proposed changes and the apply results),
 * the run history and the agent settings. It wraps `AgentHub` from `@thoth/agent-core` in a store the views read with `useSyncExternalStore`, so a
 * run goes on while another tab is shown. Nothing here reaches the vault except through `AgentHub.apply`
 * (compare-and-swap) after the user chose.
 */
import {
  AgentHub,
  AgentUnavailableError,
  createWorkspaceReader,
  LimitError,
  MAX_EXCERPT_CHARS,
  minutesToMs,
  previewContext,
  StagingError,
  workspaceContextAccess,
  WorkspaceContextError,
  type AgentEvent,
  type AgentHost,
  type AgentInstallationStatus,
  type ApplyResult,
  type ContextPreview,
  type ProposedChange,
  type RunDetails,
  type RunRecord,
  type WorkspaceRefusal,
} from "@thoth/agent-core";
import { createClaudeProvider, isModelName as isClaudeModel } from "@thoth/agent-claude";
import { createCodexProvider, isModelName as isCodexModel } from "@thoth/agent-codex";
import type { Vault } from "@thoth/local-store";
import type { ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import { AGENT_PROVIDERS, loadAgentSettings, saveAgentSettings, type AgentProviderId, type AgentSettings } from "./settings.ts";

/** What the form needs to know about each agent CLI. Codex has no spending limit (its adapter refuses one). */
export const PROVIDER_FEATURES: Record<AgentProviderId, { budget: boolean; isModelName(name: string): boolean; models: readonly string[] }> = {
  // Suggestions for the model field: Claude Code's aliases, and models in Codex 0.164.0's bundled catalog.
  claude: { budget: true, isModelName: isClaudeModel, models: ["sonnet", "opus", "haiku"] },
  codex: { budget: false, isModelName: isCodexModel, models: ["gpt-6.1-sol", "gpt-5.6-luna", "gpt-5.5"] },
};

/** The newest events kept on screen for one run. */
const MAX_EVENTS = 2000;

export type RunPhase = "idle" | "starting" | "running" | "cancelling" | "review" | "applying" | "finished";

/** A workspace page chosen as read-only context. */
export interface WorkspaceChoice {
  server: string;
  workspace: string;
  page: string;
  title: string;
  workspaceName: string;
}

export const workspaceChoiceKey = (c: Pick<WorkspaceChoice, "server" | "workspace" | "page">): string => `${c.server}\n${c.workspace}\n${c.page}`;

export interface Draft {
  selection: string[];
  /** The whole Private Space instead of a selection. */
  wholeSpace: boolean;
  workspace: WorkspaceChoice[];
  prompt: string;
  model: string;
  /** Minutes for this run, or the default from the settings. */
  timeMinutes: number | "default";
  /** US dollars for this run, "none" for no limit, or the default from the settings. */
  budget: number | "none" | "default";
  /**
   * Text selected in the editor when the bubble opened, quoted to the CLI after the task (never kept in the run
   * record); `source` is the kind of page it came from, so Permissions apply to it as to that page. null: none.
   */
  excerpt: Excerpt | null;
}

/** Selected text and the page it came from: a Private Space page (`from` its path) or a workspace page. */
export type Excerpt = { text: string; from: string | null } & ({ source: "private" } | { source: "workspace"; server: string; workspace: string });

/** The longest excerpt of selected text quoted in a task. */
export const MAX_EXCERPT = MAX_EXCERPT_CHARS;

/**
 * Whether selected text may be given to an agent: the same rules as its page. A Private Space excerpt needs Private
 * Space pages on in Permissions; a workspace excerpt needs workspace pages on and a workspace that lets its pages be
 * copied out (an `exportRestricted` workspace refuses it, as it refuses the page).
 */
export function excerptAllowed(excerpt: Excerpt, settings: AgentSettings, servers: ServerDirectory | undefined): boolean {
  if (excerpt.source === "private") return settings.allowPrivate;
  if (!settings.allowWorkspace) return false;
  const workspace = servers?.workspace(excerpt.server, excerpt.workspace);
  return workspace !== undefined && workspaceContextAccess(workspace) === "allowed";
}

export type DraftProblem = "needContext" | "needTask" | "badModel" | "privateOff" | "wholeSpaceOff" | "workspaceOff" | "contextTooMany" | "contextTooLarge" | "contextFileTooLarge" | "contextMissing";

/** Something the user should be told that is not part of a run's outcome. */
export type Notice =
  /** A workspace page was refused as context (or could not be read). */
  | { kind: "refused"; refusal: WorkspaceRefusal; workspace?: string }
  /** A review could not be opened again. */
  | { kind: "reviewGone" }
  /** Workspace pages are switched off in Permissions. */
  | { kind: "workspaceOff" };

export interface DetailState {
  record: RunRecord;
  loading: boolean;
  details: RunDetails | null;
}

export interface AgentsState {
  /** The agent a new task uses. */
  provider: AgentProviderId;
  /** What detection found for each agent (missing until it was checked). */
  statuses: Partial<Record<AgentProviderId, AgentInstallationStatus>>;
  /** The chosen agent's status. */
  status: AgentInstallationStatus | null;
  checking: boolean;
  settings: AgentSettings;
  draft: Draft;
  /** The files and size the draft's Private Space context comes to; null until measured. */
  preview: ContextPreview | null;
  phase: RunPhase;
  record: RunRecord | null;
  events: AgentEvent[];
  /** What the agent said at the end of the current run (`runAnswer`); null while it runs or when it said nothing. */
  answer: string | null;
  changes: ProposedChange[] | null;
  /** Paths the user chose to apply (review). */
  approved: string[];
  results: ApplyResult[] | null;
  /** An error that is not part of a run's outcome (staging refused, CLI not ready, apply failed). */
  error: string | null;
  notice: Notice | null;
  history: RunRecord[];
  /** Which earlier runs have local details (a transcript, a review) to open. */
  available: Record<string, { transcript: boolean; review: boolean }>;
  /** The earlier run whose transcript and changes are open. */
  detail: DetailState | null;
  /** Runs recovery found interrupted at start; null once dismissed. */
  recovered: number | null;
  /** How many runs "Delete history now" removed, until the next change. */
  cleared: number | null;
}

export interface AgentsService {
  subscribe(listener: () => void): () => void;
  getState(): AgentsState;
  detect(): Promise<void>;
  /** Picks the agent for the next task (remembered in the settings). */
  selectProvider(id: AgentProviderId): void;
  setDraft(patch: Partial<Draft>): void;
  /** Adds a workspace page as read-only context unless the user's role or the workspace's rules forbid it. */
  addWorkspacePage(choice: WorkspaceChoice): boolean;
  removeWorkspacePage(key: string): void;
  /** Offers selected text for the next task, unless the rules for its page refuse it (`excerptAllowed`). */
  offerExcerpt(excerpt: Excerpt): boolean;
  /** Measures the draft's Private Space context (call again when the vault changed). */
  refreshPreview(): Promise<void>;
  /** Problems with the draft, in the order the form shows them. */
  draftProblems(): DraftProblem[];
  updateSettings(patch: Partial<AgentSettings>): void;
  start(): Promise<void>;
  cancel(): Promise<void>;
  setApproved(paths: string[]): void;
  apply(): Promise<void>;
  discard(): Promise<void>;
  saveCopy(path: string, name: (attempt: number) => string): Promise<void>;
  /** Opens again the review of a run that was waiting when Thoth last closed. */
  reopenReview(id: string): Promise<void>;
  /** Opens an earlier run's transcript and changes (local details). */
  openDetails(id: string): Promise<void>;
  closeDetails(): void;
  /** "Delete history now": local transcripts and diffs, except for runs waiting for review. */
  clearHistory(): Promise<void>;
  /** Back to the form (after a run ended); keeps the selection. */
  newTask(): Promise<void>;
  /**
   * Back to the form with the task of run `id` (the current run when absent) to send again: a follow-up is a new
   * run (runs are one-shot, ADR-0007). The current run keeps the draft's context; an earlier one gives the Private
   * Space pages and files it was given (workspace pages are picked again). False when a run is still going.
   */
  askAgain(id?: string): Promise<boolean>;
  /** Reads the run history again (the sidebar's Assistant section and the session tabs follow it). */
  refresh(): Promise<void>;
  /** The local details of a run (transcript, answer, diffs), or null when there are none. */
  runDetails(id: string): Promise<RunDetails | null>;
  recover(): Promise<void>;
  dismissRecovered(): void;
  dispose(): Promise<void>;
}

const EMPTY_DRAFT: Draft = { selection: [], wholeSpace: false, workspace: [], prompt: "", model: "", timeMinutes: "default", budget: "default", excerpt: null };

export function createAgentsService(vault: Vault, host: AgentHost, options: { now?: () => number; onApplied?: () => void; servers?: ServerDirectory; settings?: AgentSettings } = {}): AgentsService {
  const initialSettings = options.settings ?? loadAgentSettings();
  let state: AgentsState = {
    provider: initialSettings.provider,
    statuses: {},
    status: null,
    checking: false,
    settings: initialSettings,
    draft: EMPTY_DRAFT,
    preview: null,
    phase: "idle",
    record: null,
    events: [],
    answer: null,
    changes: null,
    approved: [],
    results: null,
    error: null,
    notice: null,
    history: [],
    available: {},
    detail: null,
    recovered: null,
    cleared: null,
  };
  const servers = options.servers;
  const hub = new AgentHub({
    vault,
    host,
    providers: [createClaudeProvider(host), createCodexProvider(host)],
    ...(options.now ? { now: options.now } : {}),
    ...(servers ? { workspace: createWorkspaceReader((server) => servers.client(server)) } : {}),
    retentionDays: () => state.settings.retentionDays,
  });
  const listeners = new Set<() => void>();
  let disposed = false;
  let previewSeq = 0;

  const set = (patch: Partial<AgentsState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const refreshHistory = async () => {
    const [history, available] = await Promise.all([hub.history().catch(() => state.history), hub.detailsAvailable().catch(() => new Map<string, { transcript: boolean; review: boolean }>())]);
    set({ history, available: Object.fromEntries(available) });
  };

  const service: AgentsService = {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,

    async detect() {
      set({ checking: true });
      const found = await Promise.all(AGENT_PROVIDERS.map(async (id) => [id, await hub.provider(id).detect()] as const));
      const statuses = Object.fromEntries(found) as Record<AgentProviderId, AgentInstallationStatus>;
      set({ statuses, status: statuses[state.provider], checking: false });
    },

    selectProvider(id) {
      if (id === state.provider || (state.phase !== "idle" && state.phase !== "finished")) return;
      const settings = { ...state.settings, provider: id };
      saveAgentSettings(settings);
      // Model names belong to one CLI: a name typed for the other is dropped.
      set({ provider: id, status: state.statuses[id] ?? null, settings, draft: { ...state.draft, model: "" }, error: null });
    },

    setDraft(patch) {
      set({ draft: { ...state.draft, ...patch }, notice: state.notice?.kind === "refused" ? null : state.notice });
      if ("selection" in patch || "wholeSpace" in patch) void service.refreshPreview();
    },

    addWorkspacePage(choice) {
      if (!state.settings.allowWorkspace) {
        set({ notice: { kind: "workspaceOff" } });
        return false;
      }
      const workspace = servers?.workspace(choice.server, choice.workspace);
      // The server decides what a person may read; the app also refuses what it would refuse for a copy out.
      const access = workspace ? workspaceContextAccess(workspace) : "forbidden";
      if (access !== "allowed") {
        set({ notice: { kind: "refused", refusal: access, ...(workspace ? { workspace: workspace.name } : {}) } });
        return false;
      }
      if (state.draft.workspace.some((c) => workspaceChoiceKey(c) === workspaceChoiceKey(choice))) return true;
      set({ draft: { ...state.draft, workspace: [...state.draft.workspace, choice] }, notice: null });
      return true;
    },

    removeWorkspacePage(key) {
      set({ draft: { ...state.draft, workspace: state.draft.workspace.filter((c) => workspaceChoiceKey(c) !== key) } });
    },

    offerExcerpt(excerpt) {
      if (!excerptAllowed(excerpt, state.settings, servers)) return false;
      set({ draft: { ...state.draft, excerpt: { ...excerpt, text: excerpt.text.slice(0, MAX_EXCERPT) } } });
      return true;
    },

    async refreshPreview() {
      const seq = ++previewSeq;
      const { selection, wholeSpace } = state.draft;
      try {
        const preview = await previewContext(vault, selection, { wholeSpace });
        if (seq === previewSeq) set({ preview });
      } catch {
        if (seq === previewSeq) set({ preview: null });
      }
    },

    draftProblems() {
      const { selection, wholeSpace, workspace, prompt, model } = state.draft;
      const problems: DraftProblem[] = [];
      const { allowPrivate, allowWholeSpace, allowWorkspace } = state.settings;
      if (selection.length === 0 && !wholeSpace && workspace.length === 0) problems.push("needContext");
      // Permissions only narrow: what they switch off cannot be started with, whatever the draft holds.
      if (selection.length > 0 && !allowPrivate) problems.push("privateOff");
      if (wholeSpace && !allowWholeSpace) problems.push("wholeSpaceOff");
      if (workspace.length > 0 && !allowWorkspace) problems.push("workspaceOff");
      if (prompt.trim() === "") problems.push("needTask");
      if (model.trim() !== "" && !PROVIDER_FEATURES[state.provider].isModelName(model.trim())) problems.push("badModel");
      const code = state.preview?.problem?.code;
      if (code === "too_many") problems.push("contextTooMany");
      else if (code === "too_large") problems.push("contextTooLarge");
      else if (code === "file_too_large") problems.push("contextFileTooLarge");
      else if (code === "not_found" || code === "reserved") problems.push("contextMissing");
      return problems;
    },

    updateSettings(patch) {
      const settings = { ...state.settings, ...patch };
      saveAgentSettings(settings);
      // What Permissions switch off leaves the task being written, so it is never sent by accident.
      const d = state.draft;
      const draft = {
        ...d,
        selection: settings.allowPrivate ? d.selection : [],
        wholeSpace: settings.allowWholeSpace && d.wholeSpace,
        workspace: settings.allowWorkspace ? d.workspace : [],
        excerpt: d.excerpt && excerptAllowed(d.excerpt, settings, servers) ? d.excerpt : null,
      };
      set({ settings, cleared: null, draft });
      if (draft.selection !== d.selection || draft.wholeSpace !== d.wholeSpace) void service.refreshPreview();
    },

    async start() {
      if (state.phase !== "idle" && state.phase !== "finished") return;
      if (service.draftProblems().length > 0) return;
      const { selection, wholeSpace, workspace, prompt, model, timeMinutes, budget, excerpt } = state.draft;
      const provider = state.provider;
      // Only a CLI that enforces a spending limit gets one; Codex has none, and none is pretended.
      const budgetUsd = !PROVIDER_FEATURES[provider].budget ? null : budget === "default" ? state.settings.budgetUsd : budget === "none" ? null : budget;
      const minutes = timeMinutes === "default" ? state.settings.timeMinutes : timeMinutes;
      set({ phase: "starting", error: null, notice: null, events: [], answer: null, changes: null, approved: [], results: null, record: null, detail: null });
      try {
        const { record, finished } = await hub.start(
          {
            provider,
            prompt,
            // Checked again at Start: a workspace's rules can change while the bubble is open.
            ...(excerpt && excerptAllowed(excerpt, state.settings, servers) ? { excerpt: { text: excerpt.text, ...(excerpt.from ? { from: excerpt.from } : {}) } } : {}),
            selection: wholeSpace ? [] : selection,
            ...(wholeSpace ? { wholeSpace: true } : {}),
            ...(workspace.length > 0 ? { workspacePages: workspace.map(({ server, workspace: ws, page }) => ({ server, workspace: ws, page })) } : {}),
            ...(model.trim() ? { model: model.trim() } : {}),
            ...(budgetUsd !== null ? { maxBudgetUsd: budgetUsd } : {}),
            timeoutMs: minutesToMs(minutes),
          },
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
          answer: hub.answer(done.id),
          changes: done.state === "review" ? changes : null,
          approved: done.state === "review" ? (changes ?? []).filter((c) => c.problem === undefined).map((c) => c.path) : [],
          phase: done.state === "review" ? "review" : "finished",
        });
      } catch (error) {
        if (error instanceof AgentUnavailableError) set({ status: error.status, statuses: { ...state.statuses, [state.provider]: error.status }, phase: "idle", error: null });
        else if (error instanceof WorkspaceContextError) set({ phase: "idle", error: null, notice: { kind: "refused", refusal: error.refusal, ...(error.workspace ? { workspace: error.workspace } : {}) } });
        else set({ phase: "idle", error: error instanceof StagingError || error instanceof LimitError ? error.message : message(error) });
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

    async reopenReview(id) {
      if (state.phase !== "idle" && state.phase !== "finished") return;
      try {
        const reopened = await hub.reopen(id);
        if (!reopened) {
          set({ notice: { kind: "reviewGone" } });
          await refreshHistory();
          return;
        }
        const details = await hub.details(id).catch(() => null);
        set({
          phase: "review",
          record: reopened.record,
          events: details?.events ?? [],
          answer: hub.answer(id) ?? details?.answer ?? null,
          changes: reopened.changes,
          approved: reopened.changes.filter((c) => c.problem === undefined).map((c) => c.path),
          results: null,
          error: null,
          notice: null,
          detail: null,
        });
      } catch (error) {
        set({ error: message(error) });
      }
      await refreshHistory();
    },

    async openDetails(id) {
      const record = state.history.find((r) => r.id === id);
      if (!record) return;
      set({ detail: { record, loading: true, details: null } });
      const details = await hub.details(id).catch(() => null);
      if (state.detail?.record.id === id) set({ detail: { record, loading: false, details } });
    },

    closeDetails() {
      set({ detail: null });
    },

    async clearHistory() {
      const cleared = await hub.clearDetails().catch(() => 0);
      set({ cleared, detail: null });
      await refreshHistory();
    },

    async newTask() {
      if (state.phase === "running" || state.phase === "cancelling" || state.phase === "starting" || state.phase === "applying") return;
      if (state.record && state.phase !== "review") await hub.close(state.record.id);
      set({ phase: "idle", record: null, events: [], answer: null, changes: null, approved: [], results: null, error: null, notice: null, draft: { ...state.draft, prompt: "", excerpt: null } });
    },

    async askAgain(id) {
      const busy = state.phase === "running" || state.phase === "cancelling" || state.phase === "starting" || state.phase === "applying" || state.phase === "review";
      const record = id === undefined || id === state.record?.id ? state.record : (state.history.find((r) => r.id === id) ?? null);
      if (busy || !record) return false;
      const current = record.id === state.record?.id;
      const prompt = record.task.prompt;
      await service.newTask();
      if (current) set({ draft: { ...state.draft, prompt } });
      else {
        // What the run was given from the Private Space (folders come back as the files they gave); workspace pages
        // need their server, which the record does not keep, so they are picked again.
        const wholeSpace = record.task.wholeSpace === true;
        const selection = wholeSpace ? [] : [...new Set(record.context.filter((c) => !c.readOnly && (c.via === "selected" || c.via === "folder")).map((c) => c.path))].sort();
        set({ draft: { ...state.draft, prompt, selection, wholeSpace, workspace: [], excerpt: null } });
        void service.refreshPreview();
      }
      return true;
    },

    refresh: () => refreshHistory(),

    runDetails: (id) => hub.details(id).catch(() => null),

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
