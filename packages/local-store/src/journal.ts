import { z } from "zod";
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

/**
 * Journal files are untrusted input on recovery (a file could have been placed
 * in .thoth/ by another tool or an archive). Entries are only accepted when the
 * temp path is exactly the one derived from the entry's own UUIDv7 ID, so
 * recovery can never be steered into deleting anything else.
 */
export const JournalEntrySchema = z.object({
  id: z.string().regex(JOURNAL_ID),
  kind: z.enum(["write-file"]),
  path: z.string(),
  tempPath: z.string(),
  expectedHash: z.string().nullable(),
  newHash: z.string(),
  createdAt: z.number(),
}).refine((e) => e.tempPath === journalTempPath(e.id), { message: "tempPath must be the entry's own temp file" });
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
