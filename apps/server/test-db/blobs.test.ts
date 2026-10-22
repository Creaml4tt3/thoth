import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsBlobStore, PgBlobStore, type BlobStore } from "../src/blob.ts";
import { createDatabase, type Database } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { createTestDatabase } from "./helpers.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const read = async (stream: AsyncIterable<Buffer>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// The same behaviours, run against both implementations of the BlobStore interface.
describe.each(["fs", "postgres"] as const)("BlobStore (%s)", (kind) => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let db: Database;
  let dir: string;
  let store: BlobStore;
  beforeAll(async () => {
    database = await createTestDatabase();
    db = createDatabase(database.url, { max: 8 });
    await migrate(db.pool);
    dir = await mkdtemp(join(tmpdir(), "thoth-blobs-test-"));
    store = kind === "fs" ? new FsBlobStore(dir) : new PgBlobStore(db);
  });
  afterAll(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
    await database.drop();
  });

  it("put returns the SHA-256 and size; open returns the exact bytes; has reflects it", async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 250, 255, 10, 13, 0]);
    expect(await store.has(sha(bytes))).toBe(false);
    expect(await store.open(sha(bytes))).toBeNull();
    expect(await store.put(bytes)).toEqual({ hash: sha(bytes), size: bytes.length });
    expect(await store.has(sha(bytes))).toBe(true);
    const opened = (await store.open(sha(bytes)))!;
    expect(opened.size).toBe(bytes.length);
    expect((await read(opened.stream)).equals(bytes)).toBe(true);
  });

  it("is idempotent: putting identical bytes again stores them once and changes nothing", async () => {
    const bytes = Buffer.from("identical content ไทย");
    const first = await store.put(bytes);
    const second = await store.put(Buffer.from(bytes));
    expect(second).toEqual(first);
    if (kind === "postgres") expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM blobs WHERE hash = $1", [first.hash])).rows[0]!.n)).toBe(1);
    expect((await read((await store.open(first.hash))!.stream)).equals(bytes)).toBe(true);
  });

  it("concurrent identical puts all succeed and leave exactly one intact blob", async () => {
    const bytes = Buffer.alloc(200_000, 42);
    const results = await Promise.all(Array.from({ length: 12 }, () => store.put(bytes)));
    for (const r of results) expect(r).toEqual({ hash: sha(bytes), size: bytes.length });
    expect((await read((await store.open(sha(bytes)))!.stream)).equals(bytes)).toBe(true);
    if (kind === "postgres") expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM blobs WHERE hash = $1", [sha(bytes)])).rows[0]!.n)).toBe(1);
  });

  it("handles an empty-ish and a multi-megabyte blob", async () => {
    const one = Buffer.from([7]);
    const big = Buffer.alloc(4 * 1_048_576, 3);
    await store.put(one);
    await store.put(big);
    expect((await read((await store.open(sha(one)))!.stream)).equals(one)).toBe(true);
    expect((await read((await store.open(sha(big)))!.stream)).equals(big)).toBe(true);
  });

  it("rejects an invalid hash instead of touching storage", async () => {
    for (const bad of ["", "abc", "../../etc/passwd", "g".repeat(64), "A".repeat(64)]) {
      await expect(store.open(bad), bad).rejects.toThrow(/invalid blob hash/);
      await expect(store.has(bad), bad).rejects.toThrow(/invalid blob hash/);
    }
  });
});

describe("PgBlobStore inside the caller's transaction", () => {
  it("a rolled-back upload leaves no blob behind", async () => {
    const database = await createTestDatabase();
    const db = createDatabase(database.url, { max: 3 });
    try {
      await migrate(db.pool);
      const store = new PgBlobStore(db);
      const bytes = Buffer.from("never committed");
      await db.tx(async (tx) => {
        await store.put(bytes, tx);
        throw new Error("rollback");
      }).catch(() => undefined);
      expect(await store.has(sha(bytes))).toBe(false);
      await db.tx((tx) => store.put(bytes, tx));
      expect(await store.has(sha(bytes))).toBe(true);
      await expect(db.query("UPDATE blobs SET size = size + 1 WHERE hash = $1", [sha(bytes)])).rejects.toThrow(); // CHECK(octet_length = size)
    } finally {
      await db.close();
      await database.drop();
    }
  });
});
