import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/config.ts";
import { createHandler, serverlessConfig } from "../src/serverless.ts";

const DB = "postgres://user:s3cretpw@localhost:5432/thoth";

describe("serverless configuration", () => {
  it("accepts the trial profile with MIGRATE_ON_START=false", () => {
    const c = serverlessConfig({ DATABASE_URL: DB, THOTH_PROFILE: "trial", MIGRATE_ON_START: "false" });
    expect(c.migrateOnStart).toBe(false);
    expect(c.capabilities).not.toContain("events.sse");
  });
  it("refuses to migrate at start or hold a LISTEN connection", () => {
    expect(() => serverlessConfig({ DATABASE_URL: DB, THOTH_PROFILE: "trial" })).toThrow(/MIGRATE_ON_START must be false/);
    expect(() => serverlessConfig({ DATABASE_URL: DB, MIGRATE_ON_START: "false" })).toThrow(/EVENTS must be off/);
    expect(() => serverlessConfig({ DATABASE_URL: DB, MIGRATE_ON_START: "false", EVENTS: "off" })).not.toThrow();
    expect(() => serverlessConfig({ DATABASE_URL: DB, THOTH_PROFILE: "trial", MIGRATE_ON_START: "false", EVENTS: "on" })).toThrow(ConfigError);
  });
});

describe("serverless handler", () => {
  it("answers 503 service_unavailable on a bad configuration, never echoes it, and tries again on the next request", async () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: DB, THOTH_PROFILE: "trial" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createHandler(env);
    const server = createServer((req, res) => void handler(req, res)).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/v1/capabilities`;
    try {
      const first = await fetch(url);
      expect(first.status).toBe(503);
      expect(first.headers.get("content-type")).toContain("application/problem+json");
      expect(first.headers.get("retry-after")).toBe("5");
      const text = await first.text();
      expect(JSON.parse(text)).toMatchObject({ code: "service_unavailable", status: 503 });
      expect(text).not.toContain("s3cretpw");
      expect(errors.mock.calls.flat().join(" ")).not.toContain("s3cretpw");
      // Fixed configuration: the next request boots again (a sleeping database must not wedge the instance).
      env.MIGRATE_ON_START = "false";
      env.RATE_LIMIT_PER_IP = "unlimited"; // the per-IP counter lives in the database; /capabilities itself needs none
      env.DATABASE_URL = "postgres://user:s3cretpw@127.0.0.1:1/thoth";
      const second = await fetch(url);
      expect(second.status).toBe(200);
      expect((await second.json()).capabilities).toEqual(["attachments", "search", "transfers", "page-order", "page-kind", "public-share", "members", "invite-links", "workspace-management"]);
    } finally {
      server.close();
      errors.mockRestore();
    }
  });
});
