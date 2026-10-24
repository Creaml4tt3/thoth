import { z } from "zod";
import { dirname, isReservedPath, normalizeVaultPath } from "@thoth/domain";
import type { VaultFs } from "./ports.ts";

/**
 * Write-ahead journal for filesystem + index updates (ADR-001 §7).
 *
 * The file tree is the truth. A journal entry exists so that after a crash we
 * know which temp files to discard and which paths to reconcile; it never
 * stores page content.
 */
export const JOURNAL_DIR = ".thoth/operations/journal";
export const TEMP_DIR = ".thoth/tmp";

const JOURNAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The only temp path a journal entry may name: Thoth's own `<id>.tmp`. */
export function journalTempPath(id: string): string {
  return `${TEMP_DIR}/${id}.tmp`;
}

function isContentPath(path: string): boolean {
  try {
    return normalizeVaultPath(path) === path && !isReservedPath(path);
  } catch {
    return false;
  }
}

/**
 * Journal files are untrusted input on recovery (a file could have been placed
 * in .thoth/ by another tool or an archive). Entries are only accepted when the
 * temp path is exactly the one derived from the entry's own UUIDv7 ID, so
 * recovery can never be steered into deleting anything else.
 *
 * - `write-file`: the temp file holds new bytes not yet renamed into place; recovery discards it.
 * - `delete-file`: the file was moved to its temp path to be deleted after a hash check; recovery
 *   puts it back (it never deletes a file it cannot prove was checked). `path` must be vault content.
 */
export const JournalEntrySchema = z
  .object({
    id: z.string().regex(JOURNAL_ID),
    kind: z.enum(["write-file", "delete-file"]),
    path: z.string(),
    tempPath: z.string(),
    expectedHash: z.string().nullable(),
    /** Hash of the bytes being written; null for `delete-file`. */
    newHash: z.string().nullable(),
    createdAt: z.number(),
  })
  .refine((e) => e.tempPath === journalTempPath(e.id), { message: "tempPath must be the entry's own temp file" })
  .refine((e) => e.kind !== "delete-file" || isContentPath(e.path), { message: "a delete-file entry must name a vault content path" });
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function writeJournalEntry(fs: VaultFs, entry: JournalEntry): Promise<void> {
  await fs.writeFile(`${JOURNAL_DIR}/${entry.id}.json`, encoder.encode(JSON.stringify(entry)));
}

export async function clearJournalEntry(fs: VaultFs, id: string): Promise<void> {
  await fs.remove(`${JOURNAL_DIR}/${id}.json`);
}

export interface PendingJournal {
  entries: JournalEntry[];
  /** Journal files that failed validation; left in place for manual inspection. */
  invalid: string[];
}

export async function readPendingJournal(fs: VaultFs): Promise<PendingJournal> {
  const entries: JournalEntry[] = [];
  const invalid: string[] = [];
  if (!(await fs.stat(JOURNAL_DIR))) return { entries, invalid };
  for (const item of await fs.list(JOURNAL_DIR)) {
    if (item.kind !== "file" || !item.name.endsWith(".json")) continue;
    const path = `${JOURNAL_DIR}/${item.name}`;
    try {
      const entry = JournalEntrySchema.parse(JSON.parse(decoder.decode(await fs.readFile(path))));
      if (item.name !== `${entry.id}.json`) throw new Error("journal file name does not match its ID");
      entries.push(entry);
    } catch {
      invalid.push(path);
    }
  }
  entries.sort((a, b) => a.createdAt - b.createdAt);
  return { entries, invalid };
}

/**
 * A durable Thoth record path (ADR-0001 §2): `.thoth/<area>/.../<name>.json`, outside the index files and
 * outside the temp, journal and import staging areas, or the one top-level record `.thoth/order.json` (the tree
 * order, ADR-0016 rule 4). Throws for anything else.
 */
export function recordPath(path: string): string {
  const normalized = normalizeVaultPath(path);
  if (normalized.toLowerCase() === ".thoth/order.json") return normalized;
  const [first, ...rest] = normalized.split("/");
  const area = rest.join("/").toLowerCase();
  const ok =
    first !== undefined &&
    first.toLowerCase() === ".thoth" &&
    rest.length >= 2 &&
    normalized.toLowerCase().endsWith(".json") &&
    !area.startsWith("index.sqlite") &&
    !area.startsWith("tmp/") &&
    !area.startsWith("operations/journal/") &&
    !area.startsWith("operations/imports/");
  if (!ok) throw new Error(`Not a Thoth record path: ${path}`);
  return normalized;
}

/**
 * Writes a durable metadata record (transfer operations, `.thoth/sync/` mappings): records cannot be derived
 * from Markdown, so a reader must see the old record or the new one, never a torn one. The bytes go to
 * Thoth's own `.thoth/tmp/<id>.tmp` (fsynced) and are renamed over the target; a crash leaves at most
 * that temp file, which `Vault.open` sweeps. `id` is a fresh UUIDv7 per write.
 */
export async function writeRecordAtomic(fs: VaultFs, path: string, data: Uint8Array, id: string): Promise<void> {
  const target = recordPath(path);
  if (!JOURNAL_ID.test(id)) throw new Error("A record write needs a UUIDv7 temp id");
  const temp = journalTempPath(id);
  await fs.mkdirp(TEMP_DIR);
  await fs.writeFile(temp, data, { exclusive: true });
  try {
    await fs.mkdirp(dirname(target));
    await fs.rename(temp, target);
  } catch (error) {
    await fs.remove(temp).catch(() => undefined);
    throw error;
  }
}
