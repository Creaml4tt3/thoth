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
}
