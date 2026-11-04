/**
 * Timeline (ADR-0051 rules 14–16), as plain data: pages by date, newest first, grouped by day, with a tag filter. The
 * rows come from what the index (`listPages`) or the workspace tree already holds; nothing here opens a page. Pure, so
 * dates, grouping and the filter are tested without a browser.
 */
import type { PageSummary } from "@thoth/domain";
import type { TreeNode } from "@thoth/workspace-protocol";
import { folderOf } from "../home/rows.ts";
import { dateFromDailyName, DEFAULT_DAILY } from "./daily-name.ts";

/** Edited: when the page was last changed. Dated: the date the page names (frontmatter `date`, a daily note's name). */
export type TimelineMode = "edited" | "dated";

export interface TimelineItem {
  /** Unique in the list. */
  id: string;
  title: string;
  /** The folder it is in; absent at the top level. */
  folder?: string;
  tags: readonly string[];
  /** Last edit, in ms since the epoch: the file's mtime, or the workspace page's `updatedAt`. */
  editedMs: number;
  /** The date the page names as `YYYY-MM-DD`, if any (Dated). */
  date?: string;
}

export interface TimelineRow<T extends TimelineItem = TimelineItem> {
  item: T;
  /** The local day it is listed under, `YYYY-MM-DD`. */
  day: string;
  /** The time is shown only when the row is placed by its edit (a named date has no time). */
  timed: boolean;
}

export interface TimelineDay<T extends TimelineItem = TimelineItem> {
  day: string;
  rows: TimelineRow<T>[];
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The local calendar day of a moment, `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The same tag, whatever its letter case (as Obsidian matches tags). */
const tagKey = (tag: string) => tag.toLocaleLowerCase();

/** True when the item has every tag of `wanted` (none wanted: every item). */
export function hasAllTags(item: Pick<TimelineItem, "tags">, wanted: readonly string[]): boolean {
  if (wanted.length === 0) return true;
  const own = new Set(item.tags.map(tagKey));
  return wanted.every((t) => own.has(tagKey(t)));
}

/** Every tag the items carry, once each (first spelling kept), A–Z. */
export function tagsOf(items: readonly Pick<TimelineItem, "tags">[]): string[] {
  const seen = new Map<string, string>();
  for (const item of items) for (const tag of item.tags) if (!seen.has(tagKey(tag))) seen.set(tagKey(tag), tag);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...seen.values()].sort(collator.compare);
}

/**
 * The items that have every wanted tag, grouped by local day, newest day first; in a day, the latest edit first. In
 * Dated mode an item with a `date` goes under that day, and one without under the day it was edited.
 */
export function groupTimeline<T extends TimelineItem>(items: readonly T[], mode: TimelineMode, wantedTags: readonly string[] = []): TimelineDay<T>[] {
  const rows: TimelineRow<T>[] = items
    .filter((item) => hasAllTags(item, wantedTags))
    .map((item) => (mode === "dated" && item.date ? { item, day: item.date, timed: false } : { item, day: localDay(item.editedMs), timed: true }));
  rows.sort((a, b) => (a.day === b.day ? b.item.editedMs - a.item.editedMs || a.item.title.localeCompare(b.item.title) : a.day < b.day ? 1 : -1));
  const days: TimelineDay<T>[] = [];
  for (const row of rows) {
    const last = days[days.length - 1];
    if (last?.day === row.day) last.rows.push(row);
    else days.push({ day: row.day, rows: [row] });
  }
  return days;
}

/** "Today", "Yesterday", or the date in the UI language (Thai in the Buddhist era, as ADR-0050's Today card). */
export function dayLabel(day: string, now: Date, lang: string, words: { today: string; yesterday: string }): string {
  const today = localDay(now.getTime());
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime());
  if (day === today) return words.today;
  if (day === yesterday) return words.yesterday;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  // Built from its parts: `new Date("2026-11-05")` is midnight UTC, which is the day before west of Greenwich.
  const date = new Date(y, m - 1, d);
  date.setFullYear(y); // years before 100 are not taken as 19xx
  return new Intl.DateTimeFormat(lang, { dateStyle: "full" }).format(date);
}

/** A row's time of day in the UI language. */
export const timeLabel = (ms: number, lang: string): string => new Intl.DateTimeFormat(lang, { timeStyle: "short" }).format(new Date(ms));

/**
 * Timeline items of a Private Space, from the index only (ADR-0051 rule 15). Dated: frontmatter `date` when valid
 * (`PageSummary.date`), else the date in a daily note's name, else the edit (`groupTimeline` falls back to it).
 */
export function privateTimelineItems(pages: readonly PageSummary[], daily: { folder: string; pattern: string } = DEFAULT_DAILY): TimelineItem[] {
  // `daily` is the Private Space's daily setting (`.thoth/daily.json`, ADR-0051 rule 15); the defaults are 0.6.0's.
  return pages.map((page) => {
    const folder = folderOf(page.path);
    const date = page.date ?? dateFromDailyName(page.path, daily.folder, daily.pattern);
    return { id: page.path, title: page.title, ...(folder ? { folder } : {}), tags: page.tags, editedMs: page.mtimeMs, ...(date ? { date } : {}) };
  });
}

/**
 * Timeline items of a workspace, from its tree (ADR-0051 rule 16), which already leaves out pages the reader may not
 * see. Folder pages are not listed. Tags and dates are there only when the server lists `page-tags`.
 */
export function workspaceTimelineItems(nodes: readonly TreeNode[], options: { isFolder(id: string): boolean; untitled: string }): TimelineItem[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.flatMap((node) => {
    if (options.isFolder(node.id)) return [];
    const editedMs = Date.parse(node.updatedAt);
    if (Number.isNaN(editedMs)) return [];
    const parent = node.parentId && node.parentId !== node.id ? byId.get(node.parentId) : undefined;
    return [{ id: node.id, title: node.title || options.untitled, ...(parent ? { folder: parent.title || options.untitled } : {}), tags: node.tags ?? [], editedMs, ...(node.date ? { date: node.date } : {}) }];
  });
}
