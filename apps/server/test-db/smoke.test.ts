import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestEnv, type TestEnv } from "./helpers.ts";

describe("smoke", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv();
  });
  afterAll(() => env.close());

  it("serves capabilities and rejects anonymous callers", async () => {
    const caps = await env.api(null, "GET", "/capabilities");
    expect(caps.status).toBe(200);
    expect(caps.json.capabilities).toEqual(["attachments", "search", "events.sse", "transfers"]);
    const me = await env.api(null, "GET", "/me");
    expect(me.status).toBe(401);
    expect(me.headers.get("www-authenticate")).toBe('Bearer realm="thoth"');
  });
});
