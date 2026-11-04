/**
 * Today (ADR-0050 rules 11–15, ADR-0051 rules 7–10): today's page in the Private Space, `<folder>/<pattern>.md` from
 * the daily notes setting (`.thoth/daily.json`; 0.6.0's `Daily/YYYY-MM-DD.md` by default), made on first use from the
 * setting's template when it exists. An existing page (in any letter case or Unicode form) is opened, never changed.
 */
import { fillPlaceholders, LinkResolver, updateFrontmatter } from "@thoth/content";
import { basename, collisionKey, newStableId, stripExtension } from "@thoth/domain";
import { ConflictError, dailyPath, readDailySettings, type DailySettings, type Vault } from "@thoth/local-store";
import { applyRewrites } from "@thoth/transfer";
import { relinked } from "./duplicate.ts";
import { retitle } from "./rename.ts";

/** Milliseconds until the next local midnight: when the card's date changes. */
export function msUntilMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** The existing file for `path`, matched as the vault matches names (case, Unicode form), or undefined. */
export async function findExisting(vault: Vault, path: string): Promise<string | undefined> {
  const key = collisionKey(path);
  return (await vault.scanFiles()).files.find((f) => collisionKey(f) === key);
}

/** Today's page text: the template's, placeholders filled, its links reaching the same pages from `path`, titled by the date; else `# date`. */
async function todayText(vault: Vault, settings: DailySettings, path: string, now: Date): Promise<string> {
  const title = stripExtension(basename(path));
  const template = settings.template ? await vault.readPage(settings.template).catch(() => null) : null;
  if (!settings.template || !template?.editable) return updateFrontmatter(`# ${title}\n`, { thoth_id: newStableId() });
  const [scan, pages, folders] = await Promise.all([vault.scanFiles(), vault.listPages(), vault.listFolders()]);
  const resolvable = pages.map((p) => ({ path: p.path, aliases: p.aliases }));
  const before = new LinkResolver(scan.files, resolvable, folders);
  const after = new LinkResolver([...scan.files, path], [...resolvable, { path, aliases: [] }], folders);
  let text = applyRewrites(template.source, relinked(settings.template, path, template.source, before, after, (p) => p), { labelBareWikilinks: true });
  text = fillPlaceholders(text, { now, title });
  text = retitle(path, text, stripExtension(basename(settings.template)), title);
  return updateFrontmatter(text, { thoth_id: newStableId() });
}

/** Today's page, made when missing. Returns its path and whether this call made it. */
export async function openOrStartToday(vault: Vault, now: Date): Promise<{ path: string; created: boolean }> {
  const { settings } = await readDailySettings(vault);
  const wanted = dailyPath(settings, now);
  const existing = await findExisting(vault, wanted);
  if (existing) return { path: existing, created: false };
  // A folder that differs only in case (`daily` for `Daily`) is that folder: no second one beside it.
  const folders = new Map((await vault.listFolders()).map((f) => [collisionKey(f), f]));
  const segments = wanted.split("/");
  const path = segments.map((s, i) => (i < segments.length - 1 ? (folders.get(collisionKey(segments.slice(0, i + 1).join("/")))?.split("/")[i] ?? s) : s)).join("/");
  const text = await todayText(vault, settings, path, now);
  try {
    await vault.writePage(path, text, { expectedHash: null });
    return { path, created: true };
  } catch (error) {
    // Another window made it a moment ago: open that one.
    if (!(error instanceof ConflictError)) throw error;
    return { path: (await findExisting(vault, path)) ?? path, created: false };
  }
}
