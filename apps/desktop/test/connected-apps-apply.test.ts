// Applying a connected app's proposal (ADR-0048) with compare-and-swap, on a real Vault: written only while the page
// is the version it was proposed from; otherwise conflicted, with nothing written; a new page never replaces a file;
// "apply anyway" only over the version the user saw.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@thoth/local-store";
import type { ConnectedAppProposalText } from "@thoth/platform";
import { applyProposal } from "../src/features/connected-apps/apply.ts";
import { FakeConnectedApps } from "./support/connected-apps.ts";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";

const dirs = tempDirs();
let root: string;
let vault: Vault;
let apps: FakeConnectedApps;

beforeEach(async () => {
  root = await dirs.dir();
  await writeFile(join(root, "Plan.md"), "# Plan\n");
  const connection = await createNodePlatform({ vault: root }).openVault(root);
  vault = (await Vault.open({ fs: connection.fs, sql: connection.sql })).vault;
  apps = new FakeConnectedApps();
});

afterEach(() => dirs.cleanup());

async function kept(kind: "create" | "edit", path: string, after: string): Promise<ConnectedAppProposalText> {
  const before = kind === "edit" ? await vault.readPage(path) : null;
  const id = `prop_${apps.kept.length.toString().padStart(32, "0")}`;
  apps.propose({ id, app: "Claude", kind, root, space: "Notes", path, baseHash: before?.hash ?? null, before: before?.source ?? null, after });
  return apps.proposal(id);
}

const text = (path: string) => readFile(join(root, path), "utf8");

describe("applyProposal", () => {
  it("writes an unchanged page and records it as applied", async () => {
    const proposal = await kept("edit", "Plan.md", "# Plan\n\nMore.\n");
    expect(await applyProposal(vault, apps, proposal)).toEqual({ status: "applied" });
    expect(await text("Plan.md")).toBe("# Plan\n\nMore.\n");
    expect(apps.calls).toEqual([["settle", proposal.id, "applied"]]);
  });

  it("leaves a page that changed since: conflicted, with the page as it is now", async () => {
    const proposal = await kept("edit", "Plan.md", "# Plan\n\nMore.\n");
    await writeFile(join(root, "Plan.md"), "# Plan, edited\n");
    const outcome = await applyProposal(vault, apps, proposal);
    expect(outcome).toEqual({ status: "conflicted", current: { source: "# Plan, edited\n", hash: expect.any(String) } });
    expect(await text("Plan.md")).toBe("# Plan, edited\n");
    expect(apps.calls).toEqual([["settle", proposal.id, "conflicted"]]);

    // Applied on purpose over the version the user saw; not over a later one.
    const again = { ...proposal, status: "conflicted" as const };
    const seen = outcome.status === "conflicted" ? outcome.current : null;
    await writeFile(join(root, "Plan.md"), "# Plan, edited twice\n");
    expect((await applyProposal(vault, apps, again, seen)).status).toBe("conflicted");
    expect(await text("Plan.md")).toBe("# Plan, edited twice\n");
    const now = await vault.readPage("Plan.md");
    expect(await applyProposal(vault, apps, again, { source: now.source, hash: now.hash })).toEqual({ status: "applied" });
    expect(await text("Plan.md")).toBe("# Plan\n\nMore.\n");
  });

  it("makes a new page only where there is no file, and never replaces one", async () => {
    const fresh = await kept("create", "Ideas/New.md", "# New\n");
    expect((await applyProposal(vault, apps, fresh)).status).toBe("applied");
    expect(await text("Ideas/New.md")).toBe("# New\n");

    const taken = await kept("create", "Plan.md", "# Not yours\n");
    expect((await applyProposal(vault, apps, taken)).status).toBe("conflicted");
    expect(await text("Plan.md")).toBe("# Plan\n");
    await expect(applyProposal(vault, apps, { ...taken, status: "conflicted" }, null)).rejects.toThrow(/never replaces/);
  });

  it("refuses a settled proposal and a path in .thoth/", async () => {
    const proposal = await kept("edit", "Plan.md", "x");
    await expect(applyProposal(vault, apps, { ...proposal, after: null })).rejects.toThrow(/settled/);
    const hidden = await kept("create", ".thoth/x.md", "x");
    await expect(applyProposal(vault, apps, hidden)).rejects.toThrow(/\.thoth/);
  });
});
