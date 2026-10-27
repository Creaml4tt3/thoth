/**
 * Feedback (ADR-0033, capability `feedback`) against the real server and PostgreSQL: validation, the account of a valid
 * credential, the honeypot, the rate limits per client address and per account, CORS, the website's no-JavaScript
 * form, and that nothing is stored for a refused request.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEEDBACK_LIMITS } from "../src/feedback.ts";
import { startTestEnv, type TestEnv } from "./helpers.ts";

const SITE = "https://site.thoth.test";
const WEB = "https://app.thoth.test";

const count = async (env: TestEnv): Promise<number> => Number((await env.db.query<{ n: string }>("SELECT count(*) AS n FROM feedback")).rows[0]!.n);
/** Each test sends from its own client address (TRUST_PROXY), so the per-address limits do not leak between tests. */
let n = 0;
const from = (): Record<string, string> => ({ "x-real-ip": `198.51.100.${++n}` });

describe("feedback (ADR-0033)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv({ env: { CORS_ORIGINS: `${SITE},${WEB}`, TRUST_PROXY: "true" } });
  });
  afterAll(async () => {
    await env?.close();
  });

  it("is listed in /capabilities and can be switched off (501, nothing stored)", async () => {
    expect((await env.api(null, "GET", "/capabilities")).json.capabilities).toContain("feedback");
    const off = await startTestEnv({ env: { FEEDBACK: "off" } });
    try {
      expect((await off.api(null, "GET", "/capabilities")).json.capabilities).not.toContain("feedback");
      const res = await off.api(null, "POST", "/feedback", { json: { kind: "idea", message: "hi" } });
      expect(res.status).toBe(501);
      expect(res.json.code).toBe("capability_not_supported");
      expect(await count(off)).toBe(0);
    } finally {
      await off.close();
    }
  });

  it("stores a valid message without sign-in: kind, message, email, context and a salted address hash, never the address", async () => {
    const headers = from();
    const before = await count(env);
    const res = await env.api(null, "POST", "/feedback", { headers, json: { kind: "problem", message: "The sidebar froze.", email: "ada@example.org", context: { client: "desktop", version: "0.4.0", os: "macOS", language: "th" } } });
    expect(res.status).toBe(204);
    expect(await count(env)).toBe(before + 1);
    const { rows } = await env.db.query("SELECT * FROM feedback ORDER BY created_at DESC, id DESC LIMIT 1");
    const row = rows[0]!;
    expect(row).toMatchObject({ kind: "problem", message: "The sidebar froze.", email: "ada@example.org", context: { client: "desktop", version: "0.4.0", os: "macOS", language: "th" }, account_id: null });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(headers["x-real-ip"]);
    // Salted: not the plain SHA-256 of the address.
    const { createHash } = await import("node:crypto");
    expect(row.ip_hash).not.toBe(createHash("sha256").update(headers["x-real-ip"]!).digest("hex"));
  });

  it("keeps the account of a valid credential, and ignores an invalid one (never 401)", async () => {
    const ada = await env.user("Ada");
    expect((await env.api(ada, "POST", "/feedback", { headers: from(), json: { kind: "idea", message: "Tags, please." } })).status).toBe(204);
    const mine = await env.db.query("SELECT account_id FROM feedback WHERE message = 'Tags, please.'");
    expect(mine.rows).toEqual([{ account_id: ada.userId }]);
    const bogus = await env.api(null, "POST", "/feedback", { headers: { ...from(), authorization: "Bearer thoth_pat_not-a-real-token-at-all" }, json: { kind: "question", message: "Who am I?" } });
    expect(bogus.status).toBe(204);
    expect((await env.db.query("SELECT account_id FROM feedback WHERE message = 'Who am I?'")).rows).toEqual([{ account_id: null }]);
  });

  it("refuses invalid bodies with 400 validation_failed naming the field, and stores nothing", async () => {
    const before = await count(env);
    const bad: [unknown, string][] = [
      [{ kind: "bug", message: "x" }, "/kind"],
      [{ kind: "idea", message: "" }, "/message"],
      [{ kind: "idea", message: "   " }, "/message"],
      [{ kind: "idea", message: "x".repeat(5001) }, "/message"],
      [{ kind: "idea", message: "x", email: "nope" }, "/email"],
      [{ kind: "idea", message: "x", context: { client: "desktop", os: "x".repeat(61) } }, "/context/os"],
      [{ kind: "idea", message: "x", pageTitle: "Secret plan" }, "/"],
      [{ kind: "idea", message: "x", context: { client: "desktop", file: "Notes/Plan.md" } }, "/context"],
    ];
    for (const [json, pointer] of bad) {
      const res = await env.api(null, "POST", "/feedback", { headers: from(), json });
      expect(res.status, JSON.stringify(json).slice(0, 60)).toBe(400);
      expect(res.json.code).toBe("validation_failed");
      expect(res.json.errors.map((e: { pointer: string }) => e.pointer), JSON.stringify(json).slice(0, 60)).toContain(pointer);
    }
    expect((await env.api(null, "POST", "/feedback", { headers: { ...from(), "content-type": "application/json" }, body: "{not json" })).status).toBe(400);
    expect((await env.api(null, "POST", "/feedback", { headers: { ...from(), "content-type": "text/plain" }, body: "hello" })).status).toBe(415);
    expect(await count(env)).toBe(before);
  });

  it("answers a filled-in honeypot like a success and stores nothing", async () => {
    const before = await count(env);
    const res = await env.api(null, "POST", "/feedback", { headers: from(), json: { kind: "idea", message: "Buy pills", website: "https://spam.example" } });
    expect(res.status).toBe(204);
    expect(await count(env)).toBe(before);
  });

  it(`limits one address to ${FEEDBACK_LIMITS.short.limit} per ${FEEDBACK_LIMITS.short.windowSeconds / 60} minutes: 429 with Retry-After, nothing stored`, async () => {
    const headers = from();
    for (let i = 0; i < FEEDBACK_LIMITS.short.limit; i++) expect((await env.api(null, "POST", "/feedback", { headers, json: { kind: "idea", message: `ok ${i}` } })).status).toBe(204);
    const before = await count(env);
    const refused = await env.api(null, "POST", "/feedback", { headers, json: { kind: "idea", message: "one too many" } });
    expect(refused.status).toBe(429);
    expect(refused.json.code).toBe("rate_limited");
    const retry = Number(refused.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(FEEDBACK_LIMITS.short.windowSeconds);
    expect(await count(env)).toBe(before);
    // Another address is not affected.
    expect((await env.api(null, "POST", "/feedback", { headers: from(), json: { kind: "idea", message: "someone else" } })).status).toBe(204);
  });

  it("limits one account across addresses, and has a daily limit too", async () => {
    const grace = await env.user("Grace");
    for (let i = 0; i < FEEDBACK_LIMITS.short.limit; i++) expect((await env.api(grace, "POST", "/feedback", { headers: from(), json: { kind: "idea", message: `g ${i}` } })).status).toBe(204);
    expect((await env.api(grace, "POST", "/feedback", { headers: from(), json: { kind: "idea", message: "g again" } })).status).toBe(429);
    // The daily window: counters past the daily limit refuse even when the short window has room.
    const ip = from();
    const { rows } = await env.db.query<{ salt: string }>("SELECT ip_salt AS salt FROM feedback_settings");
    expect(rows).toHaveLength(1);
    const { feedbackIpHash } = await import("../src/feedback.ts");
    const hash = await feedbackIpHash(env.db, ip["x-real-ip"]!);
    await env.db.query(
      `INSERT INTO rate_limits (key, window_start, count, expires_at) VALUES ($1, floor(extract(epoch FROM now()) / $2)::bigint, $3, now() + interval '1 day')`,
      [`feedback-ip-day:${hash}`, FEEDBACK_LIMITS.day.windowSeconds, FEEDBACK_LIMITS.day.limit],
    );
    const daily = await env.api(null, "POST", "/feedback", { headers: ip, json: { kind: "idea", message: "day" } });
    expect(daily.status).toBe(429);
    expect(Number(daily.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("answers CORS for the allowed site and web origins only, also on the preflight", async () => {
    for (const origin of [SITE, WEB]) {
      const pre = await fetch(`${env.url}/api/v1/feedback`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type, authorization" } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe(origin);
      expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
      const res = await env.api(null, "POST", "/feedback", { headers: { ...from(), origin }, json: { kind: "question", message: `from ${origin}` } });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
    const evil = await env.api(null, "POST", "/feedback", { headers: { ...from(), origin: "https://evil.example" }, json: { kind: "question", message: "evil" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  describe("the website's form without JavaScript", () => {
    const post = (form: Record<string, string>, headers: Record<string, string>) =>
      fetch(`${env.url}/api/v1/feedback`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form).toString() });

    it("stores it and answers a thank-you page in the form's language, with a link back to the support page", async () => {
      const res = await post({ kind: "idea", message: "Form idea", email: "", client: "site", language: "th", return: "/th/support/" }, { ...from(), origin: SITE });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await res.text();
      expect(html).toContain('lang="th"');
      expect(html).toContain(`href="${SITE}/th/support/"`);
      expect(html).toContain('role="status"');
      expect((await env.db.query("SELECT email, context FROM feedback WHERE message = 'Form idea'")).rows).toEqual([{ email: null, context: { client: "site", language: "th" } }]);
    });

    it("refuses a form from an origin the server does not allow, and an invalid one with an HTML page; nothing stored", async () => {
      const before = await count(env);
      const evil = await post({ kind: "idea", message: "x", client: "site" }, { ...from(), origin: "https://evil.example" });
      expect(evil.status).toBe(403);
      expect((await post({ kind: "idea", message: "x", client: "site" }, from())).status).toBe(403);
      const invalid = await post({ kind: "idea", message: "", client: "site", language: "en", return: "/support/" }, { ...from(), origin: SITE });
      expect(invalid.status).toBe(400);
      const html = await invalid.text();
      expect(html).toContain('role="alert"');
      expect(html).toContain(`href="${SITE}/support/"`);
      // A return address must be a path on the allowed origin, never another site.
      const sneaky = await post({ kind: "idea", message: "sneaky", client: "site", return: "//evil.example/x" }, { ...from(), origin: SITE });
      expect(sneaky.status).toBe(200);
      expect(await sneaky.text()).not.toContain("evil.example");
      expect(await count(env)).toBe(before + 1);
    });

    it("treats a filled-in honeypot like a success and stores nothing", async () => {
      const before = await count(env);
      const res = await post({ kind: "idea", message: "spam", client: "site", website: "http://spam.example" }, { ...from(), origin: SITE });
      expect(res.status).toBe(200);
      expect(await count(env)).toBe(before);
    });
  });
});
