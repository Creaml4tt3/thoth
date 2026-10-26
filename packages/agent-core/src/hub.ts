/**
 * `AgentHub` runs one task end to end (ADR-0007): detect the CLI, stage the selected context into a fresh working
 * directory, start the provider, relay its events, then collect the proposed changes for review. Nothing reaches
 * the vault until `apply` is called with the paths the user approved, and then only through compare-and-swap.
 *
 * Each run has a durable record (`records.ts`) updated at every step. Working directories are the host's and are
 * deleted as soon as they are no longer needed: on cancel, when a run proposed nothing, after apply (unless a
 * conflict may still be kept as a copy), on discard, and on `recover()` after a crash (`host.sweep()`), which also
 * marks unfinished records `interrupted`.
 *
 * Besides the record, a run leaves local-only details in the app data folder (`details.ts`): its transcript and the
 * proposed files. A run that was waiting for review when the app stopped is not `interrupted` when those are intact:
 * `recover()` keeps it, `reopen()` rebuilds its review from them, and `apply()` still uses compare-and-swap against
 * the hashes recorded at staging. Details are pruned by age (`pruneDetails`) after every run and at start.
 */
import { newStableId } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";
import { AnswerTracker, runAnswer } from "./answer.ts";
import { applyChanges, saveAsCopy, type ApplyResult, type ReviewedFiles } from "./apply.ts";
import { conversationKey, conversationTurns, fitConversation, turnOf, type ConversationFit, type EarlierTurn } from "./conversation.ts";
import { loadReview, loadRunDetails, loadTranscript, rebuildChanges, reviewIsIntact, saveReview, storedFiles, TranscriptSaver, type RunDetails } from "./details.ts";
import type { AgentHost } from "./host.ts";
import { checkBudgetUsd, checkTimeLimitMs, DEFAULT_RETENTION_DAYS, LimitError } from "./limits.ts";
import { listRuns, MAX_PROMPT_CHARS, pruneRuns, readRun, TERMINAL_STATES, writeRun, type ChangeRecord, type RunRecord } from "./records.ts";
import { collectChanges, DEFAULT_REVIEW_LIMITS, type ProposedChange, type ReviewLimits } from "./review.ts";
import { DEFAULT_STAGING_LIMITS, stageContext, workspaceFraming, type ContextEntry, type StagingLimits } from "./staging.ts";
import type { AgentEvent, AgentInstallationStatus, AgentProvider } from "./types.ts";
import { WorkspaceContextError, type WorkspacePageRef, type WorkspaceReader } from "./workspace.ts";

export interface StartTask {
  provider: string;
  prompt: string;
  /** Vault paths of pages, files or folders. */
  selection: readonly string[];
  /** The whole Private Space (everything but `.thoth/`). */
  wholeSpace?: boolean;
  /** Workspace pages, given read-only: any change to them is discarded (needs a `WorkspaceReader`). */
  workspacePages?: readonly WorkspacePageRef[];
  model?: string;
  /** US dollars, more than 0 and at most 100; none means no limit. */
  maxBudgetUsd?: number;
  /** Milliseconds, from 1 second to 24 hours; the host's default (30 minutes) when absent. */
  timeoutMs?: number;
  /**
   * Text the user selected in a page, quoted to the CLI after the task (at most `MAX_EXCERPT_CHARS`). Like the workspace
   * framing it is sent but not kept: the run record holds only the user's own words, never page text (spec §3.3).
   */
  excerpt?: { text: string; from?: string };
  /**
   * A follow-up question (ADR-0007, "Conversations"): the id of any run of the conversation it continues. The run is a
   * new one-shot run like any other; its earlier turns (questions and answers, oldest first) are quoted to the CLI in
   * front of `prompt`, the newest that fit, and the record keeps only `prompt` with the conversation's id and the turn.
   */
  followUp?: string;
}

/** The longest selected-text excerpt quoted after a task. */
export const MAX_EXCERPT_CHARS = 4000;

/** The excerpt as the CLI reads it, after the task; "" when there is none. */
export function quoteExcerpt(excerpt: StartTask["excerpt"]): string {
  if (!excerpt || excerpt.text.trim() === "") return "";
  return `\n\nSelected text${excerpt.from ? ` (from ${excerpt.from})` : ""}:\n"""\n${excerpt.text.slice(0, MAX_EXCERPT_CHARS)}\n"""\n`;
}

export class AgentUnavailableError extends Error {
  readonly status: AgentInstallationStatus;

  constructor(status: AgentInstallationStatus) {
    super(`The agent CLI is not ready (${status.state})`);
    this.name = "AgentUnavailableError";
    this.status = status;
  }
}

export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStateError";
  }
}

interface Live {
  record: RunRecord;
  /** The host's handle for the working directory; null for a review reopened from stored details. */
  workspace: string | null;
  provider: AgentProvider | null;
  context: ContextEntry[];
  changes: ProposedChange[] | null;
  /** Where the agent's bytes can still be read (the working directory, or the stored files). */
  open: boolean;
  /** Set for a reopened review: the agent's bytes come from the stored files. */
  stored?: ReviewedFiles;
  /** What the agent said at the end (`runAnswer`), once the run ended. Agent output: never in the record. */
  answer: string | null;
}

export interface AgentHubOptions {
  vault: Vault;
  host: AgentHost;
  providers: readonly AgentProvider[];
  now?: () => number;
  staging?: StagingLimits;
  review?: ReviewLimits;
  /** Reads workspace pages for read-only context; without it a task naming workspace pages is refused. */
  workspace?: WorkspaceReader;
  /** How many days local run details are kept (0: for ever), asked each time so a setting change applies at once. */
  retentionDays?: () => number;
  /** How often a running transcript is written to the host. */
  transcriptFlushMs?: number;
}

export class AgentHub {
  private readonly vault: Vault;
  private readonly host: AgentHost;
  private readonly providerList: readonly AgentProvider[];
  private readonly now: () => number;
  private readonly staging: StagingLimits;
  private readonly reviewLimits: ReviewLimits;
  private readonly live = new Map<string, Live>();
  private readonly workspaceReader: WorkspaceReader | undefined;
  private readonly retentionDays: () => number;
  private readonly transcriptFlushMs: number | undefined;
  /** Serializes record writes per run, so a late event never overwrites a newer state. */
  private writes: Promise<unknown> = Promise.resolve();
  /** Conversations a follow-up is being started for (before its record exists), so two cannot start at once. */
  private readonly asking = new Set<string>();

  constructor(options: AgentHubOptions) {
    this.vault = options.vault;
    this.host = options.host;
    this.providerList = options.providers;
    this.now = options.now ?? Date.now;
    this.staging = options.staging ?? DEFAULT_STAGING_LIMITS;
    this.reviewLimits = options.review ?? DEFAULT_REVIEW_LIMITS;
    this.workspaceReader = options.workspace;
    this.retentionDays = options.retentionDays ?? (() => DEFAULT_RETENTION_DAYS);
    this.transcriptFlushMs = options.transcriptFlushMs;
  }

  providers(): readonly AgentProvider[] {
    return this.providerList;
  }

  provider(id: string): AgentProvider {
    const found = this.providerList.find((p) => p.id === id);
    if (!found) throw new Error(`Unknown agent provider ${id}`);
    return found;
  }

  private save(record: RunRecord): Promise<void> {
    record.updatedAt = this.now();
    const snapshot = structuredClone(record);
    const write = this.writes.then(() => writeRun(this.vault, snapshot));
    this.writes = write.catch(() => undefined);
    return write;
  }

  /**
   * After a start: the host deletes every working directory it no longer owns. Runs that were still going become
   * `interrupted`; a run that was waiting for review stays so (`awaitingReview`) when its stored details are intact,
   * because the review can be rebuilt from them. Old details are pruned.
   */
  async recover(): Promise<{ interrupted: string[]; awaitingReview: string[]; swept: number }> {
    const interrupted: string[] = [];
    const awaitingReview: string[] = [];
    const listing = await this.host.history.list().catch(() => []);
    for (const record of await listRuns(this.vault)) {
      if (TERMINAL_STATES.has(record.state) || this.live.has(record.id)) continue;
      if (record.state === "review") {
        const review = await loadReview(this.host.history, record.id);
        if (review && reviewIsIntact(review, listing.find((r) => r.id === record.id))) {
          awaitingReview.push(record.id);
          continue;
        }
      }
      record.state = "interrupted";
      await this.save(record);
      interrupted.push(record.id);
    }
    const swept = await this.host.sweep().catch(() => 0);
    await this.pruneDetails().catch(() => 0);
    return { interrupted, awaitingReview, swept };
  }

  history(): Promise<RunRecord[]> {
    return listRuns(this.vault);
  }

  /** The record of a run this session knows, or null. */
  current(id: string): RunRecord | null {
    const live = this.live.get(id);
    return live ? structuredClone(live.record) : null;
  }

  /**
   * Stages the context and starts the CLI. Resolves once the CLI runs, with `finished` settling when it has exited
   * and its changes were collected. `onEvent` gets every event as it arrives.
   */
  async start(task: StartTask, onEvent: (event: AgentEvent) => void = () => undefined): Promise<{ record: RunRecord; finished: Promise<RunRecord> }> {
    const provider = this.provider(task.provider);
    const prompt = task.prompt.trim();
    if (prompt === "") throw new RunStateError("Write a task for the agent first");
    if (prompt.length > MAX_PROMPT_CHARS) throw new RunStateError(`The task is longer than ${MAX_PROMPT_CHARS} characters`);
    if (task.maxBudgetUsd !== undefined) {
      checkBudgetUsd(task.maxBudgetUsd);
      // A limit that was asked for but cannot be enforced is refused, never silently dropped.
      if (!(await provider.getCapabilities()).includes("spending-limit")) throw new LimitError("budget", `${provider.name} has no spending limit`);
    }
    if (task.timeoutMs !== undefined) checkTimeLimitMs(task.timeoutMs);
    const thread = task.followUp === undefined ? null : await this.thread(task.followUp);
    if (thread) this.asking.add(thread.id);
    try {
      return await this.startTurn(task, provider, prompt, thread, onEvent);
    } finally {
      if (thread) this.asking.delete(thread.id);
    }
  }

  /**
   * The conversation a follow-up continues, by the id of any of its runs. Refused when it is not in the history, or
   * while one of its turns still runs or waits for review (the review comes first).
   */
  private async thread(id: string): Promise<{ id: string; turn: number; earlier: RunRecord[] }> {
    const records = await listRuns(this.vault);
    const target = records.find((r) => r.id === id) ?? this.live.get(id)?.record;
    if (!target) throw new RunStateError("That conversation is not in the history of this Private Space");
    const key = conversationKey(target);
    const turns = conversationTurns(records).find((c) => c.id === key)?.turns ?? [target];
    if (this.asking.has(key)) throw new RunStateError("The last turn of this conversation is still running");
    for (const turn of turns) {
      const state = this.live.get(turn.id)?.record.state ?? turn.state;
      if (state === "staging" || state === "running") throw new RunStateError("The last turn of this conversation is still running");
      if (state === "review") throw new RunStateError("The last turn of this conversation is waiting for review: apply or discard its changes first");
    }
    return { id: key, turn: Math.max(...turns.map(turnOf)) + 1, earlier: turns };
  }

  /** What an earlier turn answered: from memory for a run this session knows, else from its local transcript. */
  private async earlierAnswer(id: string): Promise<{ kept: boolean; answer: string | null }> {
    const live = this.live.get(id);
    if (live && live.record.state !== "running" && live.record.state !== "staging") return { kept: true, answer: live.answer };
    const events = await loadTranscript(this.host.history, id).catch(() => null);
    return events === null ? { kept: false, answer: null } : { kept: true, answer: runAnswer(events) };
  }

  private async startTurn(task: StartTask, provider: AgentProvider, prompt: string, thread: { id: string; turn: number; earlier: RunRecord[] } | null, onEvent: (event: AgentEvent) => void): Promise<{ record: RunRecord; finished: Promise<RunRecord> }> {
    const status = await provider.detect();
    if (status.state !== "ready") throw new AgentUnavailableError(status);

    // Workspace pages are read first, with the user's own access: a refusal stops the run before anything is staged.
    const refs = dedupeRefs(task.workspacePages ?? []);
    let documents: Awaited<ReturnType<WorkspaceReader["readMany"]>> = [];
    if (refs.length > 0) {
      if (!this.workspaceReader) throw new WorkspaceContextError("unavailable", "Workspace pages are not available here");
      documents = await this.workspaceReader.readMany(refs);
    }

    const { run: workspace, dir } = await this.host.createRun(provider.id);
    let context: ContextEntry[];
    try {
      context = await stageContext(this.vault, this.host.files(workspace), task.selection, this.staging, { ...(task.wholeSpace ? { wholeSpace: true } : {}), workspace: documents });
    } catch (error) {
      await this.host.dispose(workspace).catch(() => undefined);
      throw error;
    }
    // A follow-up's earlier turns: an answer can quote what its turn was given, so a turn goes along only when this one
    // is given the same kind of material (Private Space pages, the same workspaces), checked on what was staged now.
    let fit: ConversationFit | null = null;
    if (thread) {
      const privatePages = context.some((c) => !c.readOnly);
      const workspaces = new Set(context.flatMap((c) => (c.workspace ? [c.workspace.workspaceId] : [])));
      const earlier: EarlierTurn[] = [];
      for (const turn of thread.earlier) {
        const { kept, answer } = await this.earlierAnswer(turn.id);
        const allowed = turn.context.every((c) => (c.readOnly || c.workspace ? c.workspace !== undefined && workspaces.has(c.workspace.workspaceId) : privatePages));
        earlier.push({ turn: turnOf(turn), question: turn.task.prompt, answer, kept, allowed });
      }
      fit = fitConversation(earlier, prompt);
    }
    const now = this.now();
    const id = newStableId(now);
    const record: RunRecord = {
      version: 1,
      id,
      provider: { id: provider.id, name: provider.name, version: status.version },
      task: {
        prompt,
        ...(task.model ? { model: task.model } : {}),
        ...(task.maxBudgetUsd !== undefined ? { maxBudgetUsd: task.maxBudgetUsd } : {}),
        ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
        ...(task.wholeSpace ? { wholeSpace: true } : {}),
      },
      context: context.map((c) => ({ ...c, ...(c.workspace ? { workspace: { ...c.workspace } } : {}) })),
      state: "running",
      createdAt: now,
      updatedAt: now,
      changes: [],
      conversation: thread && fit ? { id: thread.id, turn: thread.turn, context: { earlier: fit.earlier, sent: fit.sent, deleted: fit.deleted, notAllowed: fit.notAllowed } } : { id, turn: 1 },
    };
    const live: Live = { record, workspace, provider, context, changes: null, open: true, answer: null };
    this.live.set(record.id, live);
    await pruneRuns(this.vault).catch(() => undefined);
    await this.save(record);
    try {
      // The reference folder is announced to the model, in front of the user's own words (the record keeps only those).
      const readOnly = context.find((c) => c.readOnly);
      // A follow-up's earlier turns come first; like the framing and the excerpt they are sent, never recorded.
      const framed = (fit?.context ?? "") + (readOnly ? workspaceFraming(readOnly.path.split("/")[0]!) + prompt : prompt) + quoteExcerpt(task.excerpt);
      await provider.startTask({ workspace, dir, prompt: framed, ...(task.model ? { model: task.model } : {}), ...(task.maxBudgetUsd !== undefined ? { maxBudgetUsd: task.maxBudgetUsd } : {}), ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}) });
    } catch (error) {
      record.state = "failed";
      record.outcome = { reason: "spawn_failed", code: null, ok: false, error: { code: "spawn", message: error instanceof Error ? error.message : String(error) } };
      await this.closeWorkspace(live);
      await this.save(record);
      throw error;
    }
    const finished = this.follow(live, onEvent);
    return { record: structuredClone(record), finished };
  }

  /** Never rejects: a run that ends while the vault closes keeps its last saved record (recovery marks it). */
  private follow(live: Live, onEvent: (event: AgentEvent) => void): Promise<RunRecord> {
    return this.followNow(live, onEvent)
      .catch(() => structuredClone(live.record))
      .finally(() => this.pruneDetails().catch(() => 0));
  }

  private async followNow(live: Live, onEvent: (event: AgentEvent) => void): Promise<RunRecord> {
    const record = live.record;
    let result: Extract<AgentEvent, { type: "result" }> | null = null;
    let error: Extract<AgentEvent, { type: "error" }> | null = null;
    let exit: Extract<AgentEvent, { type: "exit" }> | null = null;
    let model: string | undefined;
    const transcript = new TranscriptSaver(this.host.history, record.id, this.transcriptFlushMs);
    const answer = new AnswerTracker();
    try {
      for await (const event of live.provider!.streamEvents(live.workspace!)) {
        if (event.type === "result") result = event;
        else if (event.type === "error") error ??= event;
        else if (event.type === "exit") exit = event;
        else if (event.type === "session") model ??= event.model;
        transcript.push(event);
        answer.push(event);
        try {
          onEvent(event);
        } catch {
          // a listener's problem never stops the run
        }
      }
    } catch (e) {
      error ??= { type: "error", code: "cli", message: e instanceof Error ? e.message : String(e) };
    }
    await transcript.close();
    live.answer = answer.answer();
    const reason = exit?.reason ?? "exited";
    const ok = reason === "exited" && exit?.code === 0 && result?.ok === true && error === null;
    record.outcome = {
      reason,
      code: exit?.code ?? null,
      ok,
      ...(result?.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(result?.tokens ? { tokens: { ...result.tokens } } : {}),
      ...(result?.turns !== undefined ? { turns: result.turns } : {}),
      ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      ...(error ? { error: { code: error.code, message: error.message.slice(0, 500) } } : reason !== "exited" ? { error: { code: reason, message: reason } } : {}),
      ...(model ? { model } : {}),
      // Why it stopped, when it was a limit: the host's time limit, or the CLI's own budget (error_max_budget_usd).
      ...(reason === "timeout" ? { stoppedBy: "time" as const } : error?.code === "budget" ? { stoppedBy: "budget" as const } : {}),
    };
    if (reason === "cancelled") {
      record.state = "cancelled";
      await this.closeWorkspace(live);
      await this.save(record);
      return structuredClone(record);
    }
    try {
      live.changes = await collectChanges(this.vault, this.host.files(live.workspace!), live.context, this.reviewLimits);
    } catch (e) {
      live.changes = [];
      record.outcome.error ??= { code: "review", message: e instanceof Error ? e.message : String(e) };
    }
    record.changes = live.changes.map(toRecord);
    if (live.changes.length > 0) {
      record.state = "review";
      // So the review can be opened again after a restart. If this cannot be stored, it is reviewable only now.
      await saveReview(this.host.history, record.id, this.vault, this.filesOf(live), live.changes, live.context, this.now()).catch(() => undefined);
    } else {
      record.state = ok ? "done" : "failed";
      await this.closeWorkspace(live);
    }
    await this.save(record);
    return structuredClone(record);
  }

  /**
   * Opens again the review of a run that was waiting when the app stopped (its record says `review` and `recover()`
   * kept it). The changes are rebuilt from the stored files; `stale` is judged against the vault as it is now, and
   * applying goes through compare-and-swap against the hashes recorded at staging. Null when there is nothing to open.
   */
  async reopen(id: string): Promise<{ record: RunRecord; changes: ProposedChange[] } | null> {
    const open = this.live.get(id);
    if (open) return open.record.state === "review" && open.changes ? { record: structuredClone(open.record), changes: open.changes } : null;
    const record = await readRun(this.vault, id);
    if (!record || record.state !== "review") return null;
    const review = await loadReview(this.host.history, id);
    const listing = await this.host.history.list().catch(() => []);
    if (!review || !reviewIsIntact(review, listing.find((r) => r.id === id))) return null;
    const changes = await rebuildChanges(this.vault, this.host.history, review);
    record.changes = record.changes.map((c) => ({ ...c, decision: "pending" as const }));
    for (const change of changes) {
      const recorded = record.changes.find((c) => c.path === change.path);
      if (recorded) {
        if (change.problem) recorded.problem = change.problem;
        else delete recorded.problem;
        if (change.stale) recorded.stale = true;
        else delete recorded.stale;
      }
    }
    const events = await loadTranscript(this.host.history, id).catch(() => null);
    this.live.set(id, { record, workspace: null, provider: null, context: review.context, changes, open: true, stored: storedFiles(this.host.history, review), answer: events ? runAnswer(events) : null });
    await this.save(record);
    return { record: structuredClone(record), changes };
  }

  /** What the agent said at the end of a run this session knows (null while it runs, or when it said nothing). */
  answer(id: string): string | null {
    return this.live.get(id)?.answer ?? null;
  }

  /** The transcript and diffs kept for a run (null when none are). */
  details(id: string): Promise<RunDetails | null> {
    return loadRunDetails(this.host.history, id);
  }

  /** Which runs have local details, and which kind. */
  async detailsAvailable(): Promise<Map<string, { transcript: boolean; review: boolean }>> {
    const listing = await this.host.history.list().catch(() => []);
    return new Map(listing.map((r) => [r.id, { transcript: r.files.some((f) => f.name === "transcript.jsonl"), review: r.files.some((f) => f.name === "review.json") }]));
  }

  /** Runs whose details must stay: the ones still going and the ones waiting for review (a finished run is history). */
  private async keepDetails(): Promise<Set<string>> {
    const keep = new Set<string>();
    const open = (state: string) => state === "review" || state === "running" || state === "staging";
    for (const live of this.live.values()) if (open(live.record.state)) keep.add(live.record.id);
    for (const record of await listRuns(this.vault)) if (open(record.state)) keep.add(record.id);
    return keep;
  }

  /** Deletes details older than the retention setting (never a run still open or waiting for review). Returns how many runs. */
  async pruneDetails(): Promise<number> {
    const days = this.retentionDays();
    if (!(days > 0)) return 0;
    const limit = this.now() - days * 24 * 60 * 60 * 1000;
    const keep = await this.keepDetails();
    let removed = 0;
    for (const run of await this.host.history.list()) {
      if (keep.has(run.id) || run.modifiedMs >= limit) continue;
      await this.host.history.delete(run.id);
      removed++;
    }
    return removed;
  }

  /** "Delete history now": all details except runs still open or waiting for review. Returns how many runs. */
  async clearDetails(): Promise<number> {
    const keep = await this.keepDetails();
    let removed = 0;
    for (const run of await this.host.history.list()) {
      if (keep.has(run.id)) continue;
      await this.host.history.delete(run.id);
      removed++;
    }
    return removed;
  }

  async cancel(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live || live.record.state !== "running" || !live.provider || !live.workspace) return;
    await live.provider.cancelRun(live.workspace);
  }

  /** The changes waiting for review (or just applied), or null when the run has none in this session. */
  changes(id: string): ProposedChange[] | null {
    return this.live.get(id)?.changes ?? null;
  }

  private reviewing(id: string): Live {
    const live = this.live.get(id);
    if (!live || live.record.state !== "review" || !live.changes || !live.open) throw new RunStateError("This run has no changes waiting for review");
    return live;
  }

  /**
   * Writes exactly the approved changes (by path) with compare-and-swap. Every other change is recorded as rejected
   * and left alone. The working directory is kept while a conflict can still be saved as a copy.
   */
  async apply(id: string, approvedPaths: readonly string[]): Promise<ApplyResult[]> {
    const live = this.reviewing(id);
    const approved = new Set(approvedPaths);
    const results = await applyChanges(this.vault, this.filesOf(live), live.changes!, approved);
    const byPath = new Map(results.map((r) => [r.path, r]));
    for (const change of live.record.changes) {
      change.decision = approved.has(change.path) && !change.problem ? "approved" : "rejected";
      const r = byPath.get(change.path);
      if (r) {
        change.result = r.result;
        if (r.result === "failed") change.error = r.message.slice(0, 500);
      }
    }
    live.record.state = "applied";
    if (!results.some((r) => r.result === "conflict")) await this.closeWorkspace(live);
    await this.save(live.record);
    return results;
  }

  /** After a conflict: keeps the agent's version of `path` as a new file named by `name(attempt)`. */
  async saveCopy(id: string, path: string, name: (attempt: number) => string): Promise<string> {
    const live = this.live.get(id);
    const change = live?.changes?.find((c) => c.path === path);
    const recorded = live?.record.changes.find((c) => c.path === path);
    if (!live || !live.open || !change || recorded?.result !== "conflict") throw new RunStateError("Only a conflicting change can be kept as a copy");
    const copy = await saveAsCopy(this.vault, this.filesOf(live), change, name);
    recorded.result = "copied";
    recorded.copy = copy;
    if (!live.record.changes.some((c) => c.result === "conflict")) await this.closeWorkspace(live);
    await this.save(live.record);
    return copy;
  }

  /** Drops every proposed change. Nothing is written to the vault. */
  async discard(id: string): Promise<void> {
    const live = this.reviewing(id);
    for (const change of live.record.changes) change.decision = "rejected";
    live.record.state = "discarded";
    await this.closeWorkspace(live);
    await this.save(live.record);
  }

  /** Deletes a finished run's working directory (an applied run kept for conflict copies). */
  async close(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live || live.record.state === "running" || live.record.state === "review") return;
    await this.closeWorkspace(live);
    this.live.delete(id);
  }

  private filesOf(live: Live): ReviewedFiles {
    return live.stored ?? this.host.files(live.workspace!);
  }

  private async closeWorkspace(live: Live): Promise<void> {
    if (!live.open) return;
    live.open = false;
    if (live.workspace !== null) await this.host.dispose(live.workspace).catch(() => undefined);
  }

  /** Stops every run and deletes every working directory (the vault is closing). Records stay as they are. */
  async dispose(): Promise<void> {
    for (const live of this.live.values()) {
      if (live.record.state === "running" && live.provider && live.workspace) await live.provider.cancelRun(live.workspace).catch(() => undefined);
      await this.closeWorkspace(live);
    }
    this.live.clear();
    await this.writes;
  }
}

function dedupeRefs(refs: readonly WorkspacePageRef[]): WorkspacePageRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.server}\n${r.workspace}\n${r.page}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

function toRecord(change: ProposedChange): ChangeRecord {
  return {
    path: change.path,
    change: change.change,
    beforeHash: change.beforeHash,
    afterHash: change.afterHash,
    ...(change.problem ? { problem: change.problem } : {}),
    ...(change.stale ? { stale: true } : {}),
    decision: "pending",
  };
}
