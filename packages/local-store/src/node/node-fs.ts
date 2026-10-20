import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { normalizeVaultPath, UnsafePathError } from "@thoth/domain";
import type { DirEntry, EntryKind, FileStat, VaultFs } from "../ports.ts";

function kindOf(s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryKind {
  if (s.isSymbolicLink()) return "symlink";
  if (s.isFile()) return "file";
  if (s.isDirectory()) return "directory";
  return "other";
}

/**
 * Node implementation of VaultFs rooted at an absolute directory.
 * Symlinks are reported, never followed, and never traversed for writes.
 */
export class NodeVaultFs implements VaultFs {
  readonly root: string;
  private readonly link: (from: string, to: string) => Promise<void>;

  /** `link` is injectable so tests can simulate filesystems without hardlinks. */
  constructor(root: string, options: { link?: (from: string, to: string) => Promise<void> } = {}) {
    this.root = nodePath.resolve(root);
    this.link = options.link ?? fs.link;
  }

  /** Absolute path for a vault path; "" means the root. */
  abs(path: string): string {
    if (path === "") return this.root;
    const rel = normalizeVaultPath(path);
    const full = nodePath.join(this.root, ...rel.split("/"));
    if (!full.startsWith(this.root + nodePath.sep)) throw new UnsafePathError(path, "escapes vault root");
    return full;
  }

  /** Refuses to operate through a symlinked ancestor directory. */
  private async assertNoSymlinkAncestors(path: string): Promise<void> {
    const segments = normalizeVaultPath(path).split("/");
    let current = this.root;
    for (const segment of segments.slice(0, -1)) {
      current = nodePath.join(current, segment);
      const s = await fs.lstat(current).catch(() => undefined);
      if (!s) return;
      if (s.isSymbolicLink()) throw new UnsafePathError(path, "symlinked directory in path");
    }
  }

  async stat(path: string): Promise<FileStat | undefined> {
    if (path !== "") await this.assertNoSymlinkAncestors(path);
    const s = await fs.lstat(this.abs(path)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return undefined;
      throw e;
    });
    return s ? { kind: kindOf(s), size: s.size, mtimeMs: s.mtimeMs } : undefined;
  }

  async readFile(path: string): Promise<Uint8Array> {
    await this.assertNoSymlinkAncestors(path);
    const handle = await fs.open(this.abs(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  async list(dir: string): Promise<DirEntry[]> {
    const entries = await fs.readdir(this.abs(dir), { withFileTypes: true });
    return entries.map((e) => ({ name: e.name.normalize("NFC"), kind: kindOf(e) }));
  }

  async mkdirp(dir: string): Promise<void> {
    if (dir === "") return;
    await this.assertNoSymlinkAncestors(`${dir}/x`);
    await fs.mkdir(this.abs(dir), { recursive: true });
  }

  async writeFile(path: string, data: Uint8Array, options: { exclusive?: boolean } = {}): Promise<void> {
    await this.assertNoSymlinkAncestors(path);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (options.exclusive ? constants.O_EXCL : constants.O_TRUNC);
    const handle = await fs.open(this.abs(path), flags, 0o644);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async rename(from: string, to: string, options: { noReplace?: boolean } = {}): Promise<void> {
    await this.assertNoSymlinkAncestors(from);
    await this.assertNoSymlinkAncestors(to);
    if (options.noReplace) {
      // link() fails with EEXIST if the target exists, giving an atomic no-replace rename.
      // Filesystems without hardlinks (exFAT, FAT, some SMB mounts) fall back to an
      // exclusive copy, which also fails with EEXIST rather than replacing.
      try {
        await this.link(this.abs(from), this.abs(to));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV" && code !== "ENOSYS") throw error;
        await fs.copyFile(this.abs(from), this.abs(to), constants.COPYFILE_EXCL);
      }
      await fs.unlink(this.abs(from));
    } else {
      await fs.rename(this.abs(from), this.abs(to));
    }
    const dir = nodePath.dirname(this.abs(to));
    const handle = await fs.open(dir, constants.O_RDONLY).catch(() => undefined);
    if (handle) {
      await handle.sync().catch(() => undefined);
      await handle.close();
    }
  }

  async remove(path: string): Promise<void> {
    await this.assertNoSymlinkAncestors(path);
    await fs.rm(this.abs(path), { force: true, recursive: true });
  }
}
