import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/migrate.ts";
import { startServer } from "../src/server.ts";
import { createTestDatabase, startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, createTransfer, uuid } from "./support.ts";

const run = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const num = async (env: TestEnv, sql: string, values: unknown[] = []) => Number((await env.db.query<{ n: string }>(sql, values)).rows[0]!.n);

describe("EVENTS=off", () => {
  const listeners = (env: TestEnv) => num(env, "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN%'");

  it("starts no LISTEN connection, does not advertise events.sse, and answers the route 501", async () => {
    const env = await startTestEnv({ env: { EVENTS: "off" } });
    try {
      const who = await env.user("O");
      const ws = await env.workspace("W", { members: { [who.userId]: "owner" } });
      expect(env.server.deps.hub).toBeNull();
      expect(await listeners(env)).toBe(0);
      const caps = (await env.api(null, "GET", "/capabilities")).json;
      expect(caps.capabilities).toEqual(["attachments", "search", "transfers", "page-order"]);
      const events = await env.api(who, "GET", `/workspaces/${ws}/events`);
      expect([events.status, events.json.code]).toEqual([501, "capability_not_supported"]);
      expect(events.headers.get("content-type")).toContain("application/problem+json");
      expect((await env.api(null, "GET", `/workspaces/${ws}/events`)).status).toBe(401); // authentication still comes first
      await createPage(env, who, ws); // writes work without a hub
      expect(await listeners(env)).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("control: by default a LISTEN connection exists and the route streams", async () => {
    const env = await startTestEnv();
    try {
      expect(await listeners(env)).toBe(1);
      expect((await env.api(null, "GET", "/capabilities")).json.capabilities).toContain("events.sse");
    } finally {
      await env.close();
    }
  });
});

describe("MIGRATE_ON_START=false", () => {
  it("never touches the migration lock: a server starts while another session holds it, and one that migrates would wait", async () => {
    const database = await createTestDatabase();
    const pool = new pg.Pool({ connectionString: database.url, max: 2 });
    const holder = await pool.connect();
    try {
      await migrate(pool); // the operator migrates with a direct connection beforehand
      await holder.query("SELECT pg_advisory_lock($1)", [7_424_001]); // the key migrate.ts uses
      const base = { DATABASE_URL: database.url, HOST: "127.0.0.1", PORT: "0", LOG_LEVEL: "silent", EVENTS: "off", BLOB_DIR: "/tmp/unused" };
      const started = await startServer(loadConfig({ ...base, MIGRATE_ON_START: "false" }));
      try {
        expect((await fetch(`${started.url}/api/v1/capabilities`)).status).toBe(200);
      } finally {
        await started.close();
      }
      // Control: with migration on, startup blocks on the lock.
      const blocked = startServer(loadConfig({ ...base, MIGRATE_ON_START: "true" }));
      const outcome = await Promise.race([blocked.then(() => "started"), new Promise((r) => setTimeout(() => r("waiting"), 1500))]);
      expect(outcome).toBe("waiting");
      await holder.query("SELECT pg_advisory_unlock($1)", [7_424_001]);
      await (await blocked).close();
    } finally {
      holder.release();
      await pool.end();
      await database.drop();
    }
  });
});

describe("rate limiting", () => {
  /** A fixed window must not end mid-test: wait until at least `needSeconds` remain in the current one. */
  const windowRoom = async (env: TestEnv, windowSeconds: number, needSeconds: number) => {
    const left = Number((await env.db.query<{ s: string }>("SELECT $1::int - (floor(extract(epoch FROM now()))::bigint % $1::int) AS s", [windowSeconds])).rows[0]!.s);
    if (left < needSeconds) await new Promise((r) => setTimeout(r, (left + 0.3) * 1000));
  };

  describe("per account", () => {
    let env: TestEnv;
    let a: TestPrincipal;
    let b: TestPrincipal;
    beforeAll(async () => {
      env = await startTestEnv({ env: { RATE_LIMIT_PER_ACCOUNT: "3", RATE_LIMIT_WINDOW_SECONDS: "3600" } });
      a = await env.user("A");
      b = await env.user("B");
      await windowRoom(env, 3600, 30);
    });
    afterAll(() => env.close());

    it("allows the limit, then answers 429 rate_limited with Retry-After; other accounts are unaffected", async () => {
      for (let i = 0; i < 3; i++) expect((await env.api(a, "GET", "/me")).status, `request ${i + 1}`).toBe(200);
      const limited = await env.api(a, "GET", "/me");
      expect(limited.status).toBe(429);
      expect(limited.json).toMatchObject({ code: "rate_limited", status: 429 });
      expect(limited.headers.get("content-type")).toContain("application/problem+json");
      const retry = Number(limited.headers.get("retry-after"));
      expect(Number.isInteger(retry) && retry >= 1 && retry <= 3600).toBe(true);
      expect((await env.api(a, "GET", "/me")).status).toBe(429); // still limited
      expect((await env.api(b, "GET", "/me")).status).toBe(200);
      expect((await env.api(null, "GET", "/capabilities")).status).toBe(200); // not an account-limited request
    });

    it("an unauthenticated request is 401, not counted against any account", async () => {
      expect((await env.api({ headers: { authorization: "Bearer thoth_pat_nonexistentnonexistentnonexistent00" } } as TestPrincipal, "GET", "/me")).status).toBe(401);
    });
  });

  describe("per IP and TRUST_PROXY", () => {
    it("counts the socket address; spoofed forwarding headers do not evade the limit without TRUST_PROXY", async () => {
      const env = await startTestEnv({ env: { RATE_LIMIT_PER_IP: "2", RATE_LIMIT_WINDOW_SECONDS: "3600" } });
      try {
        await windowRoom(env, 3600, 30);
        expect((await env.api(null, "GET", "/capabilities", { headers: { "x-forwarded-for": "9.9.9.1" } })).status).toBe(200);
        expect((await env.api(null, "GET", "/capabilities", { headers: { "x-forwarded-for": "9.9.9.2", "x-real-ip": "9.9.9.3" } })).status).toBe(200);
        const limited = await env.api(null, "GET", "/capabilities", { headers: { "x-forwarded-for": "9.9.9.4" } });
        expect([limited.status, limited.json.code]).toEqual([429, "rate_limited"]);
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        const keys = (await env.db.query<{ key: string }>("SELECT key FROM rate_limits")).rows.map((r) => r.key);
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^ip:(::ffff:)?127\.0\.0\.1$/);
      } finally {
        await env.close();
      }
    });

    it("with TRUST_PROXY the forwarded client address is the key, so clients behind the proxy are limited separately", async () => {
      const env = await startTestEnv({ env: { RATE_LIMIT_PER_IP: "2", RATE_LIMIT_WINDOW_SECONDS: "3600", TRUST_PROXY: "true" } });
      try {
        await windowRoom(env, 3600, 30);
        const as = (ip: string) => env.api(null, "GET", "/capabilities", { headers: { "x-forwarded-for": `1.1.1.1, ${ip}` } });
        expect((await as("8.8.8.8")).status).toBe(200);
        expect((await as("8.8.8.8")).status).toBe(200);
        expect((await as("8.8.8.8")).status).toBe(429);
        expect((await as("7.7.7.7")).status).toBe(200); // another client behind the same proxy
        expect((await env.db.query<{ key: string }>("SELECT key FROM rate_limits ORDER BY key")).rows.map((r) => r.key)).toEqual(["ip:7.7.7.7", "ip:8.8.8.8"]);
      } finally {
        await env.close();
      }
    });
  });

  it("the window resets: after Retry-After the next request is allowed again", async () => {
    const env = await startTestEnv({ env: { RATE_LIMIT_PER_ACCOUNT: "2", RATE_LIMIT_WINDOW_SECONDS: "2" } });
    try {
      const who = await env.user("W");
      let limited: Awaited<ReturnType<TestEnv["api"]>> | undefined;
      for (let i = 0; i < 12 && !limited; i++) {
        const res = await env.api(who, "GET", "/me");
        if (res.status === 429) limited = res;
      }
      expect(limited, "never rate limited").toBeDefined();
      const retry = Number(limited!.headers.get("retry-after"));
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(2);
      await new Promise((r) => setTimeout(r, retry * 1000 + 400));
      expect((await env.api(who, "GET", "/me")).status).toBe(200);
    } finally {
      await env.close();
    }
  });

  it("concurrent requests are counted exactly: with a limit of 5, 5 of 20 simultaneous requests pass", async () => {
    const env = await startTestEnv({ env: { RATE_LIMIT_PER_ACCOUNT: "5", RATE_LIMIT_WINDOW_SECONDS: "3600" } });
    try {
      const who = await env.user("C");
      await windowRoom(env, 3600, 30);
      const results = await Promise.all(Array.from({ length: 20 }, () => env.api(who, "GET", "/me")));
      expect(results.filter((r) => r.status === 200)).toHaveLength(5);
      expect(results.filter((r) => r.status === 429)).toHaveLength(15);
    } finally {
      await env.close();
    }
  });

  it("is off when unset: nothing is counted and no row is written", async () => {
    const env = await startTestEnv();
    try {
      const who = await env.user("N");
      for (let i = 0; i < 30; i++) expect((await env.api(who, "GET", "/me")).status).toBe(200);
      expect(await num(env, "SELECT count(*) AS n FROM rate_limits")).toBe(0);
    } finally {
      await env.close();
    }
  });
});

describe("CORS end to end", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  const ORIGIN = "https://app.example.org";
  beforeAll(async () => {
    env = await startTestEnv({ env: { CORS_ORIGINS: `${ORIGIN},http://localhost:5173` } });
    owner = await env.user("O");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  const preflight = (origin: string, path = `/workspaces/${ws}/pages/${uuid()}`) =>
    env.api(null, "OPTIONS", path, { headers: { origin, "access-control-request-method": "PUT", "access-control-request-headers": "authorization,if-none-match,content-type,idempotency-key" } });

  it("answers a preflight for a listed origin with 204, no authentication, and the allowed methods and headers", async () => {
    const res = await preflight(ORIGIN);
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toContain("Origin");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE");
    expect(res.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type, If-Match, If-None-Match, Idempotency-Key");
    expect((await preflight("http://localhost:5173")).headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect((await preflight(ORIGIN, "/capabilities")).status).toBe(204);
  });

  it("a preflight from an unlisted origin is answered without any Access-Control-Allow-* header", async () => {
    for (const origin of ["https://evil.example", "http://app.example.org", `${ORIGIN}:8443`]) {
      const res = await preflight(origin);
      expect(res.status, origin).toBe(204);
      expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-allow")), origin).toEqual([]);
    }
  });

  it("an actual request from a listed origin carries the origin, credentials, Vary and the exposed headers, also on errors", async () => {
    const ok = await env.api(owner, "GET", "/me", { headers: { origin: ORIGIN } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    expect(ok.headers.get("vary")).toContain("Origin");
    const exposed = ok.headers.get("access-control-expose-headers")!;
    for (const h of ["ETag", "Location", "Retry-After", "WWW-Authenticate"]) expect(exposed).toContain(h);
    const unauthenticated = await env.api(null, "GET", "/me", { headers: { origin: ORIGIN } });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("access-control-allow-origin")).toBe(ORIGIN); // the browser may read the 401
    expect(unauthenticated.headers.get("www-authenticate")).toBeTruthy();
    const missing = await env.api(owner, "GET", "/no/such/route", { headers: { origin: ORIGIN } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("an unlisted origin is still processed per normal auth but gets no CORS headers", async () => {
    const res = await env.api(owner, "GET", "/me", { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(owner.userId);
    expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    expect(res.headers.get("vary")).toContain("Origin");
    const denied = await env.api(null, "GET", "/me", { headers: { origin: "https://evil.example" } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const none = await env.api(owner, "GET", "/me"); // no Origin header at all (not a browser)
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("405 and 404 handling is unchanged: Allow is kept, an OPTIONS that is not a preflight is a 405", async () => {
    const patch = await env.api(owner, "PATCH", `/workspaces/${ws}/tree`, { headers: { origin: ORIGIN } });
    expect([patch.status, patch.json.code]).toEqual([405, "method_not_allowed"]);
    expect(patch.headers.get("allow")).toContain("GET");
    expect(patch.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const plainOptions = await env.api(owner, "OPTIONS", `/workspaces/${ws}/tree`);
    expect([plainOptions.status, plainOptions.json.code]).toEqual([405, "method_not_allowed"]);
    expect((await env.api(owner, "GET", "/nope")).json.code).toBe("not_found");
  });

  it("a real cross-origin write and read round trip works with the headers the preflight allowed", async () => {
    const id = uuid();
    const put = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${id}`, { headers: { origin: ORIGIN, "if-none-match": "*", "idempotency-key": uuid() }, json: { title: "T", markdown: "m" } });
    expect(put.status).toBe(201);
    expect(put.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(put.headers.get("etag")).toBeTruthy();
  });

  it("the event stream carries the CORS headers too", async () => {
    const controller = new AbortController();
    const res = await fetch(`${env.url}/api/v1/workspaces/${ws}/events`, { headers: { ...owner.headers, origin: ORIGIN }, signal: controller.signal });
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    } finally {
      controller.abort();
    }
  });

  it("without CORS_ORIGINS nothing is added and a preflight is an ordinary 405", async () => {
    const plain = await startTestEnv();
    try {
      const res = await plain.api(null, "OPTIONS", "/capabilities", { headers: { origin: ORIGIN, "access-control-request-method": "GET" } });
      expect(res.status).toBe(405);
      expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-") || k === "vary")).toEqual([]);
    } finally {
      await plain.close();
    }
  });
});

describe("maintenance", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  const secret = `cron-${randomBytes(18).toString("base64url")}`;
  const logLines: string[] = [];
  const logStream = { write: (line: string) => void logLines.push(line) };
  beforeAll(async () => {
    env = await startTestEnv({ startOptions: { logStream }, env: { CRON_SECRET: secret, REVISION_RETENTION_DAYS: "30" }, configure: (c) => void (c.logLevel = "trace") });
    owner = await env.user("O");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  /** Revisions are immutable by trigger; a test ages them by lifting it for one statement. */
  const backdate = (ids: string[], days: number) =>
    env.db.tx(async (tx) => {
      await tx.query("ALTER TABLE page_revisions DISABLE TRIGGER page_revisions_immutable");
      await tx.query("UPDATE page_revisions SET created_at = now() - make_interval(days => $2) WHERE id = ANY($1)", [ids, days]);
      await tx.query("ALTER TABLE page_revisions ENABLE TRIGGER page_revisions_immutable");
    });
  const edit = async (pageId: string, etag: string, n: number) => {
    const res = await env.api(owner, "PUT", `/workspaces/${ws}/pages/${pageId}`, { headers: { "if-match": `"${etag}"` }, json: { title: `v${n}`, markdown: `version ${n}` } });
    expect(res.status).toBe(200);
    return res.json.revision.id as string;
  };
  const callCron = (authorization?: string) => fetch(`${env.url}/internal/maintenance`, { headers: authorization ? { authorization } : {} }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => undefined)) as any, headers: r.headers }));

  it("prunes old non-current revisions only: the current revision survives, listing stays consistent, recent ones stay", async () => {
    const first = await createPage(env, owner, ws, { markdown: "version 1" });
    const r2 = await edit(first.id, first.revisionId, 2);
    const r3 = await edit(first.id, r2, 3);
    const r4 = await edit(first.id, r3, 4);
    const r5 = await edit(first.id, r4, 5);
    await backdate([first.revisionId, r2, r3], 40); // old, not current: prunable
    await backdate([r5], 90); // old but CURRENT: protected
    // r4 stays recent (non-current but inside the window).
    const result = await callCron(`Bearer ${secret}`);
    expect(result.status).toBe(200);
    expect(result.json.revisionsPruned).toBe(3);
    const list = await env.api(owner, "GET", `/workspaces/${ws}/pages/${first.id}/revisions`);
    expect(list.json.items.map((i: { id: string }) => i.id)).toEqual([r5, r4]);
    expect(list.json.nextCursor).toBeNull();
    expect(list.json.items[1].parentId).toBe(r3); // a retained summary never changes
    const paged = await env.api(owner, "GET", `/workspaces/${ws}/pages/${first.id}/revisions`, { query: { limit: "1" } });
    expect(paged.json.items.map((i: { id: string }) => i.id)).toEqual([r5]);
    const page2 = await env.api(owner, "GET", `/workspaces/${ws}/pages/${first.id}/revisions`, { query: { limit: "1", cursor: paged.json.nextCursor } });
    expect(page2.json.items.map((i: { id: string }) => i.id)).toEqual([r4]);
    expect(page2.json.nextCursor).toBeNull();
    const current = await env.api(owner, "GET", `/workspaces/${ws}/pages/${first.id}`);
    expect([current.status, current.json.markdown, current.json.revision.id]).toEqual([200, "version 5", r5]);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${first.id}`, { query: { revision: first.revisionId } })).status).toBe(404);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${first.id}`, { query: { revision: r4 } })).status).toBe(200);
    // The page still takes writes against its current revision.
    const next = await edit(first.id, r5, 6);
    expect((await env.api(owner, "GET", `/workspaces/${ws}/pages/${first.id}/revisions`)).json.items[0].id).toBe(next);
  });

  it("keeps the last revision of a deleted page and every revision that is current", async () => {
    const page = await createPage(env, owner, ws);
    const r2 = await edit(page.id, page.revisionId, 2);
    await env.api(owner, "DELETE", `/workspaces/${ws}/pages/${page.id}`, { headers: { "if-match": `"${r2}"` } });
    const other = await createPage(env, owner, ws);
    await backdate([page.revisionId, r2, other.revisionId], 400);
    await callCron(`Bearer ${secret}`);
    const rows = (await env.db.query<{ id: string }>("SELECT id FROM page_revisions WHERE id = ANY($1)", [[page.revisionId, r2, other.revisionId]])).rows.map((r) => r.id).sort();
    expect(rows).toEqual([r2, other.revisionId].sort());
  });

  it("keeps a revision a live transfer still pins, and prunes it once the transfer is terminal", async () => {
    const page = await createPage(env, owner, ws);
    const operationId = uuid();
    const created = await createTransfer(env, owner, ws, { operationId, direction: "from_workspace", mode: "copy", pages: [{ pageId: page.id }] });
    expect(created.status).toBe(201);
    await edit(page.id, page.revisionId, 2); // the pinned revision is no longer current
    await backdate([page.revisionId], 100);
    await callCron(`Bearer ${secret}`);
    expect(await num(env, "SELECT count(*) AS n FROM page_revisions WHERE id = $1", [page.revisionId])).toBe(1); // pinned by a staged transfer
    const abort = await env.api(owner, "POST", `/transfers/${operationId}/abort`);
    expect(abort.status).toBe(200);
    await callCron(`Bearer ${secret}`);
    expect(await num(env, "SELECT count(*) AS n FROM page_revisions WHERE id = $1", [page.revisionId])).toBe(0);
  });

  it("immutability holds outside pruning: DELETE needs the transaction-local setting, UPDATE is never allowed", async () => {
    const page = await createPage(env, owner, ws);
    await expect(env.db.query("DELETE FROM page_revisions WHERE id = $1", [page.revisionId])).rejects.toThrow(/immutable/);
    await expect(env.db.query("UPDATE page_revisions SET markdown = 'x' WHERE id = $1", [page.revisionId])).rejects.toThrow(/immutable/);
    await expect(
      env.db.tx(async (tx) => {
        await tx.query("SELECT set_config('thoth.pruning', 'on', true)");
        await tx.query("UPDATE page_revisions SET markdown = 'x' WHERE id = $1", [page.revisionId]); // not even while pruning
      }),
    ).rejects.toThrow(/immutable/);
    await env.db.tx(async (tx) => {
      await tx.query("SELECT set_config('thoth.pruning', 'on', true)");
    });
    // The setting is transaction-local: it did not leak to the next transaction on the pooled connection.
    await expect(env.db.query("DELETE FROM page_revisions WHERE id = $1", [page.revisionId])).rejects.toThrow(/immutable/);
    expect(await num(env, "SELECT count(*) AS n FROM page_revisions WHERE id = $1", [page.revisionId])).toBe(1);
  });

  it("deletes expired idempotency records and rate-limit rows, and keeps live ones", async () => {
    await env.db.query("INSERT INTO idempotency_records (principal_id, key, fingerprint, status, headers, created_at) VALUES ('p', 'old', 'f', 200, '{}', now() - interval '2 days'), ('p', 'new', 'f', 200, '{}', now())");
    await env.db.query("INSERT INTO rate_limits (key, window_start, count, expires_at) VALUES ('ip:old', 1, 5, now() - interval '1 minute'), ('ip:live', 2, 5, now() + interval '1 hour')");
    const result = (await callCron(`Bearer ${secret}`)).json;
    expect(result.idempotencyRecordsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.rateLimitRowsDeleted).toBeGreaterThanOrEqual(1);
    expect((await env.db.query<{ key: string }>("SELECT key FROM idempotency_records WHERE principal_id = 'p'")).rows.map((r) => r.key)).toEqual(["new"]);
    expect((await env.db.query<{ key: string }>("SELECT key FROM rate_limits WHERE key LIKE 'ip:%'")).rows.map((r) => r.key)).toEqual(["ip:live"]);
  });

  it("the endpoint requires the exact bearer secret; the secret never appears in logs or responses", async () => {
    const responses: string[] = [];
    for (const header of [undefined, "Bearer wrong-secret-value-0123456789", `Bearer ${secret}x`, `Basic ${secret}`, secret, `Bearer ${secret.slice(0, -1)}`]) {
      const res = await callCron(header);
      expect([res.status, res.json?.code], String(header)).toEqual([401, "unauthenticated"]);
      expect(res.headers.get("www-authenticate")).toBeTruthy();
      responses.push(JSON.stringify(res.json));
    }
    const ok = await callCron(`Bearer ${secret}`);
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.json).sort()).toEqual(["idempotencyRecordsDeleted", "rateLimitRowsDeleted", "revisionsPruned", "signInRowsDeleted"]);
    expect((await fetch(`${env.url}/internal/maintenance`, { method: "POST", headers: { authorization: `Bearer ${secret}` } })).status).toBe(405);
    await env.restart({ logStream }); // startup logs too
    responses.push(JSON.stringify(await callCron(`Bearer ${secret}`)));
    env.server.app.log.info({ cronSecret: secret, config: { cronSecret: secret } }, "probe"); // even if a handler logged it
    expect(logLines.length).toBeGreaterThan(5);
    expect([...logLines, ...responses].join("\n")).not.toContain(secret);
    expect(JSON.stringify(env.config)).toContain("cronSecret"); // the config holds it, which is why it is redacted in logs
  });

  it("is disabled (404, like any unknown route) when CRON_SECRET is unset, even with a header", async () => {
    const plain = await startTestEnv();
    try {
      for (const headers of [{}, { authorization: `Bearer ${secret}` }]) {
        const res = await fetch(`${plain.url}/internal/maintenance`, { headers });
        expect(res.status).toBe(404);
        expect(((await res.json()) as { code: string }).code).toBe("not_found");
      }
    } finally {
      await plain.close();
    }
  });

  it("without REVISION_RETENTION_DAYS nothing is pruned", async () => {
    const plain = await startTestEnv({ env: { CRON_SECRET: secret } });
    try {
      const who = await plain.user("P");
      const w = await plain.workspace("W", { members: { [who.userId]: "owner" } });
      const page = await createPage(plain, who, w);
      const put = await plain.api(who, "PUT", `/workspaces/${w}/pages/${page.id}`, { headers: { "if-match": `"${page.revisionId}"` }, json: { title: "2", markdown: "2" } });
      expect(put.status).toBe(200);
      await plain.db.tx(async (tx) => {
        await tx.query("ALTER TABLE page_revisions DISABLE TRIGGER page_revisions_immutable");
        await tx.query("UPDATE page_revisions SET created_at = now() - interval '900 days'");
        await tx.query("ALTER TABLE page_revisions ENABLE TRIGGER page_revisions_immutable");
      });
      const res = await fetch(`${plain.url}/internal/maintenance`, { headers: { authorization: `Bearer ${secret}` } });
      expect((await res.json()) as { revisionsPruned: number }).toMatchObject({ revisionsPruned: 0 });
      expect(await num(plain, "SELECT count(*) AS n FROM page_revisions")).toBe(2);
    } finally {
      await plain.close();
    }
  });
});

describe("CLI", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv();
  });
  afterAll(() => env.close());
  const cli = async (args: string[], extra: Record<string, string> = {}) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", DATABASE_URL: env.databaseUrl, ...extra } });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };

  it("`maintenance` prunes with the configured retention and prints counts", async () => {
    const who = await env.user("M");
    const w = await env.workspace("W", { members: { [who.userId]: "owner" } });
    const page = await createPage(env, who, w);
    expect((await env.api(who, "PUT", `/workspaces/${w}/pages/${page.id}`, { headers: { "if-match": `"${page.revisionId}"` }, json: { title: "2", markdown: "2" } })).status).toBe(200);
    await env.db.tx(async (tx) => {
      await tx.query("ALTER TABLE page_revisions DISABLE TRIGGER page_revisions_immutable");
      await tx.query("UPDATE page_revisions SET created_at = now() - interval '60 days' WHERE id = $1", [page.revisionId]);
      await tx.query("ALTER TABLE page_revisions ENABLE TRIGGER page_revisions_immutable");
    });
    const none = await cli(["maintenance"]);
    expect(none.code).toBe(0);
    expect(JSON.parse(none.stdout).revisionsPruned).toBe(0); // no retention configured
    const pruned = await cli(["maintenance"], { REVISION_RETENTION_DAYS: "30" });
    expect(pruned.code).toBe(0);
    expect(JSON.parse(pruned.stdout)).toMatchObject({ revisionsPruned: 1 });
  });

  it("create-user honours MAX_ACCOUNTS; create-workspace --owner honours the per-account workspace limit (exit 2, nothing leaked)", async () => {
    const users = await num(env, "SELECT count(*) AS n FROM users");
    const full = await cli(["create-user", "--name", "Late"], { MAX_ACCOUNTS: String(users) });
    expect(full.code).toBe(2);
    expect(full.stderr).toMatch(/full/);
    expect(await num(env, "SELECT count(*) AS n FROM users")).toBe(users);
    const ok = await cli(["create-user", "--name", "Early"], { MAX_ACCOUNTS: String(users + 1) });
    expect(ok.code).toBe(0);
    const userId = ok.stdout.trim();
    const first = await cli(["create-workspace", "--name", "One", "--owner", userId], { THOTH_PROFILE: "trial" });
    expect(first.code).toBe(0);
    const second = await cli(["create-workspace", "--name", "Two", "--owner", userId], { THOTH_PROFILE: "trial" });
    expect(second.code).toBe(2);
    expect(second.stderr).toMatch(/at most 1 workspace/);
    expect(await num(env, "SELECT count(*) AS n FROM workspaces WHERE name IN ('One','Two')")).toBe(1);
    const wsId = first.stdout.trim();
    const member = async (n: number) => {
      const u = (await cli(["create-user", "--name", `m${n}`])).stdout.trim();
      return cli(["add-member", "--workspace", wsId, "--user", u, "--role", "viewer"], { MAX_MEMBERS_PER_WORKSPACE: "2" });
    };
    expect((await member(1)).code).toBe(0); // owner + 1 = 2 = limit
    const over = await member(2);
    expect(over.code).toBe(2);
    expect(over.stderr).toMatch(/limited to 2 members/);
  });
});
