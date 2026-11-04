// Today (ADR-0050 rules 11–15, ADR-0051 rules 7–10), on a real vault without a window: the date and its file name, the
// template with its links rewritten and its placeholders filled, an existing page opened and never changed, a name that
// differs only in case, and the daily notes setting followed.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeVault } from "@thoth/local-store/node";
import { DEFAULT_DAILY, dailyPath, updateDailySettings, type Vault } from "@thoth/local-store";
import { msUntilMidnight, openOrStartToday } from "../src/features/shell/today.ts";

let root: string;
let vault: Vault | undefined;
const put = async (path: string, text: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
};
const read = (path: string) => readFile(join(root, path), "utf8");
const NOV_4 = new Date(2026, 10, 4, 9, 30);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-today-"));
  await put("Projects/Atlas.md", "# Atlas\n");
});
afterEach(async () => {
  await vault?.close();
  vault = undefined;
  await rm(root, { recursive: true, force: true });
});
const open = async () => (vault = (await openNodeVault(root)).vault);

describe("dates", () => {
  it("uses the local calendar date, zero-padded, so files sort", () => {
    expect(dailyPath(DEFAULT_DAILY, NOV_4)).toBe("Daily/2026-11-04.md");
    expect(dailyPath(DEFAULT_DAILY, new Date(2027, 0, 1, 0, 0, 1))).toBe("Daily/2027-01-01.md");
    expect(dailyPath(DEFAULT_DAILY, new Date(2026, 10, 4, 23, 59, 59))).toBe("Daily/2026-11-04.md");
    expect(dailyPath(DEFAULT_DAILY, new Date(987, 2, 9))).toBe("Daily/0987-03-09.md");
  });

  it("knows how long until local midnight", () => {
    expect(msUntilMidnight(new Date(2026, 10, 4, 23, 59, 0))).toBe(60_000);
    expect(msUntilMidnight(new Date(2026, 10, 4, 0, 0, 0))).toBe(24 * 3_600_000);
  });
});

describe("openOrStartToday", () => {
  it("without a template makes Daily/<date>.md with the date as its title", async () => {
    await open();
    expect(await openOrStartToday(vault!, NOV_4)).toEqual({ path: "Daily/2026-11-04.md", created: true });
    expect(await read("Daily/2026-11-04.md")).toMatch(/^---\nthoth_id: \S+\n---\n# 2026-11-04\n$/);
  });

  it("copies Templates/Daily.md, titled by the date, its links still reaching the same pages", async () => {
    await put("Templates/Daily.md", "---\nthoth_id: 01HZZZZZZZZZZZZZZZZZZZZZZZ\ntags: [daily]\n---\n# Daily\n\n## Plan\n\n- [ ] \n\nSee [atlas](../Projects/Atlas.md) and [[Atlas]].\n");
    await open();
    await openOrStartToday(vault!, NOV_4);
    const text = await read("Daily/2026-11-04.md");
    expect(text).toContain("# 2026-11-04\n\n## Plan\n\n- [ ] \n");
    expect(text).toContain("tags: [daily]");
    expect(text).not.toContain("01HZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(text).toContain("[atlas](../Projects/Atlas.md)");
    expect(text).toContain("[[Atlas]]");
    // The template itself is untouched.
    expect(await read("Templates/Daily.md")).toContain("# Daily\n");
  });

  it("opens today's page when it exists, in any letter case, and never changes it", async () => {
    await put("daily/2026-11-04.md", "# Mine\n\nAlready written.\n");
    await open();
    expect(await openOrStartToday(vault!, NOV_4)).toEqual({ path: "daily/2026-11-04.md", created: false });
    expect(await read("daily/2026-11-04.md")).toBe("# Mine\n\nAlready written.\n");
  });

  it("puts a new page in a Daily folder that differs only in case", async () => {
    await put("daily/2026-11-03.md", "# Yesterday\n");
    await open();
    expect(await openOrStartToday(vault!, NOV_4)).toEqual({ path: "daily/2026-11-04.md", created: true });
  });

  it("a second call the same day opens the page the first one made", async () => {
    await open();
    await openOrStartToday(vault!, NOV_4);
    const first = await read("Daily/2026-11-04.md");
    expect(await openOrStartToday(vault!, new Date(2026, 10, 4, 23, 59))).toEqual({ path: "Daily/2026-11-04.md", created: false });
    expect(await read("Daily/2026-11-04.md")).toBe(first);
  });

  it("fills the template's placeholders, but not in code", async () => {
    await put("Templates/Daily.md", "# {{date:dddd D MMMM YYYY}}\n\nMade at {{time}} for {{title}}. {{weather}}\n\n`{{date}}`\n");
    await open();
    await openOrStartToday(vault!, NOV_4);
    expect(await read("Daily/2026-11-04.md")).toMatch(/\n# Wednesday 4 November 2026\n\nMade at 09:30 for 2026-11-04\. \{\{weather\}\}\n\n`\{\{date\}\}`\n$/);
  });
});

describe("openOrStartToday with a daily notes setting (ADR-0051)", () => {
  it("follows the folder, the pattern with subfolders, and the template", async () => {
    await put("Journal/Template.md", "---\ntags: [journal]\n---\n# Template\n\nSee [[Atlas]] on {{date:ddd}}.\n");
    await open();
    await updateDailySettings(vault!, () => ({ folder: "Journal", pattern: "YYYY/MM/[Day] YYYY-MM-DD", template: "Journal/Template.md" }));
    expect(await openOrStartToday(vault!, NOV_4)).toEqual({ path: "Journal/2026/11/Day 2026-11-04.md", created: true });
    const text = await read("Journal/2026/11/Day 2026-11-04.md");
    expect(text).toMatch(/^---\ntags: \[journal\]\nthoth_id: \S+\n---\n# Day 2026-11-04\n\nSee \[\[Atlas\]\] on Wed\.\n$/);
    // Opened, never changed, on the next call.
    expect(await openOrStartToday(vault!, NOV_4)).toEqual({ path: "Journal/2026/11/Day 2026-11-04.md", created: false });
    expect(await read("Journal/2026/11/Day 2026-11-04.md")).toBe(text);
  });

  it("makes pages at the top level with no template", async () => {
    await put("Templates/Daily.md", "# Daily\n\nUnused.\n");
    await open();
    await updateDailySettings(vault!, () => ({ folder: "", pattern: "D MMM YYYY", template: null }));
    expect(await openOrStartToday(vault!, NOV_4)).toEqual({ path: "4 Nov 2026.md", created: true });
    expect(await read("4 Nov 2026.md")).toMatch(/^---\nthoth_id: \S+\n---\n# 4 Nov 2026\n$/);
  });

  it("opens an existing page in another letter case under the setting's folder", async () => {
    await put("journal/2026-11-04.md", "# Mine\n");
    await open();
    await updateDailySettings(vault!, () => ({ ...DEFAULT_DAILY, folder: "Journal" }));
    expect(await openOrStartToday(vault!, NOV_4)).toEqual({ path: "journal/2026-11-04.md", created: false });
    expect(await read("journal/2026-11-04.md")).toBe("# Mine\n");
  });
});
