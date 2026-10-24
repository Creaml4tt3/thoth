/**
 * Remote mappings in `.thoth/sync/` (ADR-0001 §2, ADR-0003 §6).
 *
 * One record per workspace maps local logical IDs to remote IDs: the pages and
 * attachments a transfer carried, with the local path and hash at that time.
 * Transfers use it to classify references as already at the destination and to
 * put a moved page back where it came from. `external_locations` and
 * `sync_state` in the index are projections of these records.
 */
import { z } from "zod";
import { sha256Hex } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";
import { TransferDirectionSchema, TransferModeSchema } from "@thoth/workspace-protocol";

export const SYNC_DIR = ".thoth/sync";

export const SyncEntrySchema = z.object({
  kind: z.enum(["page", "attachment"]),
  /** The local logical ID (`thoth_id`); for attachments, the vault path. */
  localId: z.string(),
  /** The page ID or attachment ID in the workspace. */
  remoteId: z.string(),
  /** Vault path when the mapping was made (the source of a to_workspace move, the destination of a from_workspace one). */
  localPath: z.string(),
  /** sha256 of the local bytes at that time. */
  localHash: z.string().nullable(),
  remoteRevision: z.string().nullable(),
  /** sha256 of what the workspace holds (page revision content hash or attachment hash). */
  remoteHash: z.string().nullable(),
  direction: TransferDirectionSchema,
  mode: TransferModeSchema,
  operationId: z.string(),
  at: z.string(),
});
export type SyncEntry = z.infer<typeof SyncEntrySchema>;

export const SyncRecordSchema = z.object({
  recordVersion: z.literal(1),
  serverUrl: z.string(),
  workspaceId: z.string(),
  entries: z.array(SyncEntrySchema),
});
export type SyncRecord = z.infer<typeof SyncRecordSchema>;

/** The record file of one workspace: named by a hash, so no server address or ID becomes a file name. */
export function syncPath(serverUrl: string, workspaceId: string): string {
  return `${SYNC_DIR}/${sha256Hex(`${serverUrl}\n${workspaceId}`).slice(0, 32)}.json`;
}

/** The key the index projections use for one workspace. */
export const workspaceUrl = (serverUrl: string, workspaceId: string): string => `${serverUrl}/workspaces/${encodeURIComponent(workspaceId)}`;

export async function loadSync(vault: Vault, serverUrl: string, workspaceId: string): Promise<SyncRecord> {
  const raw = await vault.readRecord(syncPath(serverUrl, workspaceId)).catch(() => undefined);
  const parsed = SyncRecordSchema.safeParse(raw);
  if (parsed.success && parsed.data.serverUrl === serverUrl && parsed.data.workspaceId === workspaceId) return parsed.data;
  return { recordVersion: 1, serverUrl, workspaceId, entries: [] };
}

/** Upserts entries keyed by (kind, remoteId), writes the record, and refreshes the projection. Idempotent. */
export async function recordMappings(vault: Vault, serverUrl: string, workspaceId: string, entries: readonly SyncEntry[]): Promise<SyncRecord> {
  const record = await loadSync(vault, serverUrl, workspaceId);
  const key = (e: Pick<SyncEntry, "kind" | "remoteId">) => `${e.kind}\n${e.remoteId}`;
  const byKey = new Map(record.entries.map((e) => [key(e), e]));
  for (const entry of entries) byKey.set(key(entry), entry);
  const next: SyncRecord = { ...record, entries: [...byKey.values()] };
  await vault.writeRecord(syncPath(serverUrl, workspaceId), next);
  await projectSync(vault, next);
  return next;
}

export async function projectSync(vault: Vault, record: SyncRecord): Promise<void> {
  const rows = record.entries
    .filter((e) => e.kind === "page")
    .map((e) => ({ pageId: e.localId, remoteId: e.remoteId, remoteRevision: e.remoteRevision, baseHash: e.localHash }));
  await vault.projectSyncRecords(workspaceUrl(record.serverUrl, record.workspaceId), rows).catch(() => undefined);
}

/** Rebuilds the index projections from every sync record (after an index rebuild). */
export async function projectAllSync(vault: Vault): Promise<void> {
  for (const name of await vault.listRecords(SYNC_DIR)) {
    const parsed = SyncRecordSchema.safeParse(await vault.readRecord(`${SYNC_DIR}/${name}`).catch(() => undefined));
    if (parsed.success) await projectSync(vault, parsed.data);
  }
}
