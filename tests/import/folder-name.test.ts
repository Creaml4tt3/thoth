import { describe, expect, it } from "vitest";
import { defaultImportRoot, importFolderName, MAX_IMPORT_FOLDER_CHARS } from "@thoth/importer-core";

const DAY = Date.UTC(2026, 9, 22, 12);

describe("importFolderName", () => {
  it("drops the UUIDs and 'Export' label Notion puts in its export file name", () => {
    const name = "38fbabd2-79c6-464e-9ea7-ad3f550c73a3_Export-53d6ae23-ad3e-47c2-b31a-a90029419a2d.zip";
    expect(importFolderName(name, "notion", DAY)).toBe("Notion import 2026-10-22");
    expect(importFolderName("Export-53d6ae23-ad3e-47c2-b31a-a90029419a2d-Part-1.zip", "notion", DAY)).toBe("Part-1");
  });

  it("keeps readable names, including ones a user chose", () => {
    expect(importFolderName("MyVault.zip", "obsidian", DAY)).toBe("MyVault");
    expect(importFolderName("obsidian-vault", "obsidian", DAY)).toBe("obsidian-vault");
    expect(importFolderName("Trip Export.zip", "notion", DAY)).toBe("Trip Export");
    expect(importFolderName("Work notes 1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6.zip", "notion", DAY)).toBe("Work notes");
    expect(importFolderName("บันทึก ทีม.zip", "notion", DAY)).toBe("บันทึก ทีม");
  });

  it("caps the length at a word boundary without splitting Thai characters", () => {
    const long = importFolderName(`${"Quarterly planning notes ".repeat(6)}.zip`, "notion", DAY);
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(long)].length).toBeLessThanOrEqual(MAX_IMPORT_FOLDER_CHARS);
    expect(long.endsWith(" ")).toBe(false);
    expect(long.startsWith("Quarterly planning notes Quarterly")).toBe(true);
    const thai = importFolderName(`${"ที่ปรึกษา".repeat(10)}.zip`, "notion", DAY);
    expect(thai.normalize("NFC")).toBe(thai);
    expect("ที่ปรึกษา".repeat(10).startsWith(thai)).toBe(true);
  });

  it("replaces characters that are unsafe in folder names", () => {
    expect(importFolderName("a:b*c?.zip", "notion", DAY)).toBe("a-b-c");
    expect(importFolderName("...", "obsidian", DAY)).toBe("Obsidian import 2026-10-22");
  });
});

describe("defaultImportRoot", () => {
  it("adds a number when the folder already exists", async () => {
    const taken = new Set(["Imports/Notion import 2026-10-22", "Imports/Notion import 2026-10-22 2"]);
    expect(await defaultImportRoot(async (p) => taken.has(p), "Notion import 2026-10-22")).toBe("Imports/Notion import 2026-10-22 3");
    expect(await defaultImportRoot(async () => false, "MyVault")).toBe("Imports/MyVault");
  });
});
