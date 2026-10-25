/**
 * Two windows on one Private Space (ADR-0019): each window has its own `Vault` over its own connection to the same
 * folder (its own index connection, its own watcher), on the Node ports and on the Rust host. What must hold:
 *
 * - the second window is told the folder is already open, and opening it does not undo work the first has in flight
 *   (journal recovery runs only for the first window);
 * - an edit made in one window shows in the other once it reconciles (its watcher's job);
 * - two saves of the same page give one write and one conflict, never a lost write, even when the second save's last
 *   check passes just before the first one lands (the host compares and renames as one step).
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import { ConflictError, JOURNAL_DIR, TEMP_DIR, Vault, type SqlDriver, type VaultFs } from "@thoth/local-store";
import { NodeSqlDriver, NodeVaultFs } from "@thoth/local-store/node";
import { openRemoteVault } from "@thoth/platform/remote";
import type { StdioTransport } from "@thoth/platform/stdio";
import { buildHarness, rustTransport, tempDir } from "./harness.ts";

const text = (s: string) => new TextEncoder().encode(s);

interface Window {
  fs: VaultFs;
  sql: SqlDriver;
  /** What the host said at open: another window had this folder open already. */
  shared: boolean;
  close(): Promise<void>;
}

interface Runtime {
  name: string;
  /** Opens one more window on `root`; `wrap` may put itself between the Vault and the files. */
  open(root: string, wrap?: (fs: VaultFs) => VaultFs): Promise<Window>;
  dispose(): Promise<void>;
}

/** Node: one process, every connection its own; "shared" is what the host would say (another is open on the root). */
function nodeRuntime(): Runtime {
  const open = new Map<string, number>();
  return {
    name: "node",
    async open(root, wrap = (fs) => fs) {
      const fs = new NodeVaultFs(root);
      await fs.mkdirp(".thoth");
      const sql = new NodeSqlDriver(join(fs.root, ".thoth", "index.sqlite"));
      const shared = (open.get(fs.root) ?? 0) > 0;
      open.set(fs.root, (open.get(fs.root) ?? 0) + 1);
      return { fs: wrap(fs), sql, shared, close: async () => void (await sql.close(), open.set(fs.root, open.get(fs.root)! - 1)) };
    },
    dispose: async () => undefined,
  };
}

/** The Rust host: one host process (one app), one handle per window, as the desktop shell has. */
function rustRuntime(): Runtime {
  let transport: StdioTransport | undefined;
  return {
    name: "rust",
    async open(root, wrap = (fs) => fs) {
      transport ??= await rustTransport({ allowRoots: [root] });
      const connection = await openRemoteVault(transport, root);
      return { fs: wrap(connection.fs), sql: connection.sql, shared: connection.shared ?? false, close: () => connection.close() };
    },
    async dispose() {
      await transport?.close();
      transport = undefined;
    },
  };
}

beforeAll(() => buildHarness(), 600_000);

for (const make of [nodeRuntime, rustRuntime]) {
  describe(`two windows on one Private Space (${make().name})`, () => {
    let root: string;
    let runtime: Runtime;
    const opened: { vault: Vault; window: Window }[] = [];

    async function window(wrap?: (fs: VaultFs) => VaultFs) {
      const w = await runtime.open(root, wrap);
      const { vault } = await Vault.open({ fs: w.fs, sql: w.sql, recover: !w.shared });
      opened.push({ vault, window: w });
      return { vault, window: w };
    }

    beforeEach(async () => {
      runtime = make();
      root = await tempDir("thoth-two-windows-");
      await mkdir(join(root, "Notes"), { recursive: true });
      await writeFile(join(root, "Notes/Plan.md"), "# Plan\n\nFirst draft.\n");
    });
    afterEach(async () => {
      for (const { vault, window: w } of opened.splice(0).reverse()) {
        await vault.close();
        await w.close();
      }
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    });

    it("tells the second window it shares the folder, and does not sweep the first window's write in flight", async () => {
      const first = await window();
      expect(first.window.shared).toBe(false);
      // The first window is between writing its temp file and renaming it (what recovery would call debris).
      const id = "01J00000000000000000000000";
      await writeFile(join(root, TEMP_DIR, `${id}.tmp`), "# Plan\n\nSecond draft.\n");
      await writeFile(join(root, JOURNAL_DIR, `${id}.json`), JSON.stringify({ id, kind: "write-file", path: "Notes/Plan.md", tempPath: `${TEMP_DIR}/${id}.tmp`, expectedHash: null, newHash: null, createdAt: 0 }));
      const second = await window();
      expect(second.window.shared).toBe(true);
      expect(await readdir(join(root, TEMP_DIR))).toEqual([`${id}.tmp`]);
      expect(await readdir(join(root, JOURNAL_DIR))).toEqual([`${id}.json`]);
    });

    it("shows an edit made in one window in the other", async () => {
      const a = await window();
      const b = await window();
      const before = (await b.vault.listPages()).find((p) => p.path === "Notes/Plan.md")!;
      await a.vault.writeFileAtomic("Notes/Plan.md", text("# Roadmap\n\nEdited in the first window.\n"), { expectedHash: before.contentHash });
      await a.vault.writeFileAtomic("Notes/New.md", text("# New\n"), { expectedHash: null });
      await b.vault.reconcile(); // what its watcher triggers
      const pages = await b.vault.listPages();
      expect(pages.map((p) => p.path)).toEqual(["Notes/New.md", "Notes/Plan.md"]);
      expect(pages.find((p) => p.path === "Notes/Plan.md")!.contentHash).toBe(sha256Hex(text("# Roadmap\n\nEdited in the first window.\n")));
      expect((await b.vault.search("edited")).map((h) => h.path)).toEqual(["Notes/Plan.md"]);
    });

    it("gives a conflict, not a lost write, when both windows save the same page from the same version", async () => {
      const a = await window();
      const b = await window();
      const base = sha256Hex(await readFile(join(root, "Notes/Plan.md")));
      await a.vault.writeFileAtomic("Notes/Plan.md", text("# Plan\n\nFrom A.\n"), { expectedHash: base });
      await expect(b.vault.writeFileAtomic("Notes/Plan.md", text("# Plan\n\nFrom B.\n"), { expectedHash: base })).rejects.toBeInstanceOf(ConflictError);
      expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nFrom A.\n");
    });

    it("still gives a conflict when the other window's save lands between the last check and the rename", async () => {
      let other: (() => Promise<void>) | null = null;
      // Window B's files: just before B renames its temp file over the page, A saves the page (the narrowest race).
      const b = await window((fs) => ({
        stat: (p) => fs.stat(p),
        readFile: (p) => fs.readFile(p),
        list: (d) => fs.list(d),
        mkdirp: (d) => fs.mkdirp(d),
        writeFile: (p, d, o) => fs.writeFile(p, d, o),
        remove: (p) => fs.remove(p),
        async rename(from, to, options) {
          const run = other;
          other = null;
          if (run && to === "Notes/Plan.md") await run();
          return fs.rename(from, to, options);
        },
      }));
      const a = await window();
      const base = sha256Hex(await readFile(join(root, "Notes/Plan.md")));
      other = async () => void (await a.vault.writeFileAtomic("Notes/Plan.md", text("# Plan\n\nFrom A.\n"), { expectedHash: base }));
      await expect(b.vault.writeFileAtomic("Notes/Plan.md", text("# Plan\n\nFrom B.\n"), { expectedHash: base })).rejects.toBeInstanceOf(ConflictError);
      expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nFrom A.\n");
      // B's temp file and journal entry are gone: nothing is left for recovery to put back.
      expect(await readdir(join(root, TEMP_DIR))).toEqual([]);
      expect(await readdir(join(root, JOURNAL_DIR))).toEqual([]);
      // And B saves fine once it has the current version.
      const now = sha256Hex(await readFile(join(root, "Notes/Plan.md")));
      await b.vault.writeFileAtomic("Notes/Plan.md", text("# Plan\n\nFrom A, then B.\n"), { expectedHash: now });
      expect(await readFile(join(root, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nFrom A, then B.\n");
    });
  });
}
