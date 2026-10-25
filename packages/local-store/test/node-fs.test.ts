// The Node port's compare-and-rename (`rename` with `replaceHash`, ADR-0019): one at a time per folder in this process,
// however each window spelled the folder's path.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import { NodeVaultFs } from "../src/node/index.ts";

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "thoth-node-fs-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

it("compares and renames one at a time for every spelling of the folder's path", async () => {
  const root = join(base, "Notes");
  await mkdir(root);
  await symlink(root, join(base, "Alias"));
  const first = new NodeVaultFs(root);
  const second = new NodeVaultFs(join(base, "Alias"));
  for (let round = 0; round < 10; round++) {
    const before = `# Plan ${round}\n`;
    await writeFile(join(root, "Plan.md"), before);
    await first.writeFile("a.tmp", new TextEncoder().encode("From A.\n"));
    await second.writeFile("b.tmp", new TextEncoder().encode("From B.\n"));
    const both = await Promise.allSettled([
      first.rename("a.tmp", "Plan.md", { replaceHash: sha256Hex(new TextEncoder().encode(before)) }),
      second.rename("b.tmp", "Plan.md", { replaceHash: sha256Hex(new TextEncoder().encode(before)) }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
    expect((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });
    const winner = both[0]!.status === "fulfilled" ? "From A.\n" : "From B.\n";
    expect(await readFile(join(root, "Plan.md"), "utf8")).toBe(winner);
    await rm(join(root, "a.tmp"), { force: true });
    await rm(join(root, "b.tmp"), { force: true });
  }
});
