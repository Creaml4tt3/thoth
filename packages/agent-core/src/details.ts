/**
 * Local-only run details (ADR-0007, "History"): the transcript of a run (the events it streamed) and what is needed
 * to open its review again, kept in the app data folder through the host (`AgentHost.history`), never inside the
 * vault. The vault only holds the metadata record (`records.ts`).
 *
 * For each run, under its record's ID:
 *
 *   transcript.jsonl    one event per line, rewritten as the run goes (at most the newest 20 000 events)
 *   after-0001.bin …    the bytes the agent proposed for each change that can be applied
 *   orig-0001.bin …     the page as it was staged (modified and deleted pages), when the vault still had it
 *   review.json         the manifest: context (paths and hashes) and every change; written last, so its presence
 *                       means the files it names are complete
 *
 * A run waiting for review can be opened again from these alone, after the app restarted and the working directory is
 * gone: applying still goes through compare-and-swap against the hashes recorded at staging, so a page that changed
 * meanwhile is a conflict. The agent's bytes are checked against the reviewed hash again at apply time.
 */
import { decodeText } from "@thoth/content";
import { collisionKey, isMarkdownPath, isReservedPath, normalizeVaultPath, sha256Hex } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";
import { z } from "zod";
import type { ReviewedFiles } from "./apply.ts";
import type { AgentHistoryStore, HostHistoryRun } from "./host.ts";
import { ContextEntrySchema } from "./records.ts";
import { readOnlyRoots, refreshAgainstVault, type ProposedChange } from "./review.ts";
import type { ContextEntry } from "./staging.ts";
import type { AgentEvent } from "./types.ts";

export const TRANSCRIPT_FILE = "transcript.jsonl";
export const REVIEW_FILE = "review.json";
/** The transcript keeps the newest events beyond this. */
export const MAX_TRANSCRIPT_EVENTS = 20_000;
/** The most bytes of proposed and original files kept for one run. A run over it simply cannot be reopened. */
export const MAX_STORED_BYTES = 256 * 1024 * 1024;
/** Text shown in a history view: per file, and per run. */
const MAX_VIEW_TEXT = 256 * 1024;
const MAX_VIEW_TOTAL = 2 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const StoredChangeSchema = z.object({
  path: z.string(),
  change: z.enum(["modified", "added", "deleted"]),
  page: z.boolean(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  afterSize: z.number().nullable(),
  problem: z.string().optional(),
  /** The file that holds the agent's bytes. */
  after: z.string().optional(),
  /** The file that holds the page as it was staged. */
  original: z.string().optional(),
});
export type StoredChange = z.infer<typeof StoredChangeSchema>;

const StoredReviewSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  savedAt: z.number(),
  context: z.array(ContextEntrySchema),
  changes: z.array(StoredChangeSchema),
});
export type StoredReview = z.infer<typeof StoredReviewSchema>;

// ------------------------------------------------------------------- transcript

/** Writes a run's events to the host as they come: at most every `flushMs`, and once more on `close()`. Never throws. */
export class TranscriptSaver {
  private readonly history: AgentHistoryStore;
  private readonly runId: string;
  private readonly flushMs: number;
  private events: AgentEvent[] = [];
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<unknown> = Promise.resolve();
  /** True when a write failed: the stored transcript may be incomplete. */
  failed = false;

  constructor(history: AgentHistoryStore, runId: string, flushMs = 2000) {
    this.history = history;
    this.runId = runId;
    this.flushMs = flushMs;
  }

  push(event: AgentEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_TRANSCRIPT_EVENTS + 1000) this.events.splice(0, this.events.length - MAX_TRANSCRIPT_EVENTS);
    this.dirty = true;
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.flushMs);
      if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return void (await this.writing);
    this.dirty = false;
    const events = this.events.length > MAX_TRANSCRIPT_EVENTS ? this.events.slice(-MAX_TRANSCRIPT_EVENTS) : this.events;
    const body = encoder.encode(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    this.writing = this.writing.then(() => this.history.write(this.runId, TRANSCRIPT_FILE, body)).catch(() => void (this.failed = true));
    await this.writing;
  }

  async close(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}

const EVENT_TYPES = new Set(["session", "text", "tool", "tool_error", "denied", "retry", "result", "error", "log", "exit"]);

/** The stored transcript, or null when there is none. Lines that are not events are skipped. */
export async function loadTranscript(history: AgentHistoryStore, runId: string): Promise<AgentEvent[] | null> {
  let bytes: Uint8Array;
  try {
    bytes = await history.read(runId, TRANSCRIPT_FILE);
  } catch {
    return null;
  }
  const events: AgentEvent[] = [];
  for (const line of decoder.decode(bytes).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string" && EVENT_TYPES.has((value as { type: string }).type)) events.push(value as AgentEvent);
    } catch {
      // a line cut short by a crash
    }
  }
  return events;
}

// ----------------------------------------------------------------------- review

const blobName = (kind: "after" | "orig", n: number): string => `${kind}-${String(n).padStart(4, "0")}.bin`;

export class DetailsTooLargeError extends Error {
  constructor() {
    super("The proposed files are too large to keep for review after a restart");
    this.name = "DetailsTooLargeError";
  }
}

/**
 * Stores what is needed to reopen the review of `changes` (as `collectChanges` returned them): the agent's bytes
 * (read from `files` and checked against the reviewed hash), the originals, and the manifest last. Throws when
 * something cannot be stored; the run then stays reviewable only while it is open.
 */
export async function saveReview(history: AgentHistoryStore, runId: string, vault: Vault, files: ReviewedFiles, changes: readonly ProposedChange[], context: StoredReview["context"], now: number): Promise<void> {
  const stored: StoredChange[] = [];
  let total = 0;
  let n = 0;
  const put = async (kind: "after" | "orig", bytes: Uint8Array): Promise<string> => {
    total += bytes.length;
    if (total > MAX_STORED_BYTES) throw new DetailsTooLargeError();
    const name = blobName(kind, ++n);
    await history.write(runId, name, bytes);
    return name;
  };
  for (const change of changes) {
    const entry: StoredChange = { path: change.path, change: change.change, page: change.page, beforeHash: change.beforeHash, afterHash: change.afterHash, afterSize: change.afterSize, ...(change.problem ? { problem: change.problem } : {}) };
    if (change.problem === undefined) {
      if (change.change !== "deleted") {
        const bytes = await files.readFile(change.path);
        if (sha256Hex(bytes) !== change.afterHash) throw new Error(`"${change.path}" changed after it was reviewed`);
        entry.after = await put("after", bytes);
      }
      // The page as it was staged, for the history view's diff; only while the vault still has exactly that.
      if (change.change !== "added" && change.page && !change.stale && change.beforeHash !== null) {
        const original = await vault.fs.readFile(change.path).catch(() => null);
        if (original !== null && sha256Hex(original) === change.beforeHash) entry.original = await put("orig", original);
      }
    }
    stored.push(entry);
  }
  const review: StoredReview = { version: 1, runId, savedAt: now, context: [...context], changes: stored };
  await history.write(runId, REVIEW_FILE, encoder.encode(JSON.stringify(review)));
}

/** The stored manifest of a run, or null when there is none (or it is not one this version wrote). */
export async function loadReview(history: AgentHistoryStore, runId: string): Promise<StoredReview | null> {
  try {
    const parsed = StoredReviewSchema.safeParse(JSON.parse(decoder.decode(await history.read(runId, REVIEW_FILE))));
    return parsed.success && parsed.data.runId === runId ? parsed.data : null;
  } catch {
    return null;
  }
}

/** True when every file the manifest names is there at the size it should have. */
export function reviewIsIntact(review: StoredReview, listed: HostHistoryRun | undefined): boolean {
  if (!listed) return false;
  const sizes = new Map(listed.files.map((f) => [f.name, f.size]));
  return review.changes.every((c) => (c.after === undefined || (sizes.has(c.after) && sizes.get(c.after) === c.afterSize)) && (c.original === undefined || sizes.has(c.original)));
}

/** The agent's bytes for a path, from the stored files. */
export function storedFiles(history: AgentHistoryStore, review: StoredReview): ReviewedFiles {
  const byPath = new Map(review.changes.map((c) => [c.path, c]));
  return {
    async readFile(path) {
      const name = byPath.get(path)?.after;
      if (name === undefined) throw Object.assign(new Error(`No stored file for "${path}"`), { code: "ENOENT" });
      return history.read(review.runId, name);
    },
  };
}

/**
 * The changes of a stored review as `collectChanges` would give them now: the agent's text from the stored files,
 * the vault's current text on the left of each diff, and `stale` where the vault page is no longer the staged one
 * (applying it will be a conflict). Anything under a read-only folder is a `read_only` problem whatever was stored.
 */
export async function rebuildChanges(vault: Vault, history: AgentHistoryStore, review: StoredReview): Promise<ProposedChange[]> {
  const roots = readOnlyRoots(review.context as ContextEntry[]);
  const changes: ProposedChange[] = [];
  for (const stored of review.changes) {
    const readOnly = roots.has(collisionKey(stored.path.split("/")[0]!));
    const change: ProposedChange = { path: stored.path, change: stored.change, page: stored.page, beforeHash: stored.beforeHash, afterHash: stored.afterHash, afterSize: stored.afterSize, stale: false };
    if (readOnly) change.problem = "read_only";
    else if (stored.problem) change.problem = stored.problem as NonNullable<ProposedChange["problem"]>;
    else if (!safeToApply(stored.path)) change.problem = "unsafe_path";
    if (change.problem === undefined) {
      if (stored.change === "deleted") {
        if (stored.page) change.after = null;
      } else if (stored.page && stored.after !== undefined) {
        const decoded = decodeText(await history.read(review.runId, stored.after));
        if (decoded.editable) change.after = decoded.text;
        else change.problem = "not_utf8";
      }
    }
    changes.push(change);
  }
  await refreshAgainstVault(vault, changes);
  return changes;
}

function safeToApply(path: string): boolean {
  try {
    return normalizeVaultPath(path) === path && !isReservedPath(path);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------- viewing

/** One change of a past run for the history view: the original and the proposed text, when they were kept. */
export interface DetailChange {
  path: string;
  change: StoredChange["change"];
  page: boolean;
  problem?: string;
  /** The page as it was staged; null when it was not kept (or the change adds a file). */
  original: string | null;
  /** What the agent proposed; null for a deletion or a file that is not text. */
  after: string | null;
  /** The text was too large to show here. */
  omitted?: boolean;
}

export interface RunDetails {
  events: AgentEvent[];
  /** Null when the review of this run was not kept. */
  changes: DetailChange[] | null;
}

export async function loadRunDetails(history: AgentHistoryStore, runId: string): Promise<RunDetails | null> {
  const events = await loadTranscript(history, runId);
  const review = await loadReview(history, runId);
  if (events === null && review === null) return null;
  let budget = MAX_VIEW_TOTAL;
  const text = async (name: string | undefined, size: number | null): Promise<{ text: string | null; omitted: boolean }> => {
    if (name === undefined) return { text: null, omitted: false };
    if ((size !== null && size > MAX_VIEW_TEXT) || budget <= 0) return { text: null, omitted: true };
    const bytes = await history.read(runId, name).catch(() => null);
    if (bytes === null) return { text: null, omitted: false };
    if (bytes.length > MAX_VIEW_TEXT || bytes.length > budget) return { text: null, omitted: true };
    budget -= bytes.length;
    const decoded = decodeText(bytes);
    return { text: decoded.editable ? decoded.text : null, omitted: false };
  };
  let changes: DetailChange[] | null = null;
  if (review) {
    changes = [];
    for (const c of review.changes) {
      const page = c.page && isMarkdownPath(c.path);
      const after = page ? await text(c.after, c.afterSize) : { text: null, omitted: false };
      const original = page ? await text(c.original, null) : { text: null, omitted: false };
      changes.push({ path: c.path, change: c.change, page: c.page, ...(c.problem ? { problem: c.problem } : {}), original: original.text, after: after.text, ...(after.omitted || original.omitted ? { omitted: true } : {}) });
    }
  }
  return { events: events ?? [], changes };
}
