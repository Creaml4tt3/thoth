/**
 * Durable transfer operation records (ADR-0006 §3).
 *
 * `.thoth/operations/<id>.json` is the authoritative local journal of one
 * transfer: what was planned, which state each item reached, hashes and
 * revisions on both sides, the ID mapping and errors. It never contains page
 * content, attachment bytes or credentials, so it may be inspected or shared
 * when something goes wrong. `operation_journal` in the index is a projection.
 */
import { z } from "zod";
import { StableIdSchema, TransferStateSchema, type TransferState } from "@thoth/domain";
import { TransferModeSchema } from "@thoth/workspace-protocol";

export const OPERATIONS_DIR = ".thoth/operations";
export const RECORD_VERSION = 1;

export const operationPath = (id: string): string => `${OPERATIONS_DIR}/${id}.json`;

/**
 * Where records are kept: the vault's `.thoth/` on the desktop; the browser's storage in the web client, which has no
 * Private Space (`storageRecords`).
 */
export interface RecordStore {
  writeRecord(path: string, value: unknown): Promise<void>;
  readRecord(path: string): Promise<unknown>;
  listRecords(dir: string): Promise<string[]>;
  removeRecord(path: string): Promise<void>;
  /** The vault's index projection; absent where there is no index. */
  projectOperation?(row: { id: string; kind: string; state: string; updatedAt: number }): Promise<void>;
}

/**
 * A `RecordStore` over a `Storage` (the web client's localStorage): one key per record under `prefix`, and one key
 * listing them (so only `getItem` and `setItem` are needed).
 */
export function storageRecords(storage: Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>, prefix = "thoth.transfers/"): RecordStore {
  const indexKey = `${prefix}index`;
  const index = (): string[] => {
    try {
      const value: unknown = JSON.parse(storage.getItem(indexKey) ?? "[]");
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    async writeRecord(path, value) {
      storage.setItem(prefix + path, JSON.stringify(value));
      const paths = index();
      if (!paths.includes(path)) storage.setItem(indexKey, JSON.stringify([...paths, path]));
    },
    async readRecord(path) {
      const text = storage.getItem(prefix + path);
      return text === null || text === "" ? undefined : (JSON.parse(text) as unknown);
    },
    async listRecords(dir) {
      return index()
        .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/") && path.endsWith(".json"))
        .map((path) => path.slice(dir.length + 1))
        .sort();
    },
    async removeRecord(path) {
      if (storage.removeItem) storage.removeItem(prefix + path);
      else storage.setItem(prefix + path, "");
      storage.setItem(indexKey, JSON.stringify(index().filter((p) => p !== path)));
    },
  };
}

/**
 * The record's direction. The first two are the protocol's (the workspace is the destination or the source);
 * `between_workspaces` is two protocol transfers, one at each workspace (ADR-0006, amendment of 2026-10-27).
 */
export const RecordDirectionSchema = z.enum(["to_workspace", "from_workspace", "between_workspaces"]);
export type RecordDirection = z.infer<typeof RecordDirectionSchema>;

/** Per-item progress. `staged` and `committed` mirror the server; `cleanup_pending` is a move whose source survived on purpose. */
export const ItemStateSchema = z.enum(["planned", "uploaded", "staged", "written", "verified", "committed", "source_deleted", "cleanup_pending", "skipped", "failed"]);
export type ItemState = z.infer<typeof ItemStateSchema>;

export const ReferenceClassSchema = z.enum(["included", "already_at_destination", "left_at_source", "external", "unresolved"]);
export type ReferenceClass = z.infer<typeof ReferenceClassSchema>;

export const PageItemSchema = z.object({
  kind: z.literal("page"),
  /** to_workspace: vault path of the source page. from_workspace: the page's title on the server (display only). */
  sourcePath: z.string(),
  /** Logical ID on the source side (the page's `thoth_id`, or the workspace page ID). */
  sourceId: z.string(),
  /** sha256 of the source bytes the plan was built from (to_workspace) or the pinned revision's content hash (from_workspace). */
  sourceHash: z.string().nullable(),
  /** from_workspace: the revision the server pinned. */
  sourceRevision: z.string().nullable(),
  /** Logical ID at the destination: fresh for copy, preserved for move (ADR-0006 §4). */
  destId: z.string(),
  /** to_workspace: the destination parent page. from_workspace: the vault path the page is written to. */
  destParentId: z.string().nullable(),
  destPath: z.string().nullable(),
  /** sha256 of the exact bytes sent to (or written at) the destination. */
  destHash: z.string().nullable(),
  /** to_workspace: the revision the commit created. */
  destRevision: z.string().nullable(),
  title: z.string(),
  state: ItemStateSchema,
  /**
   * A folder (ADR-0016 rule 3). to_workspace: a vault folder sent as a folder page (`sourcePath` is the folder,
   * `sourceId` is `folder:<path>`); it is never deleted. from_workspace: a folder page that becomes the vault
   * folder `destPath`, with no file of its own.
   */
  folder: z.boolean().optional(),
  /** The destination file exists but held other bytes, so the page went to a conflict copy (ADR-0005). */
  conflictCopy: z.boolean().optional(),
  error: z.string().optional(),
});
export type PageItem = z.infer<typeof PageItemSchema>;

export const AttachmentItemSchema = z.object({
  kind: z.literal("attachment"),
  /** Vault path of the attachment (to_workspace only). */
  sourcePath: z.string(),
  sourceHash: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  /** Key the upload is sent with, so a retry replays rather than duplicates it. */
  uploadKey: z.string(),
  /** Server-assigned attachment ID once uploaded. */
  destId: z.string().nullable(),
  /** Hash the server echoed for the upload. */
  destHash: z.string().nullable(),
  state: ItemStateSchema,
  error: z.string().optional(),
});
export type AttachmentItem = z.infer<typeof AttachmentItemSchema>;

export const LinkSummarySchema = z.object({
  /** Counts per class (§9.3), over every reference in the selected pages. */
  counts: z.record(ReferenceClassSchema, z.number().int().nonnegative()),
  /** Links rewritten through the ID mapping. */
  rewritten: z.number().int().nonnegative(),
  /** Unresolved or ambiguous links: kept as written and flagged. Targets only, no surrounding text. */
  flagged: z.array(z.object({ sourcePath: z.string(), target: z.string(), line: z.number().int().positive(), class: ReferenceClassSchema })),
});
export type LinkSummary = z.infer<typeof LinkSummarySchema>;

export const OperationRecordSchema = z.object({
  recordVersion: z.literal(RECORD_VERSION),
  id: StableIdSchema,
  kind: z.literal("transfer"),
  direction: RecordDirectionSchema,
  mode: TransferModeSchema,
  /** The host's server handle and the server origin (no credential). between_workspaces: the destination. */
  server: z.object({ id: z.string(), url: z.string() }),
  workspace: z.object({ id: z.string(), name: z.string() }),
  /**
   * between_workspaces only: the source workspace, the ID of the from_workspace transfer there (the record's own `id`
   * is the to_workspace transfer at the destination), and whether that server has it.
   */
  source: z.object({ server: z.object({ id: z.string(), url: z.string() }), workspace: z.object({ id: z.string(), name: z.string() }), operationId: StableIdSchema, known: z.boolean() }).optional(),
  state: TransferStateSchema,
  /** Last state reached before `failed`, so recovery knows what is safe. */
  failedAt: TransferStateSchema.nullable(),
  /** to_workspace: the destination parent. from_workspace: the destination vault folder. */
  destination: z.object({ parentId: z.string().nullable(), folder: z.string() }),
  items: z.array(PageItemSchema),
  attachments: z.array(AttachmentItemSchema),
  links: LinkSummarySchema,
  /** True once the server has the transfer (create returned), so recovery must reconcile with it. */
  serverKnown: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

export const TERMINAL_STATES: readonly TransferState[] = ["done", "destination_committed_source_cleanup_pending", "failed", "aborted"];
export const isTerminal = (state: TransferState): boolean => TERMINAL_STATES.includes(state);

export async function saveRecord(vault: RecordStore, record: OperationRecord, now: Date): Promise<OperationRecord> {
  const next = { ...record, updatedAt: now.toISOString() };
  OperationRecordSchema.parse(next);
  await vault.writeRecord(operationPath(next.id), next);
  // The projection may lag a crash; `TransferEngine.open` rebuilds it from the records.
  await vault.projectOperation?.({ id: next.id, kind: "transfer", state: next.state, updatedAt: now.getTime() }).catch(() => undefined);
  return next;
}

export async function loadRecord(vault: RecordStore, id: string): Promise<OperationRecord | undefined> {
  const raw = await vault.readRecord(operationPath(id));
  if (raw === undefined) return undefined;
  return OperationRecordSchema.parse(raw);
}

export interface ListedRecords {
  records: OperationRecord[];
  /** Files in `.thoth/operations/` that are not valid records; left in place. */
  invalid: string[];
}

export async function listRecords(vault: RecordStore): Promise<ListedRecords> {
  const records: OperationRecord[] = [];
  const invalid: string[] = [];
  for (const name of await vault.listRecords(OPERATIONS_DIR)) {
    try {
      const record = OperationRecordSchema.parse(await vault.readRecord(`${OPERATIONS_DIR}/${name}`));
      if (name !== `${record.id}.json`) throw new Error("name does not match id");
      records.push(record);
    } catch {
      invalid.push(`${OPERATIONS_DIR}/${name}`);
    }
  }
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { records, invalid };
}
