import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/auth.ts";
import { startTestEnv, type TestEnv, type TestPrincipal } from "./helpers.ts";
import { createPage, openEvents, uuid } from "./support.ts";

/** Nothing secret may reach the log or a response body, and the token is never stored. */
describe("secrets", () => {
  let env: TestEnv;
  let owner: TestPrincipal;
  let ws: string;
  const logLines: string[] = [];
  const logStream = { write: (line: string) => void logLines.push(line) };

  beforeAll(async () => {
    env = await startTestEnv({ startOptions: { logStream }, configure: (c) => void (c.logLevel = "trace") });
    owner = await env.user("Owner");
    ws = await env.workspace("W", { members: { [owner.userId]: "owner" } });
  });
  afterAll(() => env.close());

  it("never logs or returns a token, an Authorization header, or the database URL", async () => {
    const bad = "thoth_pat_thisisadeliberatelywrongtoken0123456789";
    const responses: string[] = [];
    const record = async (p: Promise<{ text: string; headers: Headers }>) => {
      const r = await p;
      responses.push(r.text, JSON.stringify([...r.headers.entries()]));
    };
    await record(env.api(owner, "GET", "/me"));
    await record(env.api({ headers: { authorization: `Bearer ${bad}` } } as TestPrincipal, "GET", "/me"));
    await record(env.api({ headers: { authorization: `Bearer ${bad}` } } as TestPrincipal, "PUT", `/workspaces/${ws}/pages/${uuid()}`, { json: { title: "x" } }));
    await record(env.api(owner, "PUT", `/workspaces/${ws}/pages/${uuid()}`, { headers: { "if-none-match": "*", "idempotency-key": "secretish-key-123" }, json: { title: "" } }));
    await record(env.api(owner, "GET", `/workspaces/${ws}/changes`, { query: { cursor: "garbage" } }));
    await record(env.api(owner, "POST", `/workspaces/${ws}/attachments`, { headers: { "content-type": "bad type" }, body: "x" }));
    await createPage(env, owner, ws);
    const stream = await openEvents(env, owner, ws);
    await stream.until((e) => e.length > 0, 500);
    stream.close();
    // A restart logs the startup path too (database connection, migrations, listener).
    await env.restart({ logStream });

    expect(logLines.length).toBeGreaterThan(10);
    const everything = [...logLines, ...responses].join("\n");
    for (const secret of [owner.token, bad, env.databaseUrl, new URL(env.databaseUrl).password]) {
      expect(everything, `leaked ${secret.slice(0, 8)}...`).not.toContain(secret);
    }
    expect(everything).not.toMatch(/thoth_pat_[A-Za-z0-9_-]{20,}/);
    expect(everything.toLowerCase()).not.toMatch(/"authorization":"bearer/);
    expect(everything).not.toContain("secretish-key-123");
  });

  it("redacts credentials even if a handler ever passed them to the logger", async () => {
    const before = logLines.length;
    const log = env.server.app.log;
    log.info({ headers: { authorization: "Bearer thoth_pat_zzzzzzzzzzzzzzzzzzzzzzzzzzzz" } }, "probe-1");
    log.info({ authorization: "Bearer thoth_pat_yyyyyyyyyyyyyyyyyyyyyyyyyyyy" }, "probe-2");
    log.info({ token: "thoth_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx" }, "probe-3");
    log.info({ config: { databaseUrl: "postgres://u:hunter2@h/db" } }, "probe-4");
    const written = logLines.slice(before).join("");
    for (const secret of ["thoth_pat_zzzz", "thoth_pat_yyyy", "thoth_pat_xxxx", "hunter2"]) expect(written).not.toContain(secret);
    expect(written.match(/\[redacted\]/g)?.length).toBe(4);
  });

  it("the request logger records method and path but never headers or query strings", async () => {
    const before = logLines.length;
    await env.api(owner, "GET", "/me", { headers: { "x-probe": "1" } });
    await env.api(owner, "GET", `/workspaces/${ws}/changes`, { query: { cursor: "c-secret-looking-cursor" } });
    const written = logLines.slice(before).join("");
    expect(written).toContain('"method":"GET"');
    expect(written).toContain("/api/v1/me");
    expect(written).not.toContain("c-secret-looking-cursor");
    expect(written).not.toMatch(/"headers"/);
  });

  it("stores only a SHA-256 of each token", async () => {
    const rows = (await env.db.query<{ token_hash: string }>("SELECT token_hash FROM access_tokens")).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.map((r) => r.token_hash)).toContain(hashToken(owner.token));
    const dump = JSON.stringify((await env.db.query("SELECT * FROM access_tokens")).rows) + JSON.stringify((await env.db.query("SELECT * FROM audit_events")).rows);
    expect(dump).not.toContain(owner.token);
  });
});
