// Timeline (ADR-0051 rules 14–16), as plain data: the page date, a daily note's name, grouping by day and the tag
// filter (all selected tags must match).
import { pageDateOf, parsePage } from "@thoth/content";
import type { TreeNode } from "@thoth/workspace-protocol";
import { describe, expect, it } from "vitest";
import { dateFromDailyName } from "../src/timeline/daily-name.ts";
import { dayLabel, groupTimeline, hasAllTags, localDay, privateTimelineItems, tagsOf, workspaceTimelineItems, type TimelineItem } from "../src/timeline/timeline.ts";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const item = (id: string, editedMs: number, extra: Partial<TimelineItem> = {}): TimelineItem => ({ id, title: id, tags: [], editedMs, ...extra });

describe("the frontmatter date (rule 15)", () => {
  it("accepts a calendar date, or a date-time whose day it keeps", () => {
    expect(pageDateOf("2026-11-05")).toBe("2026-11-05");
    expect(pageDateOf(" 2026-11-05T09:30:00Z ")).toBe("2026-11-05");
    expect(pageDateOf("2026-11-05 09:30")).toBe("2026-11-05");
    expect(pageDateOf("2024-02-29")).toBe("2024-02-29");
  });
  it("refuses days that do not exist and anything else", () => {
    for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "26-11-05", "5 Nov 2026", "", "2026-11-05x", 20261105, null, undefined, ["2026-11-05"]]) expect(pageDateOf(bad), String(bad)).toBeUndefined();
  });
  it("is parsed with the page, from frontmatter only", () => {
    expect(parsePage("A.md", "---\ndate: 2026-01-02\n---\n# A\n").date).toBe("2026-01-02");
    expect(parsePage("A.md", "date: 2026-01-02\n").date).toBeUndefined();
    expect(parsePage("A.md", "---\ndate: [broken\n---\n").date).toBeUndefined();
  });
});

describe("dateFromDailyName", () => {
  it("reads the default Daily/YYYY-MM-DD.md, in any letter case of the folder", () => {
    expect(dateFromDailyName("Daily/2026-11-05.md", "Daily", "YYYY-MM-DD")).toBe("2026-11-05");
    expect(dateFromDailyName("daily/2026-11-05.MD", "Daily", "YYYY-MM-DD")).toBe("2026-11-05");
  });
  it("needs the folder, the whole pattern and a real day", () => {
    expect(dateFromDailyName("2026-11-05.md", "Daily", "YYYY-MM-DD")).toBeUndefined();
    expect(dateFromDailyName("Daily/Sub/2026-11-05.md", "Daily", "YYYY-MM-DD")).toBeUndefined();
    expect(dateFromDailyName("Daily/2026-11-05 notes.md", "Daily", "YYYY-MM-DD")).toBeUndefined();
    expect(dateFromDailyName("Daily/2026-02-30.md", "Daily", "YYYY-MM-DD")).toBeUndefined();
    expect(dateFromDailyName("Dailyish/2026-11-05.md", "Daily", "YYYY-MM-DD")).toBeUndefined();
  });
  it("supports the tokens of rule 8, brackets, subfolders and the top level", () => {
    expect(dateFromDailyName("Journal/2026/11/2026-11-05.md", "Journal", "YYYY/MM/YYYY-MM-DD")).toBe("2026-11-05");
    expect(dateFromDailyName("Journal/Thursday, November 5th 2026.md", "Journal", "dddd, MMMM D[th] YYYY")).toBe("2026-11-05");
    expect(dateFromDailyName("Journal/05 Nov 26.md", "Journal", "DD MMM YY")).toBe("2026-11-05");
    expect(dateFromDailyName("2026-11-05.md", "", "YYYY-MM-DD")).toBe("2026-11-05");
    expect(dateFromDailyName("Log/[x] 2026.11.5.md", "Log", "[[x]] YYYY.M.D")).toBe("2026-11-05"); // `[[x]` is the text "[x", then "]"
    expect(dateFromDailyName("Log/2026.11.5.md", "Log", "[unclosed YYYY.M.D")).toBeUndefined();
  });
  it("names no date for a pattern with another token, or without a whole date", () => {
    expect(dateFromDailyName("Daily/2026-W45.md", "Daily", "GGGG-[W]WW")).toBeUndefined();
    expect(dateFromDailyName("Daily/2026-11.md", "Daily", "YYYY-MM")).toBeUndefined();
  });
});

describe("groupTimeline", () => {
  const items = [
    item("old", at(2026, 11, 1, 9), { tags: ["work"] }),
    item("late", at(2026, 11, 5, 18), { tags: ["work", "Plan"] }),
    item("early", at(2026, 11, 5, 8), { tags: ["home"] }),
    item("dated", at(2026, 11, 5, 10), { date: "2025-01-01", tags: ["work", "plan"] }),
  ];

  it("Edited: newest day first, the latest edit first within a day, with times", () => {
    const days = groupTimeline(items, "edited");
    expect(days.map((d) => [d.day, d.rows.map((r) => r.item.id)])).toEqual([
      ["2026-11-05", ["late", "dated", "early"]],
      ["2026-11-01", ["old"]],
    ]);
    expect(days[0]!.rows.every((r) => r.timed)).toBe(true);
  });

  it("Dated: a page with a date goes under that day, without a time; the others under their edit", () => {
    const days = groupTimeline(items, "dated");
    expect(days.map((d) => d.day)).toEqual(["2026-11-05", "2026-11-01", "2025-01-01"]);
    expect(days[2]!.rows).toEqual([{ item: items[3], day: "2025-01-01", timed: false }]);
  });

  it("filters to pages with every selected tag, ignoring letter case", () => {
    expect(groupTimeline(items, "edited", ["work", "plan"]).flatMap((d) => d.rows.map((r) => r.item.id))).toEqual(["late", "dated"]);
    expect(groupTimeline(items, "edited", ["work", "home"])).toEqual([]);
    expect(hasAllTags(items[0]!, [])).toBe(true);
  });

  it("lists every tag once, A–Z, first spelling kept", () => {
    expect(tagsOf(items)).toEqual(["home", "Plan", "work"]);
  });
});

describe("day labels", () => {
  const now = new Date(2026, 10, 5, 15);
  const words = { today: "Today", yesterday: "Yesterday" };
  it("says Today and Yesterday, then the date in the UI language", () => {
    expect(dayLabel("2026-11-05", now, "en", words)).toBe("Today");
    expect(dayLabel("2026-11-04", now, "en", words)).toBe("Yesterday");
    expect(dayLabel("2026-11-01", now, "en", words)).toBe("Sunday, November 1, 2026");
  });
  it("uses the Buddhist era in Thai", () => {
    expect(dayLabel("2026-11-01", now, "th", words)).toContain("2569");
  });
  it("crosses month and year boundaries for Yesterday", () => {
    expect(dayLabel("2025-12-31", new Date(2026, 0, 1, 0, 5), "en", words)).toBe("Yesterday");
  });
  it("localDay is the local calendar day", () => {
    expect(localDay(at(2026, 1, 2, 23, 59))).toBe("2026-01-02");
  });
});

describe("items from the index and the tree", () => {
  it("Private Space: frontmatter date first, then a daily note's name; the folder from the path", () => {
    const base = { contentHash: "", size: 1, aliases: [], tags: [] };
    const out = privateTimelineItems([
      { ...base, id: "a", path: "Daily/2026-11-04.md", title: "2026-11-04", mtimeMs: at(2026, 11, 5) },
      { ...base, id: "b", path: "Daily/2026-11-04.md", title: "x", mtimeMs: 1, date: "2020-01-01" },
      { ...base, id: "c", path: "Top.md", title: "Top", mtimeMs: 2, tags: ["t"] },
    ]);
    expect(out).toEqual([
      { id: "Daily/2026-11-04.md", title: "2026-11-04", folder: "Daily", tags: [], editedMs: at(2026, 11, 5), date: "2026-11-04" },
      { id: "Daily/2026-11-04.md", title: "x", folder: "Daily", tags: [], editedMs: 1, date: "2020-01-01" },
      { id: "Top.md", title: "Top", tags: ["t"], editedMs: 2 },
    ]);
  });

  it("Private Space: a daily note is dated by the space's own daily setting, not only the default", () => {
    const journal = { id: "j", path: "Journal/2026/11/05.md", title: "05", contentHash: "", size: 0, mtimeMs: 1, aliases: [], tags: [] };
    expect(privateTimelineItems([journal])[0]!.date).toBeUndefined();
    expect(privateTimelineItems([journal], { folder: "Journal", pattern: "YYYY/MM/DD" })[0]!.date).toBe("2026-11-05");
  });

  it("workspace: leaves folders out, names the parent, and reads tags and dates when present", () => {
    const node = (id: string, extra: Partial<TreeNode> = {}): TreeNode => ({ id, parentId: null, title: id, revisionId: "rev_1", updatedAt: "2026-11-05T10:00:00Z", ...extra });
    const nodes = [node("f"), node("p", { parentId: "f", tags: ["x"], date: "2026-01-01" }), node("q", { tags: null }), node("bad", { updatedAt: "nope" })];
    expect(workspaceTimelineItems(nodes, { isFolder: (id) => id === "f", untitled: "Untitled" })).toEqual([
      { id: "p", title: "p", folder: "f", tags: ["x"], editedMs: Date.parse("2026-11-05T10:00:00Z"), date: "2026-01-01" },
      { id: "q", title: "q", tags: [], editedMs: Date.parse("2026-11-05T10:00:00Z") },
    ]);
  });
});
