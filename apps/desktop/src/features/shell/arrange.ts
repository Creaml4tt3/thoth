/**
 * Putting things in order in the Private Space tree (ADR-0016 rule 4). The order is a record, `.thoth/order.json`,
 * so reordering never renames a file. Moving into another folder is a real file move inside the vault, which
 * follows links (`Vault.move`); the record then drops the item from its old folder and lists it in the new one.
 */
import { basename } from "@thoth/domain";
import { readOrder, renameInOrder, writeOrder, type MoveReport, type OrderRecord, type Vault } from "@thoth/local-store";

/** `siblings` (a folder's display order without `name`) with `name` inserted at `index`, which is clamped. */
export function placeName(siblings: readonly string[], name: string, index: number): string[] {
  const list = siblings.filter((n) => n !== name);
  list.splice(Math.max(0, Math.min(index, list.length)), 0, name);
  return list;
}

const join = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);

/** Sets a folder's recorded order to its display order with `name` at `index`. Returns the record written. */
export async function reorderInFolder(vault: Pick<Vault, "readRecord" | "writeRecord">, folder: string, name: string, siblings: readonly string[], index: number): Promise<OrderRecord> {
  const record = await readOrder(vault);
  const next: OrderRecord = { version: 1, folders: { ...record.folders, [folder]: placeName(siblings, name, index) } };
  await writeOrder(vault, next);
  return next;
}

export interface MovedInto {
  /** Where the item is now. */
  to: string;
  report: MoveReport;
  order: OrderRecord;
}

/**
 * Moves a page or a folder into `folder` and places it at `index` among `siblings` (that folder's display order,
 * without the moved item). Throws what `Vault.move` throws, for example a `ConflictError` when the folder already
 * has something of that name; then nothing has changed.
 */
export async function moveIntoFolder(vault: Vault, from: string, folder: string, siblings: readonly string[], index: number): Promise<MovedInto> {
  const name = basename(from);
  const to = join(folder, name);
  const report = await vault.move(from, to);
  const moved = renameInOrder(await readOrder(vault), report.moved);
  const order: OrderRecord = { version: 1, folders: { ...moved.folders, [folder]: placeName(siblings, name, index) } };
  await writeOrder(vault, order);
  return { to, report, order };
}
