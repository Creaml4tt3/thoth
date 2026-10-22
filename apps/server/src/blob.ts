import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

export interface StoredBlob {
  /** Lower-case hex SHA-256 of the bytes; the blob's address. */
  hash: string;
  size: number;
}

/** Content-addressed byte storage. Implementations must make `put` atomic and idempotent. */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<StoredBlob>;
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

  async put(bytes: Uint8Array): Promise<StoredBlob> {
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
