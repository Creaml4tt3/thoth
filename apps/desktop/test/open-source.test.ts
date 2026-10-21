import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planImport, runImport } from "@thoth/importer-core";
import { Vault } from "@thoth/local-store";
import { writeZip } from "../../../tests/helpers/zip.ts";
import { openImportSource } from "../src/features/import/open-source.ts";
import { createNodePlatform } from "./support/node-platform.ts";

const FIXTURE = join(import.meta.dirname, "../../../tests/fixtures/obsidian-vault");
const made: string[] = [];
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "thoth-open-source-"));
  made.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("desktop openImportSource", () => {
  it("imports a folder and a ZIP through the platform's source host", async () => {
    const platform = createNodePlatform();
    const connection = await platform.openVault(await temp());
    const { vault } = await Vault.open({ fs: connection.fs, sql: connection.sql });
    try {
      const folder = await openImportSource(platform, "obsidian-vault", FIXTURE);
      const planned = await planImport({ vault, ...folder, options: { destinationRoot: "FromFolder" } });
      const report = await runImport(vault, folder.source, planned.manifest);
      await folder.source.close();
      expect(report.state).toBe("completed");
      expect(report.imported.pages).toBe(planned.preview.pages);

      const zipPath = await writeZip(join(await temp(), "notes.zip"), [
        { name: "Vault/Note.md", data: "# Note\n\nSee [[Other]].\n" },
        { name: "Vault/Other.md", data: "# Other\n" },
      ]);
      const zip = await openImportSource(platform, "obsidian-zip", zipPath);
      const zipPlan = await planImport({ vault, ...zip, options: { destinationRoot: "FromZip", addIdentityFrontmatter: false } });
      expect((await runImport(vault, zip.source, zipPlan.manifest)).state).toBe("completed");
      await zip.source.close();
      expect(await readFile(join(connection.root, "FromZip/Note.md"), "utf8")).toBe("# Note\n\nSee [[Other]].\n");
    } finally {
      await vault.close();
    }
  });

  it("refuses a source of the wrong kind and releases the host", async () => {
    const platform = createNodePlatform();
    await expect(openImportSource(platform, "obsidian-zip", FIXTURE)).rejects.toThrow();
  });
});
