import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSkills, readSkill, type Vault } from "../src/index.ts";
import { openNodeVault } from "../src/node/index.ts";

let root: string;
let vault: Vault;

async function put(path: string, content: string | Uint8Array) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-skills-"));
  await put("Skills/weekly-update/SKILL.md", "---\nname: weekly-update\ndescription: Writes the weekly update.\n---\nBlockers first.\n");
  await put("Skills/weekly-update/references/style.md", "Short lines.\n");
  await put("Skills/weekly-update/logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]));
  await put("Skills/weekly-update/.secret", "x");
  await put("Skills/Review/skill.md", "No frontmatter.\n");
  await put("Skills/Loose.md", "Not in a folder.\n");
  await put("Notes/Skills/x/SKILL.md", "Not at the top.\n");
  ({ vault } = await openNodeVault(root));
});

afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

describe("skills (ADR-0052 rule 7)", () => {
  it("lists Skills/<name>/SKILL.md (skill.md too), by name, with the description", async () => {
    expect(await listSkills(vault)).toEqual([
      { name: "Review", description: "", path: "Skills/Review/skill.md" },
      { name: "weekly-update", description: "Writes the weekly update.", path: "Skills/weekly-update/SKILL.md" },
    ]);
  });

  it("reads SKILL.md or a text file beside it, never a hidden one or one that is not text", async () => {
    expect(await readSkill(vault, "WEEKLY-update")).toEqual({
      name: "weekly-update",
      path: "Skills/weekly-update/SKILL.md",
      text: expect.stringContaining("Blockers first."),
      files: ["logo.png", "references/style.md"],
    });
    expect(await readSkill(vault, "weekly-update", "References/Style.md")).toMatchObject({ path: "Skills/weekly-update/references/style.md", text: "Short lines.\n" });
    for (const file of ["logo.png", ".secret", "nope.md"]) expect(await readSkill(vault, "weekly-update", file), file).toBeNull();
    expect(await readSkill(vault, "nope")).toBeNull();
  });
});
