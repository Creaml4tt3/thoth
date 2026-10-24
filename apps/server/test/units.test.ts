import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TOKEN_PREFIX, bearerToken, generateToken, hashToken } from "../src/auth.ts";
import { FsBlobStore } from "../src/blob.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { decodeCursor, decodeIntCursor, encodeCursor } from "../src/cursor.ts";
import { ApiError, problemReply } from "../src/errors.ts";
import { fingerprintOf, isStorable } from "../src/idempotency.ts";
import { checkStorableText } from "../src/pages.ts";

describe("cursors", () => {
  it("round-trip, use only URL-unreserved characters and bind to a kind and a scope", () => {
    const c = encodeCursor("c", "ws_a", "42");
    expect(c).toMatch(/^[A-Za-z0-9_.~-]+$/);
    expect(decodeIntCursor("c", "ws_a", c)).toBe(42);
    expect(() => decodeCursor("t", "ws_a", c)).toThrow(ApiError);
    expect(() => decodeCursor("c", "ws_b", c)).toThrow(/not issued/);
  });
  it("reject garbage as cursor_invalid", () => {
    for (const bad of ["", "zz-not-a-cursor-1", "c", "c!!!", `c${Buffer.from("no-separator").toString("base64url")}`, "c" + "A".repeat(3000)]) {
      expect(() => decodeCursor("c", "ws", bad), bad.slice(0, 20)).toThrowError(expect.objectContaining({ code: "cursor_invalid" }));
    }
    expect(() => decodeIntCursor("c", "ws", encodeCursor("c", "ws", "-1"))).toThrow(ApiError);
    expect(() => decodeIntCursor("c", "ws", encodeCursor("c", "ws", "1e9"))).toThrow(ApiError);
  });
});

describe("tokens", () => {
  it("are 256-bit URL-safe secrets, hashed with SHA-256", () => {
    const t = generateToken();
    expect(t).toMatch(new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(generateToken()).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toContain(t.slice(12));
  });
  it("are read only from a well-formed Authorization: Bearer header", () => {
    const t = generateToken();
    expect(bearerToken({ authorization: `Bearer ${t}` })).toBe(t);
    expect(bearerToken({ authorization: `bearer ${t}` })).toBe(t);
    for (const bad of [undefined, "", "Bearer", "Bearer ", `Basic ${t}`, `Bearer ${t} extra`, "Bearer short", ["Bearer a", "Bearer b"]]) {
      expect(bearerToken({ authorization: bad as string | undefined })).toBeNull();
    }
    expect(bearerToken({})).toBeNull();
  });
});

describe("idempotency fingerprint", () => {
  const base = { method: "PUT", target: "/api/v1/workspaces/w/pages/p", ifMatch: undefined, ifNoneMatch: "*", body: Buffer.from('{"a":1}') };
  it("covers method, target, If-Match, If-None-Match and the body bytes", () => {
    const f = fingerprintOf(base);
    expect(fingerprintOf({ ...base })).toBe(f);
    for (const change of [{ method: "DELETE" }, { target: "/api/v1/workspaces/w/pages/q" }, { ifMatch: '"x"' }, { ifNoneMatch: undefined }, { body: Buffer.from('{"a":2}') }, { body: Buffer.from('{"a": 1}') }]) {
      expect(fingerprintOf({ ...base, ...change }), JSON.stringify(change)).not.toBe(f);
    }
  });
  it("stores 2xx and request-specific 4xx, never 401, 429 or 5xx", () => {
    for (const s of [200, 201, 204, 400, 404, 412, 422, 428]) expect(isStorable(s), String(s)).toBe(true);
    for (const s of [401, 429, 500, 503]) expect(isStorable(s), String(s)).toBe(false);
  });
});

describe("problems", () => {
  it("use the registry status, problem+json, and WWW-Authenticate on 401", () => {
    const r = problemReply(new ApiError("unauthenticated", "no"));
    expect(r.status).toBe(401);
    expect(r.headers["content-type"]).toBe("application/problem+json");
    expect(r.headers["www-authenticate"]).toBe('Bearer realm="thoth"');
    expect(JSON.parse(String(r.body))).toMatchObject({ code: "unauthenticated", status: 401 });
    const c = problemReply(new ApiError("revision_conflict", "x", { currentRevision: { id: "r" } }));
    expect(JSON.parse(String(c.body)).currentRevision).toEqual({ id: "r" });
    expect(problemReply(new ApiError("rate_limited", "x")).headers["retry-after"]).toBe("1");
  });
});

describe("storable text", () => {
  it("rejects NUL and lone surrogates, accepts Thai, emoji and CRLF", () => {
    expect(() => checkStorableText("a\u0000", "/x")).toThrow(ApiError);
    expect(() => checkStorableText("\ud800", "/x")).toThrow(ApiError);
    expect(() => checkStorableText("สวัสดี 🌿\r\n", "/x")).not.toThrow();
  });
});

describe("config", () => {
  it("requires DATABASE_URL and never echoes it", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: "mysql://u:secretpw@h/db" })).toThrowError(expect.not.objectContaining({ message: expect.stringContaining("secretpw") }));
  });
  it("reads HOST, PORT, BLOB_DIR and limits with sane defaults and range checks", () => {
    const c = loadConfig({ DATABASE_URL: "postgres://u:p@h/db" });
    expect(c).toMatchObject({ host: "127.0.0.1", port: 8080, blobDir: "./data/blobs", capabilities: ["attachments", "search", "events.sse", "transfers", "page-order"] });
    expect(loadConfig({ DATABASE_URL: "postgres://u:p@h/db", HOST: "0.0.0.0", PORT: "9000", BLOB_DIR: "/b" })).toMatchObject({ host: "0.0.0.0", port: 9000, blobDir: "/b" });
    expect(() => loadConfig({ DATABASE_URL: "postgres://u:p@h/db", PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: "postgres://u:p@h/db", MAX_MARKDOWN_BYTES: "10" })).toThrow(ConfigError);
  });
});

describe("filesystem blob store", () => {
  let dir: string | undefined;
  afterAll(async () => dir && rm(dir, { recursive: true, force: true }));
  it("is content-addressed, idempotent, atomic and leaves no temporary files", async () => {
    dir = await mkdtemp(join(tmpdir(), "thoth-blob-unit-"));
    const store = new FsBlobStore(dir);
    const a = await store.put(Buffer.from("hello"));
    expect(a.hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(await store.has(a.hash)).toBe(true);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => store.put(Buffer.from("same bytes"))));
    expect(new Set(concurrent.map((b) => b.hash)).size).toBe(1);
    const opened = await store.open(a.hash);
    const chunks: Buffer[] = [];
    for await (const chunk of opened!.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    expect(opened!.size).toBe(5);
    expect(await store.open("0".repeat(64))).toBeNull();
    await expect(store.open("../../etc/passwd")).rejects.toThrow(/invalid blob hash/);
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) e.isDirectory() ? await walk(join(d, e.name)) : files.push(join(d, e.name));
    };
    await walk(dir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(files).toHaveLength(2);
    expect((await stat(files[0]!)).mode & 0o777).toBe(0o600);
  });
});
