import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newStableId, sha256Hex } from "@thoth/domain";
import { ConflictError, JOURNAL_DIR, journalTempPath, recordPath, TEMP_DIR, type Vault, type VaultFs } from "../src/index.ts";
import { NodeVaultFs, openNodeVault } from "../src/node/index.ts";

let root: string;
let vault: Vault;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-records-"));
  await mkdir(join(root, "Notes"), { recursive: true });
  await writeFile(join(root, "Notes/A.md"), "# A\n");
  ({ vault } = await openNodeVault(root));
});

afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

describe("durable records", () => {
  it("writes, reads, lists and removes records under .thoth/ only", async () => {
    await vault.writeRecord(".thoth/sync/ws.json", { a: 1 });
    expect(await vault.readRecord(".thoth/sync/ws.json")).toEqual({ a: 1 });
    expect(await vault.listRecords(".thoth/sync")).toEqual(["ws.json"]);
    expect(await readdir(join(root, TEMP_DIR))).toEqual([]);
    await vault.removeRecord(".thoth/sync/ws.json");
    expect(await vault.readRecord(".thoth/sync/ws.json")).toBeUndefined();
    for (const bad of ["Notes/A.md", ".thoth/x.json", ".thoth/index.sqlite/x.json", ".thoth/tmp/x.json", ".thoth/operations/journal/x.json", ".thoth/sync/../../A.json", ".thoth/sync/a.txt"]) {
      expect(() => recordPath(bad), bad).toThrow();
    }
    // The tree order is the one record directly under .thoth/.
    expect(recordPath(".thoth/order.json")).toBe(".thoth/order.json");
    expect(() => recordPath(".thoth/other.json")).toThrow();
  });

  it("a crash before the rename leaves the previous record and only a temp file, swept on open", async () => {
    await vault.writeRecord(".thoth/sync/ws.json", { v: 1 });
    // Simulate the half-done write: the temp file exists, the rename never happened.
    await writeFile(join(root, journalTempPath(newStableId())), "{ torn");
    await vault.close();
    ({ vault } = await openNodeVault(root));
    expect(await vault.readRecord(".thoth/sync/ws.json")).toEqual({ v: 1 });
    expect(await readdir(join(root, TEMP_DIR))).toEqual([]);
  });
});

describe("deleteFileAtomic", () => {
  const hashOf = async (path: string) => sha256Hex(await readFile(join(root, path)));

  it("deletes a file whose hash matches and updates the index", async () => {
    await vault.deleteFileAtomic("Notes/A.md", { expectedHash: await hashOf("Notes/A.md") });
    expect(await readdir(join(root, "Notes"))).toEqual([]);
    expect(await vault.pageByPath("Notes/A.md")).toBeUndefined();
    expect(await readdir(join(root, JOURNAL_DIR))).toEqual([]);
  });

  it("refuses a file edited since it was read and leaves it untouched", async () => {
    const stale = await hashOf("Notes/A.md");
    await writeFile(join(root, "Notes/A.md"), "# A edited\n");
    await expect(vault.deleteFileAtomic("Notes/A.md", { expectedHash: stale })).rejects.toBeInstanceOf(ConflictError);
    expect(await readFile(join(root, "Notes/A.md"), "utf8")).toBe("# A edited\n");
  });

  it("an edit that lands between the check and the move is put back, never deleted", async () => {
    const expected = await hashOf("Notes/A.md");
    await vault.close();
    // A filesystem whose rename-away happens just after an external editor wrote new bytes.
    const fs = new NodeVaultFs(root);
    const racing: VaultFs = {
      ...bind(fs),
      async rename(from, to, options) {
        if (from === "Notes/A.md" && to.startsWith(TEMP_DIR)) await writeFile(join(root, "Notes/A.md"), "# A raced\n");
        return fs.rename(from, to, options);
      },
    };
    ({ vault } = await openWith(racing));
    await expect(vault.deleteFileAtomic("Notes/A.md", { expectedHash: expected })).rejects.toBeInstanceOf(ConflictError);
    expect(await readFile(join(root, "Notes/A.md"), "utf8")).toBe("# A raced\n");
  });

  it("a crash after the move restores the file on the next open", async () => {
    const expected = await hashOf("Notes/A.md");
    await vault.close();
    const fs = new NodeVaultFs(root);
    const crashing: VaultFs = {
      ...bind(fs),
      async readFile(path) {
        if (path.startsWith(TEMP_DIR)) throw new Error("simulated crash");
        return fs.readFile(path);
      },
    };
    ({ vault } = await openWith(crashing));
    await expect(vault.deleteFileAtomic("Notes/A.md", { expectedHash: expected })).rejects.toThrow("simulated crash");
    expect(await readdir(join(root, "Notes"))).toEqual([]); // moved away, not yet deleted
    await vault.close();
    ({ vault } = await openNodeVault(root));
    expect(await readFile(join(root, "Notes/A.md"), "utf8")).toBe("# A\n");
    expect(await readdir(join(root, JOURNAL_DIR))).toEqual([]);
  });

  it("restores next to a new file that took the path, never over it", async () => {
    const id = newStableId();
    await writeFile(join(root, journalTempPath(id)), "# old A\n");
    await writeFile(join(root, JOURNAL_DIR, `${id}.json`), JSON.stringify({ id, kind: "delete-file", path: "Notes/A.md", tempPath: journalTempPath(id), expectedHash: "x", newHash: null, createdAt: 1 }));
    await vault.close();
    ({ vault } = await openNodeVault(root));
    expect(await readFile(join(root, "Notes/A.md"), "utf8")).toBe("# A\n");
    expect(await readFile(join(root, "Notes/A (recovered).md"), "utf8")).toBe("# old A\n");
  });

  it("a forged delete-file entry naming .thoth/ is ignored", async () => {
    const id = newStableId();
    await writeFile(join(root, journalTempPath(id)), "x");
    await writeFile(join(root, JOURNAL_DIR, `${id}.json`), JSON.stringify({ id, kind: "delete-file", path: ".thoth/config.json", tempPath: journalTempPath(id), expectedHash: "x", newHash: null, createdAt: 1 }));
    await vault.close();
    const reopened = await openNodeVault(root);
    vault = reopened.vault;
    expect(reopened.report.warnings.some((w) => w.code === "invalid_journal_entry")).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".thoth/config.json"), "utf8"))).toHaveProperty("vaultId");
  });
});

describe("projections", () => {
  it("projects operations and sync records into the index", async () => {
    await vault.projectOperation({ id: "op1", kind: "transfer", state: "stage", updatedAt: 5 });
    await vault.projectOperation({ id: "op1", kind: "transfer", state: "done", updatedAt: 6 });
    expect(await vault.listOperationJournal()).toEqual([{ id: "op1", kind: "transfer", state: "done", updatedAt: 6 }]);
    await vault.projectSyncRecords("https://s/ws", [{ pageId: "p1", remoteId: "r1", remoteRevision: "rev", baseHash: "h" }]);
    await vault.projectSyncRecords("https://s/ws", [{ pageId: "p2", remoteId: "r2", remoteRevision: null, baseHash: null }]);
    expect(await vault.listExternalLocations()).toEqual([{ pageId: "p2", workspaceUrl: "https://s/ws", remoteId: "r2" }]);
  });
});

function bind(fs: NodeVaultFs): VaultFs {
  return {
    stat: (p) => fs.stat(p),
    readFile: (p) => fs.readFile(p),
    list: (d) => fs.list(d),
    mkdirp: (d) => fs.mkdirp(d),
    writeFile: (p, d, o) => fs.writeFile(p, d, o),
    rename: (f, t, o) => fs.rename(f, t, o),
    remove: (p) => fs.remove(p),
  };
}

async function openWith(fs: VaultFs) {
  const { Vault } = await import("../src/index.ts");
  const { NodeSqlDriver } = await import("../src/node/index.ts");
  return Vault.open({ fs, sql: new NodeSqlDriver(join(root, ".thoth", "index.sqlite")) });
}
