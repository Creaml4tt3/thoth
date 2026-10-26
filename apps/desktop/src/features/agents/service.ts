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
  conversationKey,
  conversationTurns,
  type Conversation,
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
import { AGENT_PROVIDERS, isAgentProvider, loadAgentSettings, saveAgentSettings, type AgentProviderId, type AgentSettings } from "./settings.ts";

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
  /** The conversation this task continues (a follow-up whose pages or settings were changed in the bubble); null: a new one. */
  followUp: string | null;
}

/**
 * What a follow-up is sent with (ADR-0007, "Conversations"): the agent, context and limits of the conversation's last
 * turn as this window started it, or, for a conversation from an earlier session, as its record says.
 */
export interface FollowUpPlan {
  provider: AgentProviderId;
  selection: string[];
  wholeSpace: boolean;
  workspace: WorkspaceChoice[];
  model: string;
  timeMinutes: number | "default";
  budget: number | "none" | "default";
  /** The last turn had workspace pages, which cannot be given again here (their server is not in the record). */
  workspaceDropped: boolean;
}

/** Why a follow-up cannot be sent now. */
export type FollowUpBlock =
  /** Not in the history. */
  | "unknown"
  /** Another window owns the conversation (ADR-0019 rule 8). */
  | "elsewhere"
  /** A turn of it is still running. */
  | "running"
  /** A turn of it waits for review. */
  | "review"
  /** This window is busy with another run. */
  | "busy"
  /** Permissions no longer allow the context it would be sent with. */
  | "notAllowed";

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
  /** Conversations this window started (or continued while alone): it owns them (ADR-0019 rule 8). */
  owned: readonly string[];
  /** A request to focus a conversation's composer ("Ask a follow-up" in the bubble); the nonce changes each time. */
  compose: { conversation: string; nonce: number } | null;
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
   * Back to the form with the task of run `id` (the current run when absent) to send again as a new task (a follow-up
   * in the same conversation is `sendFollowUp`). The current run keeps the draft's context; an earlier one gives the Private
   * Space pages and files it was given (workspace pages are picked again). False when a run is still going.
   */
  askAgain(id?: string): Promise<boolean>;
  /** Reads the run history again (the sidebar's Assistant section and the session tabs follow it). */
  refresh(): Promise<void>;
  /** The local details of a run (transcript, answer, diffs), or null when there are none. */
  runDetails(id: string): Promise<RunDetails | null>;
  /** The conversation run `id` belongs to (its id, the first turn's run id); `id` itself when it is not known. */
  conversationOf(id: string): string;
  /** The turns of the conversation of run `id`, oldest first, with this window's current run as it is now. */
  conversation(id: string): RunRecord[];
  /** Every conversation, the one with the newest turn first (the sidebar's rows). */
  conversations(): Conversation[];
  /** What a follow-up in the conversation of `id` would be sent with; null when it is not known. */
  followUpPlan(id: string): FollowUpPlan | null;
  /** Why a follow-up in the conversation of `id` cannot be sent now, or null when it can. */
  followUpBlock(id: string): FollowUpBlock | null;
  /** Sends `question` as the next turn of the conversation of `id`, with `followUpPlan`. False when it did not start. */
  sendFollowUp(id: string, question: string): Promise<boolean>;
  /** Puts the follow-up in the bubble's form with its context and settings, to change them there before Start. */
  editFollowUp(id: string, question: string): boolean;
  /** Asks the conversation's composer to take focus (the session tab follows `compose`). */
  composeFollowUp(id: string): void;
  recover(): Promise<void>;
  dismissRecovered(): void;
  dispose(): Promise<void>;
}

const EMPTY_DRAFT: Draft = { selection: [], wholeSpace: false, workspace: [], prompt: "", model: "", timeMinutes: "default", budget: "default", excerpt: null, followUp: null };

/** A run to start: the form's draft, or a follow-up's plan with its question. */
type Launch = Omit<Draft, "followUp"> & { provider: AgentProviderId; followUp: string | null };

const GOING: ReadonlySet<RunPhase> = new Set(["starting", "running", "cancelling"]);
const isIdle = (phase: RunPhase) => phase === "idle" || phase === "finished";

/** Problems with what a run would be given, by the Permissions (they only narrow). */
function contextProblems(d: Pick<Draft, "selection" | "wholeSpace" | "workspace">, settings: AgentSettings): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (d.selection.length === 0 && !d.wholeSpace && d.workspace.length === 0) problems.push("needContext");
  if (d.selection.length > 0 && !settings.allowPrivate) problems.push("privateOff");
  if (d.wholeSpace && !settings.allowWholeSpace) problems.push("wholeSpaceOff");
  if (d.workspace.length > 0 && !settings.allowWorkspace) problems.push("workspaceOff");
  return problems;
}

/** What an earlier run was given from the Private Space, to give again (folders come back as the files they gave). */
const privateSelection = (record: RunRecord): string[] => [...new Set(record.context.filter((c) => !c.readOnly && (c.via === "selected" || c.via === "folder")).map((c) => c.path))].sort();

export function createAgentsService(
  vault: Vault,
  host: AgentHost,
  options: { now?: () => number; onApplied?: () => void; servers?: ServerDirectory; settings?: AgentSettings; alone?: () => boolean } = {},
): AgentsService {
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
    owned: [],
    compose: null,
  };
  const servers = options.servers;
  const alone = options.alone ?? (() => true);
  /** How each conversation's last turn in this window was started (its workspace pages need their server). */
  const plans = new Map<string, Omit<FollowUpPlan, "workspaceDropped">>();
  let composeNonce = 0;
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

  /** Starts a run (a new task, or the next turn of a conversation) and follows it to its end. True when it started. */
  async function launch(input: Launch, onStarted: () => void = () => undefined): Promise<boolean> {
    const { selection, wholeSpace, workspace, prompt, model, timeMinutes, budget, excerpt, provider, followUp } = input;
    // Only a CLI that enforces a spending limit gets one; Codex has none, and none is pretended.
    const budgetUsd = !PROVIDER_FEATURES[provider].budget ? null : budget === "default" ? state.settings.budgetUsd : budget === "none" ? null : budget;
    const minutes = timeMinutes === "default" ? state.settings.timeMinutes : timeMinutes;
    set({ phase: "starting", error: null, notice: null, events: [], answer: null, changes: null, approved: [], results: null, record: null, detail: null });
    let started = false;
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
          ...(followUp ? { followUp } : {}),
        },
        (event) => {
          const events = state.events.length >= MAX_EVENTS ? [...state.events.slice(1), event] : [...state.events, event];
          set({ events });
        },
      );
      started = true;
      // This window started the turn, so it owns the conversation; the next turn goes with the same context and limits.
      const key = conversationKey(record);
      plans.set(key, { provider, selection: wholeSpace ? [] : [...selection], wholeSpace, workspace: [...workspace], model, timeMinutes, budget });
      set({ phase: service.getState().phase === "cancelling" ? "cancelling" : "running", record, owned: state.owned.includes(key) ? state.owned : [...state.owned, key] });
      if (state.draft.followUp === key) set({ draft: { ...state.draft, prompt: "", followUp: null } });
      onStarted();
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
      if (error instanceof AgentUnavailableError) set({ status: provider === state.provider ? error.status : state.status, statuses: { ...state.statuses, [provider]: error.status }, phase: "idle", error: null });
      else if (error instanceof WorkspaceContextError) set({ phase: "idle", error: null, notice: { kind: "refused", refusal: error.refusal, ...(error.workspace ? { workspace: error.workspace } : {}) } });
      else set({ phase: "idle", error: error instanceof StagingError || error instanceof LimitError ? error.message : message(error) });
    }
    await refreshHistory();
    return started;
  }

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
      const { prompt, model } = state.draft;
      // Permissions only narrow: what they switch off cannot be started with, whatever the draft holds.
      const problems = contextProblems(state.draft, state.settings);
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
      if (!isIdle(state.phase)) return;
      if (service.draftProblems().length > 0) return;
      await launch({ ...state.draft, provider: state.provider });
    },

    conversationOf(id) {
      const record = state.record?.id === id ? state.record : state.history.find((r) => r.id === id);
      return record ? conversationKey(record) : id;
    },

    conversation(id) {
      const key = service.conversationOf(id);
      // The current run as the service has it now (the history is read again only after each step).
      const records = state.history.filter((r) => r.id !== state.record?.id && conversationKey(r) === key);
      if (state.record && conversationKey(state.record) === key) records.push(state.record);
      return conversationTurns(records)[0]?.turns ?? [];
    },

    conversations() {
      const current = state.record;
      return conversationTurns(current ? [current, ...state.history.filter((r) => r.id !== current.id)] : state.history);
    },

    followUpPlan(id) {
      const key = service.conversationOf(id);
      const kept = plans.get(key);
      if (kept) return { ...kept, workspaceDropped: false };
      const last = service.conversation(id).at(-1);
      if (!last) return null;
      // From the record: the same agent, Private Space context, model and limits (workspace pages are picked again).
      const provider = isAgentProvider(last.provider.id) ? last.provider.id : state.provider;
      const wholeSpace = last.task.wholeSpace === true;
      return {
        provider,
        selection: wholeSpace ? [] : privateSelection(last),
        wholeSpace,
        workspace: [],
        model: last.task.model ?? "",
        timeMinutes: last.task.timeoutMs === undefined ? "default" : Math.round(last.task.timeoutMs / 60_000),
        budget: !PROVIDER_FEATURES[provider].budget ? "default" : last.task.maxBudgetUsd ?? "none",
        workspaceDropped: last.context.some((c) => c.readOnly),
      };
    },

    followUpBlock(id) {
      const key = service.conversationOf(id);
      const turns = service.conversation(id);
      if (turns.length === 0) return "unknown";
      if (!state.owned.includes(key) && !alone()) return "elsewhere";
      const current = state.record !== null && conversationKey(state.record) === key;
      if ((current && GOING.has(state.phase)) || turns.some((t) => t.state === "running" || t.state === "staging")) return "running";
      if ((current && (state.phase === "review" || state.phase === "applying")) || turns.some((t) => t.state === "review")) return "review";
      if (!isIdle(state.phase)) return "busy";
      const plan = service.followUpPlan(id);
      if (!plan || contextProblems(plan, state.settings).length > 0) return "notAllowed";
      return null;
    },

    async sendFollowUp(id, question) {
      if (question.trim() === "" || service.followUpBlock(id) !== null) return false;
      const { workspaceDropped: _dropped, ...plan } = service.followUpPlan(id)!;
      // Resolves once the turn runs (or failed to start); the turn itself goes on in the service's state.
      return new Promise<boolean>((resolve) => {
        void launch({ ...plan, prompt: question, excerpt: null, followUp: service.conversationOf(id) }, () => resolve(true)).then((ok) => {
          if (!ok) resolve(false);
        });
      });
    },

    editFollowUp(id, question) {
      const plan = service.followUpPlan(id);
      if (!plan || !isIdle(state.phase) || (!state.owned.includes(service.conversationOf(id)) && !alone())) return false;
      const { provider, workspaceDropped: _dropped, ...draft } = plan;
      if (provider !== state.provider) service.selectProvider(provider);
      set({ draft: { ...draft, prompt: question, excerpt: null, followUp: service.conversationOf(id) }, error: null, notice: null });
      void service.refreshPreview();
      return true;
    },

    composeFollowUp(id) {
      set({ compose: { conversation: service.conversationOf(id), nonce: ++composeNonce } });
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
      set({ phase: "idle", record: null, events: [], answer: null, changes: null, approved: [], results: null, error: null, notice: null, draft: { ...state.draft, prompt: "", excerpt: null, followUp: null } });
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
