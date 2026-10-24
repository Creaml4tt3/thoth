/** A vault on a temp directory, fake workspace servers, and a `TransferEngine` wired to both. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";
import { openNodeVault } from "@thoth/local-store/node";
import { WorkspaceClient, type Send } from "@thoth/workspace-client";
import { FakeServers, type FakeServerConfig, type FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";
import { TransferEngine, type TransferEngineOptions } from "../src/index.ts";

export const SERVER: FakeServerConfig = { url: "https://team.example", name: "Team" };

export interface World {
  root: string;
  vault: Vault;
  servers: FakeServers;
  server: string;
  ws: FakeWorkspace;
  engine: TransferEngine;
  /** A fresh engine (and vault) on the same folder, as after a restart. */
  restart(options?: Partial<TransferEngineOptions>): Promise<TransferEngine>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  hash(path: string): Promise<string>;
  close(): Promise<void>;
}

export function clientFor(servers: FakeServers, server: string): WorkspaceClient {
  const send: Send = async (req) => servers.call({ server, method: req.method, path: req.path, ...(req.query ? { query: req.query } : {}), ...(req.headers ? { headers: req.headers } : {}) }, req.body);
  return new WorkspaceClient(send);
}

export async function world(files: Record<string, string>, options: { config?: FakeServerConfig; workspace?: Parameters<FakeServers["addWorkspace"]>[1]; engine?: Partial<TransferEngineOptions> } = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "thoth-transfer-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const servers = new FakeServers();
  const config = options.config ?? SERVER;
  const server = servers.connect(config);
  const ws = servers.addWorkspace(server, options.workspace ?? { name: "Studio" });
  let { vault } = await openNodeVault(root);
  const make = (v: Vault, extra: Partial<TransferEngineOptions> = {}) =>
    new TransferEngine({ vault: v, server: (id) => (id === server ? { client: clientFor(servers, server), url: config.url } : undefined), now: () => new Date("2026-10-24T10:00:00Z"), ...options.engine, ...extra });
  const w: World = {
    root,
    vault,
    servers,
    server,
    ws,
    engine: make(vault),
    async restart(extra = {}) {
      await w.vault.close();
      ({ vault } = await openNodeVault(root));
      w.vault = vault;
      w.engine = make(vault, extra);
      return w.engine;
    },
    read: (path) => readFile(join(root, path), "utf8"),
    async write(path, text) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
      await w.vault.reconcile();
    },
    exists: (path) =>
      readFile(join(root, path)).then(
        () => true,
        () => false,
      ),
    hash: async (path) => sha256Hex(await readFile(join(root, path))),
    async close() {
      await w.vault.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
  return w;
}

/** Live (not deleted) pages of a fake workspace. */
export const livePages = (ws: FakeWorkspace) => [...ws.pages.values()].filter((p) => !p.deleted);

/** The `thoth_id` in a page's frontmatter. */
export const thothIdOf = (text: string): string | undefined => /^thoth_id:\s*["']?([0-9a-f-]{36})/m.exec(text)?.[1];
