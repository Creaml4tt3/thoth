/**
 * The order people give pages and folders in the Private Space tree (ADR-0016 rule 4).
 *
 * It lives in `.thoth/order.json`, so files and folders keep their names (renaming them would break links and
 * other apps). Order is not content: a missing, unreadable or malformed record means A–Z, and is never an error.
 * The record is written through the vault's durable record path (atomic rename), like transfer records.
 */
import { z } from "zod";
import { basename, dirname } from "@thoth/domain";
import type { Vault } from "./vault.ts";

export const ORDER_PATH = ".thoth/order.json";

export const OrderRecordSchema = z.object({
  version: z.literal(1),
  /** Folder vault path ("" is the root) → child names (file names with extension, folder names) in order. */
  folders: z.record(z.string(), z.array(z.string())),
});
export type OrderRecord = z.infer<typeof OrderRecordSchema>;

export const emptyOrder = (): OrderRecord => ({ version: 1, folders: {} });

/** The order record, or an empty one when it is missing or broken (A–Z). Never throws. */
export async function readOrder(vault: Pick<Vault, "readRecord">): Promise<OrderRecord> {
  try {
    const parsed = OrderRecordSchema.safeParse(await vault.readRecord(ORDER_PATH));
    return parsed.success ? parsed.data : emptyOrder();
  } catch {
    return emptyOrder();
  }
}

export async function writeOrder(vault: Pick<Vault, "writeRecord">, record: OrderRecord): Promise<void> {
  await vault.writeRecord(ORDER_PATH, OrderRecordSchema.parse(record));
}

/** Children of `folder` in the recorded order: listed names first, then the rest by `fallback`. Stale names are ignored. */
export function orderChildren<T>(folder: string, children: readonly T[], name: (child: T) => string, fallback: (a: T, b: T) => number, record: OrderRecord): T[] {
  const listed = record.folders[folder] ?? [];
  const rank = new Map<string, number>();
  listed.forEach((n, i) => {
    if (!rank.has(n)) rank.set(n, i);
  });
  return [...children].sort((a, b) => {
    const ra = rank.get(name(a));
    const rb = rank.get(name(b));
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return fallback(a, b);
  });
}

/**
 * The record after files or folders moved (`from`/`to` are vault paths). A rename inside one folder keeps the
 * item's place; a move to another folder drops it from the old list and leaves the new folder's list alone (the
 * item sorts after the listed ones until it is placed). A moved folder takes its own and its subfolders' lists.
 */
export function renameInOrder(record: OrderRecord, moves: readonly { from: string; to: string }[]): OrderRecord {
  const folders: Record<string, string[]> = Object.fromEntries(Object.entries(record.folders).map(([k, v]) => [k, [...v]]));
  for (const { from, to } of moves) {
    const fromDir = dirname(from);
    const list = folders[fromDir];
    if (list) {
      if (dirname(to) === fromDir) folders[fromDir] = list.map((n) => (n === basename(from) ? basename(to) : n));
      else folders[fromDir] = list.filter((n) => n !== basename(from));
    }
    for (const key of Object.keys(folders)) {
      if (key === from || key.startsWith(`${from}/`)) {
        const moved = folders[key]!;
        delete folders[key];
        folders[to + key.slice(from.length)] = moved;
      }
    }
  }
  return { version: 1, folders };
}
