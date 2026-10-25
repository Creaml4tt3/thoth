/**
 * `AgentHub` runs one task end to end (ADR-0007): detect the CLI, stage the selected context into a fresh working
 * directory, start the provider, relay its events, then collect the proposed changes for review. Nothing reaches
 * the vault until `apply` is called with the paths the user approved, and then only through compare-and-swap.
 *
 * Each run has a durable record (`records.ts`) updated at every step. Working directories are the host's and are
 * deleted as soon as they are no longer needed: on cancel, when a run proposed nothing, after apply (unless a
 * conflict may still be kept as a copy), on discard, and on `recover()` after a crash (`host.sweep()`), which also
 * marks unfinished records `interrupted`.
 */
import { newStableId } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";
import { applyChanges, saveAsCopy, type ApplyResult } from "./apply.ts";
import type { AgentHost } from "./host.ts";
import { listRuns, MAX_PROMPT_CHARS, pruneRuns, TERMINAL_STATES, writeRun, type ChangeRecord, type RunRecord } from "./records.ts";
import { collectChanges, DEFAULT_REVIEW_LIMITS, type ProposedChange, type ReviewLimits } from "./review.ts";
import { DEFAULT_STAGING_LIMITS, stageContext, type ContextEntry, type StagingLimits } from "./staging.ts";
import type { AgentEvent, AgentInstallationStatus, AgentProvider } from "./types.ts";

export interface StartTask {
  provider: string;
  prompt: string;
  /** Vault paths of pages, files or folders. */
  selection: readonly string[];
  model?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
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
  workspace: string;
  provider: AgentProvider;
  context: ContextEntry[];
  changes: ProposedChange[] | null;
  /** The working directory still exists. */
  open: boolean;
}

export interface AgentHubOptions {
  vault: Vault;
  host: AgentHost;
  providers: readonly AgentProvider[];
  now?: () => number;
  staging?: StagingLimits;
  review?: ReviewLimits;
}

export class AgentHub {
  private readonly vault: Vault;
  private readonly host: AgentHost;
  private readonly providerList: readonly AgentProvider[];
  private readonly now: () => number;
  private readonly staging: StagingLimits;
  private readonly reviewLimits: ReviewLimits;
  private readonly live = new Map<string, Live>();
  /** Serializes record writes per run, so a late event never overwrites a newer state. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(options: AgentHubOptions) {
    this.vault = options.vault;
    this.host = options.host;
    this.providerList = options.providers;
    this.now = options.now ?? Date.now;
    this.staging = options.staging ?? DEFAULT_STAGING_LIMITS;
    this.reviewLimits = options.review ?? DEFAULT_REVIEW_LIMITS;
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
   * After a start: runs whose working directory went with the previous session become `interrupted`, and the host
   * deletes every working directory it no longer owns.
   */
  async recover(): Promise<{ interrupted: string[]; swept: number }> {
    const interrupted: string[] = [];
    for (const record of await listRuns(this.vault)) {
      if (TERMINAL_STATES.has(record.state) || this.live.has(record.id)) continue;
      record.state = "interrupted";
      await this.save(record);
      interrupted.push(record.id);
    }
    const swept = await this.host.sweep().catch(() => 0);
    return { interrupted, swept };
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
    const status = await provider.detect();
    if (status.state !== "ready") throw new AgentUnavailableError(status);

    const { run: workspace } = await this.host.createRun(provider.id);
    let context: ContextEntry[];
    try {
      context = await stageContext(this.vault, this.host.files(workspace), task.selection, this.staging);
    } catch (error) {
      await this.host.dispose(workspace).catch(() => undefined);
      throw error;
    }
    const now = this.now();
    const record: RunRecord = {
      version: 1,
      id: newStableId(now),
      provider: { id: provider.id, name: provider.name, version: status.version },
      task: { prompt, ...(task.model ? { model: task.model } : {}), ...(task.maxBudgetUsd !== undefined ? { maxBudgetUsd: task.maxBudgetUsd } : {}) },
      context: context.map((c) => ({ ...c })),
      state: "running",
      createdAt: now,
      updatedAt: now,
      changes: [],
    };
    const live: Live = { record, workspace, provider, context, changes: null, open: true };
    this.live.set(record.id, live);
    await pruneRuns(this.vault).catch(() => undefined);
    await this.save(record);
    try {
      await provider.startTask({ workspace, prompt, ...(task.model ? { model: task.model } : {}), ...(task.maxBudgetUsd !== undefined ? { maxBudgetUsd: task.maxBudgetUsd } : {}), ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}) });
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
    return this.followNow(live, onEvent).catch(() => structuredClone(live.record));
  }

  private async followNow(live: Live, onEvent: (event: AgentEvent) => void): Promise<RunRecord> {
    const record = live.record;
    let result: Extract<AgentEvent, { type: "result" }> | null = null;
    let error: Extract<AgentEvent, { type: "error" }> | null = null;
    let exit: Extract<AgentEvent, { type: "exit" }> | null = null;
    try {
      for await (const event of live.provider.streamEvents(live.workspace)) {
        if (event.type === "result") result = event;
        else if (event.type === "error") error ??= event;
        else if (event.type === "exit") exit = event;
        try {
          onEvent(event);
        } catch {
          // a listener's problem never stops the run
        }
      }
    } catch (e) {
      error ??= { type: "error", code: "cli", message: e instanceof Error ? e.message : String(e) };
    }
    const reason = exit?.reason ?? "exited";
    const ok = reason === "exited" && exit?.code === 0 && result?.ok === true && error === null;
    record.outcome = {
      reason,
      code: exit?.code ?? null,
      ok,
      ...(result?.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(result?.turns !== undefined ? { turns: result.turns } : {}),
      ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      ...(error ? { error: { code: error.code, message: error.message.slice(0, 500) } } : reason !== "exited" ? { error: { code: reason, message: reason } } : {}),
    };
    if (reason === "cancelled") {
      record.state = "cancelled";
      await this.closeWorkspace(live);
      await this.save(record);
      return structuredClone(record);
    }
    try {
      live.changes = await collectChanges(this.vault, this.host.files(live.workspace), live.context, this.reviewLimits);
    } catch (e) {
      live.changes = [];
      record.outcome.error ??= { code: "review", message: e instanceof Error ? e.message : String(e) };
    }
    record.changes = live.changes.map(toRecord);
    if (live.changes.length > 0) record.state = "review";
    else {
      record.state = ok ? "done" : "failed";
      await this.closeWorkspace(live);
    }
    await this.save(record);
    return structuredClone(record);
  }

  async cancel(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live || live.record.state !== "running") return;
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
    const results = await applyChanges(this.vault, this.host.files(live.workspace), live.changes!, approved);
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
    const copy = await saveAsCopy(this.vault, this.host.files(live.workspace), change, name);
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

  private async closeWorkspace(live: Live): Promise<void> {
    if (!live.open) return;
    live.open = false;
    await this.host.dispose(live.workspace).catch(() => undefined);
  }

  /** Stops every run and deletes every working directory (the vault is closing). Records stay as they are. */
  async dispose(): Promise<void> {
    for (const live of this.live.values()) {
      if (live.record.state === "running") await live.provider.cancelRun(live.workspace).catch(() => undefined);
      await this.closeWorkspace(live);
    }
    this.live.clear();
    await this.writes;
  }
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
