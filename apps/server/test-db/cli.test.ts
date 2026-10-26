import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "./helpers.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

const run = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

describe("admin CLI", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let dir: string;
  let server: RunningServer | undefined;
  const cli = async (args: string[], env: Record<string, string> = { DATABASE_URL: database.url }) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), "thoth-cli-"));
  });
  afterAll(async () => {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
    await database.drop();
  });

  it("provisions a user, workspace, membership and token; the token only ever lands in the 0600 file", async () => {
    const migrated = await cli(["migrate"]);
    expect(migrated.code).toBe(0);
    expect(migrated.stdout).toContain("applied: 001_core.sql");
    expect((await cli(["migrate"])).stdout).toContain("up to date");

    const userId = (await cli(["create-user", "--name", "Ada ไทย"])).stdout.trim();
    const wsId = (await cli(["create-workspace", "--name", "Team", "--export-restricted"])).stdout.trim();
    expect(userId).toMatch(/^usr_[A-Za-z0-9_-]+$/);
    expect(wsId).toMatch(/^ws_[A-Za-z0-9_-]+$/);
    expect((await cli(["add-member", "--workspace", wsId, "--user", userId, "--role", "owner"])).stdout.trim()).toBe("ok");

    const out = join(dir, "token");
    const created = await cli(["create-token", "--user", userId, "--out", out]);
    expect(created.code).toBe(0);
    const token = (await readFile(out, "utf8")).trim();
    expect(token).toMatch(/^thoth_pat_[A-Za-z0-9_-]{43}$/);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    // Never on stdout or stderr; stdout carries only the (non-secret) token ID.
    expect(created.stdout.trim()).toMatch(/^tok_/);
    expect(created.stdout + created.stderr).not.toContain(token);
    expect(created.stdout + created.stderr).not.toContain(token.slice(10));

    // The token works against a server on the same database, and is stored only as a hash.
    server = await startServer(loadConfig({ DATABASE_URL: database.url, BLOB_DIR: join(dir, "blobs"), HOST: "127.0.0.1", PORT: "0", LOG_LEVEL: "silent" }));
    const me = await fetch(`${server.url}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ id: userId, displayName: "Ada ไทย" });
    const ws = await fetch(`${server.url}/api/v1/workspaces`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await ws.json()) as { items: { exportRestricted: boolean; role: string }[] }).items[0]).toMatchObject({ exportRestricted: true, role: "owner" });
    const stored = await server.deps.db.query("SELECT * FROM access_tokens");
    expect(JSON.stringify(stored.rows)).not.toContain(token);

    // Revocation takes effect immediately.
    const tokenId = created.stdout.trim();
    expect((await cli(["revoke-token", "--token-id", tokenId])).stdout.trim()).toBe("revoked");
    expect((await fetch(`${server.url}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await cli(["revoke-token", "--token-id", tokenId])).code).toBe(1);
  });

  it("refuses to overwrite an existing --out file, and requires --out", async () => {
    const userId = (await cli(["create-user", "--name", "Bob"])).stdout.trim();
    const out = join(dir, "exists");
    await writeFile(out, "precious", { mode: 0o600 });
    const clash = await cli(["create-token", "--user", userId, "--out", out]);
    expect(clash.code).toBe(2);
    expect(await readFile(out, "utf8")).toBe("precious");
    expect((await cli(["create-token", "--user", userId])).code).toBe(2);
    expect((await cli(["create-token", "--user", "usr_nobody", "--out", join(dir, "x")])).code).toBe(2);
    await expect(stat(join(dir, "x"))).rejects.toThrow();
    expect((await cli(["create-token", "--user", userId, "--out", join(dir, "t2"), "--token", "abc"])).code).toBe(2); // tokens are never accepted as arguments
  });

  it("validates input and never prints the database URL", async () => {
    const userId = (await cli(["create-user", "--name", "Carol"])).stdout.trim();
    expect((await cli(["add-member", "--workspace", "ws_none", "--user", userId, "--role", "owner"])).code).toBe(2);
    expect((await cli(["add-member", "--workspace", "ws_none", "--user", userId, "--role", "god"])).code).toBe(2);
    expect((await cli(["create-user"])).code).toBe(2);
    expect((await cli(["nope"])).code).toBe(2);
    expect((await cli(["migrate"], {})).stderr).toContain("DATABASE_URL is required");
    const secretUrl = "postgres://admin:hunter2secret@127.0.0.1:1/none";
    const unreachable = await cli(["migrate"], { DATABASE_URL: secretUrl });
    expect(unreachable.code).not.toBe(0);
    expect(unreachable.stdout + unreachable.stderr).not.toContain("hunter2secret");
  });

  it("add-member keeps working, but never demotes a workspace's last owner (ADR-0024)", async () => {
    const owner = (await cli(["create-user", "--name", "Olga"])).stdout.trim();
    const other = (await cli(["create-user", "--name", "Otto"])).stdout.trim();
    const wsId = (await cli(["create-workspace", "--name", "Kept", "--owner", owner])).stdout.trim();
    const demote = await cli(["add-member", "--workspace", wsId, "--user", owner, "--role", "editor"]);
    expect(demote.code).toBe(2);
    expect(demote.stderr).toContain("last owner");
    expect((await cli(["add-member", "--workspace", wsId, "--user", other, "--role", "owner"])).stdout.trim()).toBe("ok");
    expect((await cli(["add-member", "--workspace", wsId, "--user", owner, "--role", "editor"])).stdout.trim()).toBe("ok");
  });

  it("the audit log records provisioning without secrets", async () => {
    const client = (await import("pg")).default;
    const c = new client.Client({ connectionString: database.url });
    await c.connect();
    const rows = (await c.query("SELECT action, detail FROM audit_events ORDER BY id")).rows;
    await c.end();
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["user.created", "workspace.created", "member.set", "token.created", "token.revoked"]));
    expect(JSON.stringify(rows)).not.toMatch(/thoth_pat_/);
  });
});
