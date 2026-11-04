// The daily notes setting (ADR-0051 rules 7, 8 and 11): `.thoth/daily.json` read and written with compare-and-swap, the
// defaults for a missing or broken record, the checks, and Obsidian's `.obsidian/daily-notes.json` read once.
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  DAILY_PATH,
  DEFAULT_DAILY,
  dailyPath,
  dailySettingsProblem,
  obsidianDailySettings,
  readDailySettings,
  readObsidianDailySettings,
  recordPath,
  updateDailySettings,
  type Vault,
} from "../src/index.ts";
import { openNodeVault } from "../src/node/index.ts";

let root: string;
let vault: Vault;
async function put(path: string, content: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-daily-"));
  await put("Notes/A.md", "# A\n");
  ({ vault } = await openNodeVault(root));
});
afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

describe("the daily notes setting (.thoth/daily.json)", () => {
  it("is a record path, and the defaults are 0.6.0's when it is missing", async () => {
    expect(recordPath(DAILY_PATH)).toBe(".thoth/daily.json");
    expect(await readDailySettings(vault)).toEqual({ settings: { folder: "Daily", pattern: "YYYY-MM-DD", template: "Templates/Daily.md" }, exists: false, hash: null });
  });

  it("is the defaults when malformed or refused, but still known to exist", async () => {
    for (const text of ["{not json", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, folder: "../out", pattern: "YYYY", template: null }), JSON.stringify({ version: 1, folder: "", pattern: "gggg", template: null })]) {
      await put(DAILY_PATH, text);
      const read = await readDailySettings(vault);
      expect(read.settings).toEqual(DEFAULT_DAILY);
      expect(read.exists).toBe(true);
    }
  });

  it("writes and reads back, and a second window's write is not lost", async () => {
    const mine = { folder: "Journal", pattern: "YYYY/MM-DD", template: null };
    expect(await updateDailySettings(vault, () => mine)).toEqual(mine);
    expect(JSON.parse(await readFile(join(root, DAILY_PATH), "utf8"))).toEqual({ version: 1, ...mine });
    expect((await readDailySettings(vault)).settings).toEqual(mine);

    // Another window writes between this one's read and write: the change runs again on what it wrote.
    const seen: string[] = [];
    let other = true;
    await updateDailySettings(vault, (current) => {
      seen.push(current.folder);
      if (other) {
        other = false;
        // The other window's write lands now, before this one's.
        writeFileSync(join(root, DAILY_PATH), JSON.stringify({ version: 1, ...mine, folder: "Other" }));
      }
      return { ...current, template: "T.md" };
    });
    expect(seen).toEqual(["Journal", "Other"]);
    expect((await readDailySettings(vault)).settings).toEqual({ ...mine, folder: "Other", template: "T.md" });

    const read = await readDailySettings(vault);
    await vault.writeRecordIfUnchanged(DAILY_PATH, { version: 1, ...DEFAULT_DAILY }, read.hash);
    await expect(vault.writeRecordIfUnchanged(DAILY_PATH, { version: 1, ...mine }, read.hash)).rejects.toBeInstanceOf(ConflictError);
  });

  it("writes nothing when the change says so, and refuses a bad setting", async () => {
    expect(await updateDailySettings(vault, () => null)).toEqual(DEFAULT_DAILY);
    expect(await readdir(join(root, ".thoth"))).not.toContain("daily.json");
    await expect(updateDailySettings(vault, () => ({ ...DEFAULT_DAILY, pattern: "YYYY-ww" }))).rejects.toThrow(/pattern/);
  });
});

describe("dailySettingsProblem and dailyPath", () => {
  const nov4 = new Date(2026, 10, 4);
  it("accepts the top level, subfolders and Thai", () => {
    expect(dailySettingsProblem({ folder: "", pattern: "YYYY/MMMM/YYYY-MMM-DD", template: null })).toBeNull();
    expect(dailyPath({ folder: "", pattern: "YYYY/MMMM/YYYY-MMM-DD", template: null }, nov4)).toBe("2026/November/2026-Nov-04.md");
    expect(dailyPath({ folder: "บันทึก/รายวัน", pattern: "[วันที่] DD-MM-YYYY", template: null }, nov4)).toBe("บันทึก/รายวัน/วันที่ 04-11-2026.md");
  });

  it("refuses unsafe folders, names and templates", () => {
    expect(dailySettingsProblem({ ...DEFAULT_DAILY, folder: "../Daily" })).toEqual({ field: "folder" });
    expect(dailySettingsProblem({ ...DEFAULT_DAILY, folder: ".obsidian" })).toEqual({ field: "folder" });
    expect(dailySettingsProblem({ ...DEFAULT_DAILY, folder: ".thoth/x" })).toEqual({ field: "folder" });
    expect(dailySettingsProblem({ ...DEFAULT_DAILY, pattern: "YYYY:MM" })).toEqual({ field: "pattern", kind: "name" });
    expect(dailySettingsProblem({ ...DEFAULT_DAILY, pattern: "YYYY//DD" })).toEqual({ field: "pattern", kind: "name" });
    expect(dailySettingsProblem({ ...DEFAULT_DAILY, pattern: "Do" })).toEqual({ field: "pattern", kind: "token", token: "o" });
    expect(dailySettingsProblem({ ...DEFAULT_DAILY, template: "Templates/Daily" })).toEqual({ field: "template" });
    expect(dailySettingsProblem({ ...DEFAULT_DAILY, template: "/abs.md" })).toEqual({ field: "template" });
  });
});

describe("Obsidian's .obsidian/daily-notes.json, read once", () => {
  it("reads a real file's keys: folder, format and a template without .md", async () => {
    await put(".obsidian/daily-notes.json", JSON.stringify({ folder: "Journal/Daily", format: "YYYY/MM/YYYY-MM-DD", template: "Templates/Daily Note", autorun: true }, null, 2));
    expect(await readObsidianDailySettings(vault)).toEqual({ folder: "Journal/Daily", pattern: "YYYY/MM/YYYY-MM-DD", template: "Templates/Daily Note.md" });
  });

  it("fills Obsidian's defaults: empty folder is the top level, empty format is YYYY-MM-DD, empty template is none", async () => {
    await put(".obsidian/daily-notes.json", "{}");
    expect(await readObsidianDailySettings(vault)).toEqual({ folder: "", pattern: "YYYY-MM-DD", template: null });
    expect(obsidianDailySettings({ folder: " /Daily/ ", format: "", template: "/T.md" })).toEqual({ folder: "Daily", pattern: "YYYY-MM-DD", template: "T.md" });
    expect(obsidianDailySettings({ folder: 3, format: null })).toEqual({ folder: "", pattern: "YYYY-MM-DD", template: null });
  });

  it("is nothing when missing or not a JSON object, and is never written", async () => {
    expect(await readObsidianDailySettings(vault)).toBeUndefined();
    await put(".obsidian/daily-notes.json", "[1]");
    expect(await readObsidianDailySettings(vault)).toBeUndefined();
    await put(".obsidian/daily-notes.json", "{broken");
    expect(await readObsidianDailySettings(vault)).toBeUndefined();
    expect(await readFile(join(root, ".obsidian/daily-notes.json"), "utf8")).toBe("{broken");
  });

  it("keeps a pattern Thoth cannot make, so the question can show why", async () => {
    await put(".obsidian/daily-notes.json", JSON.stringify({ format: "gggg-[W]ww" }));
    const found = (await readObsidianDailySettings(vault))!;
    expect(dailySettingsProblem(found)).toEqual({ field: "pattern", kind: "token", token: "gggg" });
  });
});
