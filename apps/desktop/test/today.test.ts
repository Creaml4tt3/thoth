// Today (ADR-0050 rules 11–15), on a real vault without a window: the date and its file name, the template with its
// links rewritten, an existing page opened and never changed, and a name that differs only in case.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeVault } from "@thoth/local-store/node";
import type { Vault } from "@thoth/local-store";
import { isoDate, msUntilMidnight, openOrStartToday, todayPath } from "../src/features/shell/today.ts";

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
    expect(isoDate(NOV_4)).toBe("2026-11-04");
    expect(isoDate(new Date(2027, 0, 1, 0, 0, 1))).toBe("2027-01-01");
    expect(isoDate(new Date(2026, 10, 4, 23, 59, 59))).toBe("2026-11-04");
    expect(todayPath(new Date(987, 2, 9))).toBe("Daily/0987-03-09.md");
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
});
