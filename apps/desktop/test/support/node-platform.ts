/**
 * A `Platform` over Node ports on temp directories, for UI tests. The folder
 * picker returns a preset path and the watcher is driven by the test.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Platform, VaultChangedEvent, VaultConnection } from "@thoth/platform";
import { NodeSqlDriver, NodeVaultFs } from "@thoth/local-store/node";
import { openNodeSourceHost } from "@thoth/importer-core/node";

type Listener = (event: Omit<VaultChangedEvent, "vault">) => void;

export interface NodePlatform extends Platform {
  /** Path `pickVaultFolder` returns (null simulates cancelling). */
  pickedVault: string | null;
  pickedSource: string | null;
  recent: string[];
  /** Fires the watcher listeners like the host would. */
  emit(event?: Partial<Omit<VaultChangedEvent, "vault">>): void;
  /** Number of live watchers. */
  watchers(): number;
  /** Connections handed out so far. */
  connections: VaultConnection[];
}

export function createNodePlatform(options: { vault?: string | null } = {}): NodePlatform {
  const listeners = new Set<Listener>();
  const connections: VaultConnection[] = [];
  const platform: NodePlatform = {
    kind: "node",
    pickedVault: options.vault ?? null,
    pickedSource: null,
    recent: [],
    connections,
    async pickVaultFolder() {
      return platform.pickedVault;
    },
    async recentVaults() {
      return platform.recent;
    },
    async openVault(root) {
      const fs = new NodeVaultFs(root);
      await fs.mkdirp(".thoth");
      const sql = new NodeSqlDriver(join(fs.root, ".thoth", "index.sqlite"));
      const connection: VaultConnection = {
        root: fs.root,
        label: fs.root.split("/").pop() ?? fs.root,
        fs,
        sql,
        async watch(listener) {
          listeners.add(listener);
          return async () => void listeners.delete(listener);
        },
        close: () => sql.close(),
      };
      connections.push(connection);
      return connection;
    },
    async pickImportSource() {
      return platform.pickedSource;
    },
    async openImportSource(location) {
      return openNodeSourceHost(location);
    },
    emit(event = {}) {
      for (const listener of [...listeners]) listener({ paths: [], rescan: false, ...event });
    },
    watchers: () => listeners.size,
  };
  return platform;
}

/** Creates a temp directory; `cleanup` removes everything made through `dir()`. */
export function tempDirs() {
  const made: string[] = [];
  return {
    async dir(prefix = "thoth-ui-"): Promise<string> {
      const path = await mkdtemp(join(tmpdir(), prefix));
      made.push(path);
      return path;
    },
    async cleanup(): Promise<void> {
      await Promise.all(made.splice(0).map((p) => rm(p, { recursive: true, force: true })));
    },
  };
}
