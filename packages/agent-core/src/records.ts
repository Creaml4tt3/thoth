/**
 * Agent Hub run records (ADR-0007 rule 7): durable `.thoth/agent/runs/<uuidv7>.json` metadata, one per run, written
 * through the vault's atomic record write (ADR-0001 §2, like transfer operations). They hold the provider and its
 * version, the task as the user wrote it, the selected context (paths and hashes), the proposed changes with the
 * user's decision and the apply result, and the outcome. Never page content, agent output text or credentials.
 * They live with the vault because the context, approvals and writes are the vault's.
 *
 * What a run printed (the transcript) and the files it proposed are kept elsewhere: `details.ts`, in the app data
 * folder, never in the vault.
 */
import { z } from "zod";
import type { Vault } from "@thoth/local-store";

export const RUNS_DIR = ".thoth/agent/runs";
export const RECORD_VERSION = 1;
/** Older finished records beyond this many are removed when a new run starts. */
export const MAX_RECORDS = 200;
export const MAX_PROMPT_CHARS = 20_000;

export const runPath = (id: string): string => `${RUNS_DIR}/${id}.json`;

export const RunStateSchema = z.enum([
  /** Copying the context into the working directory. */
  "staging",
  "running",
  /** The CLI finished and left changes to review. */
  "review",
  /** Some or all approved changes were written (see each change's result). */
  "applied",
  /** The user discarded the proposed changes, or the run proposed none. */
  "done",
  "discarded",
  "cancelled",
  "failed",
  /** Thoth stopped (quit or crash) before the run was finished; its working directory is gone. */
  "interrupted",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["applied", "done", "discarded", "cancelled", "failed", "interrupted"]);

export const ContextEntrySchema = z.object({
  path: z.string(),
  hash: z.string(),
  size: z.number(),
  kind: z.enum(["page", "file"]),
  via: z.enum(["selected", "folder", "linked", "space", "workspace"]),
  /** A reference copy (a workspace page): changes to it are discarded. */
  readOnly: z.boolean().optional(),
  workspace: z.object({ workspaceId: z.string(), workspaceName: z.string(), pageId: z.string(), title: z.string(), revisionId: z.string() }).optional(),
});

const ChangeRecordSchema = z.object({
  path: z.string(),
  change: z.enum(["modified", "added", "deleted"]),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  problem: z.string().optional(),
  stale: z.boolean().optional(),
  decision: z.enum(["pending", "approved", "rejected"]),
  result: z.enum(["applied", "conflict", "failed", "copied"]).optional(),
  /** Where the agent's version was kept after a conflict. */
  copy: z.string().optional(),
  error: z.string().optional(),
});
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

export const RunRecordSchema = z.object({
  version: z.literal(RECORD_VERSION),
  id: z.string(),
  provider: z.object({ id: z.string(), name: z.string(), version: z.string().optional() }),
  task: z.object({
    prompt: z.string(),
    model: z.string().optional(),
    maxBudgetUsd: z.number().optional(),
    /** The time limit this run had, in milliseconds. */
    timeoutMs: z.number().optional(),
    /** The whole Private Space was the context. */
    wholeSpace: z.boolean().optional(),
  }),
  context: z.array(ContextEntrySchema),
  state: RunStateSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  outcome: z
    .object({
      reason: z.enum(["exited", "cancelled", "timeout", "output_limit", "spawn_failed"]),
      code: z.number().nullable(),
      ok: z.boolean(),
      costUsd: z.number().optional(),
      turns: z.number().optional(),
      durationMs: z.number().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
      /** The model that answered, as the CLI reported it. */
      model: z.string().optional(),
      /** The run was stopped by its time limit or used up its budget. */
      stoppedBy: z.enum(["time", "budget"]).optional(),
    })
    .optional(),
  changes: z.array(ChangeRecordSchema),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export async function writeRun(vault: Vault, record: RunRecord): Promise<void> {
  await vault.writeRecord(runPath(record.id), record);
}

/** One record, or null when it is missing or unreadable. */
export async function readRun(vault: Vault, id: string): Promise<RunRecord | null> {
  try {
    const parsed = RunRecordSchema.safeParse(await vault.readRecord(runPath(id)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Every readable record, newest first. Unreadable ones are skipped (they are metadata, never content). */
export async function listRuns(vault: Vault): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  for (const name of await vault.listRecords(RUNS_DIR)) {
    try {
      const parsed = RunRecordSchema.safeParse(await vault.readRecord(`${RUNS_DIR}/${name}`));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // malformed JSON: leave it for the user to inspect
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/** Removes the oldest finished records beyond `keep`. */
export async function pruneRuns(vault: Vault, keep = MAX_RECORDS): Promise<void> {
  const runs = await listRuns(vault);
  for (const run of runs.slice(keep)) if (TERMINAL_STATES.has(run.state)) await vault.removeRecord(runPath(run.id)).catch(() => undefined);
}
