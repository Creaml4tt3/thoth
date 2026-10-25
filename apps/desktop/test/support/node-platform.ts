/**
 * A `Platform` over Node ports on temp directories, for UI tests. The folder
 * picker returns a preset path and the watcher is driven by the test.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Platform, VaultChangedEvent, VaultConnection, Windows } from "@thoth/platform";
import { NodeSqlDriver, NodeVaultFs } from "@thoth/local-store/node";
import { openNodeSourceHost } from "@thoth/importer-core/node";
import { NodeAgentHost } from "@thoth/agent-core/node";
import { FakeServers } from "../../../../tests/helpers/fake-servers.ts";

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
  /** Folders another (unrendered) window has open: connections to them are `shared`. */
  sharedWith: string[];
  /** In-memory workspace servers (no server known by default). */
  servers: FakeServers;
  /** Agent CLIs (the fake claude in tests); absent unless asked for, like a host without the Agent Hub. */
  agents?: NodeAgentHost;
  /** More windows (ADR-0019); absent unless asked for, like a host with one window. */
  windows?: FakeWindows;
}

/** The desktop shell's windows, recorded: what was opened, and a way to say another window closed. */
export interface FakeWindows extends Windows {
  opened: { id: string; root: string; tabs: string; at?: { x: number; y: number } }[];
  /** How many other windows `closeThis` sees (0: this is the last one, it stays). */
  others: number;
  closed: number;
  /** The shell reports that the window `id` was closed. */
  emitClosed(id: string): void;
  /** The window's close button (or Quit) was used: the shell asks the page to write its edits and close. */
  emitCloseRequested(): void;
}

export function createFakeWindows(): FakeWindows {
  const listeners = new Set<(id: string) => void>();
  const closeListeners = new Set<() => void>();
  const windows: FakeWindows = {
    opened: [],
    others: 0,
    closed: 0,
    async open(request) {
      windows.opened.push(request);
    },
    async closeThis(options) {
      if (windows.others === 0 && options?.evenIfLast !== true) return false;
      windows.closed++;
      return true;
    },
    async onClosed(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async onCloseRequested(listener) {
      closeListeners.add(listener);
      return () => void closeListeners.delete(listener);
    },
    emitClosed(id) {
      for (const listener of [...listeners]) listener(id);
    },
    emitCloseRequested() {
      for (const listener of [...closeListeners]) listener();
    },
  };
  return windows;
}

export function createNodePlatform(options: { vault?: string | null; servers?: FakeServers; agents?: { dataDir: string; searchDirs: string[] }; windows?: FakeWindows; recent?: string[] } = {}): NodePlatform {
  const listeners = new Set<Listener>();
  const connections: VaultConnection[] = [];
  const open: VaultConnection[] = [];
  const platform: NodePlatform = {
    kind: "node",
    pickedVault: options.vault ?? null,
    pickedSource: null,
    recent: options.recent ?? [],
    connections,
    sharedWith: [],
    servers: options.servers ?? new FakeServers(),
    ...(options.agents ? { agents: new NodeAgentHost({ ...options.agents, excludeRoots: () => connections.map((c) => c.root) }) } : {}),
    ...(options.windows ? { windows: options.windows } : {}),
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
      // Another window of this "app" on the same folder (`sharedWith` stands in for windows a test does not render).
      const others = () => open.filter((c) => c.root === fs.root && c !== connection).length + (platform.sharedWith.includes(fs.root) ? 1 : 0);
      let closed = false;
      const connection: VaultConnection = {
        root: fs.root,
        label: fs.root.split("/").pop() ?? fs.root,
        shared: false,
        isShared: async () => !closed && others() > 0,
        fs,
        sql,
        async watch(listener) {
          listeners.add(listener);
          return async () => void listeners.delete(listener);
        },
        close: async () => {
          closed = true;
          open.splice(open.indexOf(connection), 1);
          await sql.close();
        },
      };
      (connection as { shared: boolean }).shared = others() > 0;
      open.push(connection);
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
      // A just-unmounted app may still finish a write into the vault; retry instead of failing with ENOTEMPTY.
      await Promise.all(made.splice(0).map((p) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
    },
  };
}
