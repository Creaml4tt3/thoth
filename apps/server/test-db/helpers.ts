import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";
import pg from "pg";
import { generateToken, hashToken } from "../src/auth.ts";
import { loadConfig, type ServerConfig } from "../src/config.ts";
import { createDatabase, type Database } from "../src/db.ts";
import { opaqueId } from "../src/ids.ts";
import { startServer, type RunningServer, type StartOptions } from "../src/server.ts";

/** A fresh, empty database in the shared container. Dropped by `drop()`. */
export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const admin = new URL(inject("pgAdminUrl"));
  const name = `t_${randomBytes(6).toString("hex")}`;
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const c = new pg.Client({ connectionString: admin.toString() });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export interface TestPrincipal {
  userId: string;
  token: string;
  tokenId: string;
  headers: { authorization: string };
}

export interface TestEnv {
  server: RunningServer;
  db: Database;
  config: ServerConfig;
  blobDir: string;
  databaseUrl: string;
  url: string;
  /** Creates a user with a fresh personal access token. The token exists only in this process. */
  user(name: string): Promise<TestPrincipal>;
  workspace(name: string, options?: { exportRestricted?: boolean; members?: Record<string, "owner" | "editor" | "viewer"> }): Promise<string>;
  /** Stops the server and starts a new one on the same database and blob directory. */
  restart(options?: StartOptions): Promise<void>;
  api(principal: TestPrincipal | null, method: string, path: string, init?: { headers?: Record<string, string>; json?: unknown; body?: Buffer | string | undefined; query?: Record<string, string> }): Promise<ApiResult>;
  close(): Promise<void>;
}

export interface ApiResult {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  bytes: Buffer;
}

export async function startTestEnv(options: { startOptions?: StartOptions; configure?: (c: ServerConfig) => void } = {}): Promise<TestEnv> {
  const database = await createTestDatabase();
  const blobDir = await mkdtemp(join(tmpdir(), "thoth-blobs-"));
  const config = loadConfig({ DATABASE_URL: database.url, BLOB_DIR: blobDir, HOST: "127.0.0.1", PORT: "0", LOG_LEVEL: "silent" });
  options.configure?.(config);
  const env = {} as TestEnv;
  let startOptions = options.startOptions ?? {};
  const boot = async () => {
    env.server = await startServer(config, startOptions);
    env.url = env.server.url;
  };
  await boot();
  env.db = createDatabase(database.url, { max: 3 });
  Object.assign(env, { config, blobDir, databaseUrl: database.url });

  env.user = async (name) => {
    const userId = opaqueId("usr");
    await env.db.query("INSERT INTO users (id, display_name) VALUES ($1, $2)", [userId, name]);
    const token = generateToken();
    const tokenId = opaqueId("tok");
    await env.db.query("INSERT INTO access_tokens (id, user_id, token_hash) VALUES ($1, $2, $3)", [tokenId, userId, hashToken(token)]);
    return { userId, token, tokenId, headers: { authorization: `Bearer ${token}` } };
  };
  env.workspace = async (name, wsOptions = {}) => {
    const id = opaqueId("ws");
    await env.db.query("INSERT INTO workspaces (id, name, export_restricted) VALUES ($1, $2, $3)", [id, name, wsOptions.exportRestricted ?? false]);
    for (const [userId, role] of Object.entries(wsOptions.members ?? {})) await env.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)", [id, userId, role]);
    return id;
  };
  env.restart = async (next) => {
    await env.server.close();
    if (next) startOptions = next;
    await boot();
  };
  env.api = async (principal, method, path, init = {}) => {
    const qs = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";
    const headers: Record<string, string> = { ...(principal?.headers ?? {}), ...(init.headers ?? {}) };
    let body: Buffer | string | undefined = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers["content-type"] ??= "application/json";
    }
    const res = await fetch(`${env.url}/api/v1${path}${qs}`, { method, headers, ...(body === undefined ? {} : { body: body as never }) });
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString("utf8");
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json, bytes };
  };
  env.close = async () => {
    await env.server.close().catch(() => undefined);
    await env.db.close().catch(() => undefined);
    await rm(blobDir, { recursive: true, force: true });
    await database.drop();
  };
  return env;
}
