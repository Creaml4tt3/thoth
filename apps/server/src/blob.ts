import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Queryable } from "./db.ts";

export interface StoredBlob {
  /** Lower-case hex SHA-256 of the bytes; the blob's address. */
  hash: string;
  size: number;
}

/** Content-addressed byte storage. Implementations must make `put` atomic and idempotent. */
export interface BlobStore {
  /** `tx`: the caller's open transaction. Stores that live in the database join it; filesystem stores ignore it. */
  put(bytes: Uint8Array, tx?: Queryable): Promise<StoredBlob>;
  /** `null` when the hash is unknown. */
  open(hash: string): Promise<{ stream: Readable; size: number } | null>;
  has(hash: string): Promise<boolean>;
  /**
   * Removes the bytes of `hash` (nothing happens when they are not stored). Only `releaseBlobs` calls this, under the
   * blob lock and after checking that no attachment row names the hash (ADR-0025: purging a workspace).
   */
  remove(hash: string, tx?: Queryable): Promise<void>;
}

/**
 * The lock that keeps a blob from being removed while an upload that reuses it is in flight. An upload holds it shared
 * (from before `put` until its attachment row commits), `releaseBlobs` holds it exclusively. Advisory-lock key space as
 * in quota.ts; nothing takes another lock after this one.
 */
export const BLOB_LOCK = "blob-gc";
export const holdBlobsShared = (tx: Queryable) => tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 1))", [BLOB_LOCK]);

/**
 * Removes the stored bytes of each hash that no attachment row names any more (after a workspace was purged). Runs in
 * its own transaction under the exclusive blob lock, so an upload of the same bytes either committed its attachment
 * row before (the blob is kept) or stores the bytes again after (the blob is written anew). Returns how many were removed.
 */
export async function releaseBlobs(db: { tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> }, blobs: BlobStore, hashes: readonly string[]): Promise<number> {
  const candidates = [...new Set(hashes)].filter((h) => HASH.test(h));
  if (candidates.length === 0) return 0;
  return db.tx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [BLOB_LOCK]);
    const { rows } = await tx.query<{ hash: string }>("SELECT h AS hash FROM unnest($1::text[]) AS h WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.hash = h)", [candidates]);
    for (const { hash } of rows) await blobs.remove(hash, tx);
    return rows.length;
  });
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * Filesystem blob store: `<dir>/<aa>/<bb>/<sha256>`. Writes go to a temporary file in the same
 * directory and are renamed into place, so readers never see partial content and a crash leaves
 * at most an unreferenced temporary file. Identical content is stored once.
 */
export class FsBlobStore implements BlobStore {
  readonly #dir: string;
  constructor(dir: string) {
    this.#dir = dir;
  }

  #pathFor(hash: string): { dir: string; file: string } {
    if (!HASH.test(hash)) throw new Error("invalid blob hash");
    const dir = join(this.#dir, hash.slice(0, 2), hash.slice(2, 4));
    return { dir, file: join(dir, hash) };
  }

  async put(bytes: Uint8Array, _tx?: Queryable): Promise<StoredBlob> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const { dir, file } = this.#pathFor(hash);
    if (await this.has(hash)) return { hash, size: bytes.length };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${hash}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await rename(temp, file);
    return { hash, size: bytes.length };
  }

  async open(hash: string): Promise<{ stream: Readable; size: number } | null> {
    const { file } = this.#pathFor(hash);
    try {
      const info = await stat(file);
      return { stream: createReadStream(file), size: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async has(hash: string): Promise<boolean> {
    try {
      await stat(this.#pathFor(hash).file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async remove(hash: string, _tx?: Queryable): Promise<void> {
    await unlink(this.#pathFor(hash).file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/**
 * PostgreSQL blob store (`BLOB_STORE=postgres`) for hosts without a persistent filesystem. Same contract as
 * the filesystem store: content-addressed by SHA-256, `put` atomic (one statement) and idempotent
 * (`ON CONFLICT DO NOTHING`), identical content stored once. Bytes are read whole, so it is meant for small
 * attachments (the trial profile caps them at 4 MiB), not for large files.
 *
 * `put` takes the caller's transaction when there is one: the blob then commits or rolls back together with
 * the attachment row (no orphans), and the upload needs no second connection from a small pool.
 */
export class PgBlobStore implements BlobStore {
  readonly #db: Queryable;
  constructor(db: Queryable) {
    this.#db = db;
  }

  async put(bytes: Uint8Array, tx?: Queryable): Promise<StoredBlob> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    await (tx ?? this.#db).query("INSERT INTO blobs (hash, size, data) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING", [hash, bytes.length, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
    return { hash, size: bytes.length };
  }

  async open(hash: string): Promise<{ stream: Readable; size: number } | null> {
    if (!HASH.test(hash)) throw new Error("invalid blob hash");
    const { rows } = await this.#db.query<{ data: Buffer; size: number }>("SELECT data, size FROM blobs WHERE hash = $1", [hash]);
    const row = rows[0];
    return row ? { stream: Readable.from([row.data]), size: row.size } : null;
  }

  async has(hash: string): Promise<boolean> {
    if (!HASH.test(hash)) throw new Error("invalid blob hash");
    return ((await this.#db.query("SELECT 1 FROM blobs WHERE hash = $1", [hash])).rowCount ?? 0) > 0;
  }

  async remove(hash: string, tx?: Queryable): Promise<void> {
    if (!HASH.test(hash)) throw new Error("invalid blob hash");
    await (tx ?? this.#db).query("DELETE FROM blobs WHERE hash = $1", [hash]);
  }
}
