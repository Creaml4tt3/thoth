/**
 * The Private Space's starred pages (ADR-0027): `.thoth/favorites.json`, next to the tree order, so they travel with
 * the folder. Pages are named by their stable id (ADR-0003), never by path, so a favorite follows a rename or a move
 * made in the app. Like the order, favorites are not content: a missing, unreadable or malformed record is "no
 * favorites", never an error.
 *
 * Only stable ids are kept: starring a page adopts it first (`favoritePage`), which writes its `thoth_id` into its
 * frontmatter, the same step a transfer takes. A path-derived (provisional) id would not survive a move.
 *
 * Two windows on the same folder may change favorites at once (ADR-0019). Every write is a compare-and-swap on the bytes
 * that were read (`Vault.writeRecordIfUnchanged`); when another window wrote in between, the change is worked out again
 * on what it wrote, a few times, so neither window's star is lost.
 */
import { z } from "zod";
import { isStableId } from "@thoth/domain";
import { ConflictError } from "./errors.ts";
import type { Vault } from "./vault.ts";

export const FAVORITES_PATH = ".thoth/favorites.json";
/** More favorites than this are not a list a person keeps; the rest is dropped. */
export const MAX_FAVORITES = 200;
const ATTEMPTS = 4;

export const FavoritesRecordSchema = z.object({
  version: z.literal(1),
  /** Stable page ids, in the order the person gave them. */
  pages: z.array(z.string().min(1).max(256)).max(MAX_FAVORITES),
});
export type FavoritesRecord = z.infer<typeof FavoritesRecordSchema>;

/** The favorites as read, and the hash of the bytes they came from (null: no file), for the next write. */
export interface FavoritesRead {
  pages: string[];
  hash: string | null;
}

/** Ids once each, in order. */
const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/** The favorites, or none when the record is missing or broken. Never throws. */
export async function readFavorites(vault: Pick<Vault, "readRecordText">): Promise<FavoritesRead> {
  try {
    const record = await vault.readRecordText(FAVORITES_PATH);
    if (!record) return { pages: [], hash: null };
    let value: unknown;
    try {
      value = JSON.parse(record.text);
    } catch {
      return { pages: [], hash: record.hash };
    }
    const parsed = FavoritesRecordSchema.safeParse(value);
    return { pages: parsed.success ? unique(parsed.data.pages).filter(isStableId) : [], hash: record.hash };
  } catch {
    return { pages: [], hash: null };
  }
}

export interface UpdateOptions {
  /** The ids that are pages now: any other is dropped as the record is written (a page deleted or moved out). */
  keep?: ReadonlySet<string>;
}

/**
 * Changes the favorites: `change` gets the list as it is on disk and returns the new one, which is written only if the
 * file has not changed since it was read. If it has (another window), `change` runs again on the new list. Returns the
 * list written; throws `ConflictError` when the file kept changing under it.
 */
export async function updateFavorites(
  vault: Pick<Vault, "readRecordText" | "writeRecordIfUnchanged">,
  change: (pages: readonly string[]) => readonly string[] | Promise<readonly string[]>,
  options: UpdateOptions = {},
): Promise<string[]> {
  let last: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const now = await readFavorites(vault);
    const next = unique(await change(now.pages))
      .filter((id) => !options.keep || options.keep.has(id))
      .slice(0, MAX_FAVORITES);
    if (now.hash !== null && JSON.stringify(next) === JSON.stringify(now.pages)) return next; // nothing to write
    if (now.hash === null && next.length === 0) return next; // no file appears for nothing
    const record: FavoritesRecord = { version: 1, pages: next };
    try {
      await vault.writeRecordIfUnchanged(FAVORITES_PATH, FavoritesRecordSchema.parse(record), now.hash);
      return next;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error("Favorites changed while they were written");
}

/**
 * Stars the page at `path`: gives it a stable id (`Vault.adoptPage`, a frontmatter write when it has none yet) and adds
 * that id at the end of the favorites. Returns the id. Unsaved edits to the page must be written first.
 */
export async function favoritePage(vault: Pick<Vault, "adoptPage" | "readRecordText" | "writeRecordIfUnchanged">, path: string): Promise<string> {
  const id = await vault.adoptPage(path);
  await updateFavorites(vault, (pages) => (pages.includes(id) ? pages : [...pages, id]));
  return id;
}
