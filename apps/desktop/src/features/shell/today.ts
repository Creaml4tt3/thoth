/**
 * Today (ADR-0050 rules 11–15): today's page in the Private Space, `Daily/YYYY-MM-DD.md`, made on first use from
 * `Templates/Daily.md` when it exists. An existing page (in any letter case or Unicode form) is opened, never changed.
 */
import { LinkResolver, updateFrontmatter } from "@thoth/content";
import { collisionKey, newStableId } from "@thoth/domain";
import { ConflictError, type Vault } from "@thoth/local-store";
import { applyRewrites } from "@thoth/transfer";
import { relinked } from "./duplicate.ts";
import { retitle } from "./rename.ts";

export const DAILY_FOLDER = "Daily";
export const DAILY_TEMPLATE = "Templates/Daily.md";

/** The local calendar date as `YYYY-MM-DD` (the computer's time zone), so files sort by date. */
export function isoDate(now: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Milliseconds until the next local midnight: when the card's date changes. */
export function msUntilMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

export const todayPath = (now: Date) => `${DAILY_FOLDER}/${isoDate(now)}.md`;

/** The existing file for `path`, matched as the vault matches names (case, Unicode form), or undefined. */
export async function findExisting(vault: Vault, path: string): Promise<string | undefined> {
  const key = collisionKey(path);
  return (await vault.scanFiles()).files.find((f) => collisionKey(f) === key);
}

/** Today's page text: the template's, its links reaching the same pages from `Daily/`, titled by the date; else `# date`. */
async function todayText(vault: Vault, path: string, date: string): Promise<string> {
  const template = await vault.readPage(DAILY_TEMPLATE).catch(() => null);
  if (!template?.editable) return updateFrontmatter(`# ${date}\n`, { thoth_id: newStableId() });
  const [scan, pages, folders] = await Promise.all([vault.scanFiles(), vault.listPages(), vault.listFolders()]);
  const resolvable = pages.map((p) => ({ path: p.path, aliases: p.aliases }));
  const before = new LinkResolver(scan.files, resolvable, folders);
  const after = new LinkResolver([...scan.files, path], [...resolvable, { path, aliases: [] }], folders);
  let text = applyRewrites(template.source, relinked(DAILY_TEMPLATE, path, template.source, before, after, (p) => p), { labelBareWikilinks: true });
  text = retitle(path, text, "Daily", date);
  return updateFrontmatter(text, { thoth_id: newStableId() });
}

/** Today's page, made when missing. Returns its path and whether this call made it. */
export async function openOrStartToday(vault: Vault, now: Date): Promise<{ path: string; created: boolean }> {
  const existing = await findExisting(vault, todayPath(now));
  if (existing) return { path: existing, created: false };
  // A `daily` folder that differs only in case is the Daily folder: no second one beside it.
  const folder = (await vault.listFolders()).find((f) => collisionKey(f) === collisionKey(DAILY_FOLDER)) ?? DAILY_FOLDER;
  const path = `${folder}/${isoDate(now)}.md`;
  const text = await todayText(vault, path, isoDate(now));
  try {
    await vault.writePage(path, text, { expectedHash: null });
    return { path, created: true };
  } catch (error) {
    // Another window made it a moment ago: open that one.
    if (!(error instanceof ConflictError)) throw error;
    return { path: (await findExisting(vault, path)) ?? path, created: false };
  }
}
