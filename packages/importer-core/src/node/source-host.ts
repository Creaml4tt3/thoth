import { constants, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import type { RandomAccessFile, SourceDirEntry, SourceHost, TempFile } from "../ports.ts";

/** Upper bound on one positional read, so a bad caller cannot force a huge allocation. */
const MAX_READ = 64 * 1024 * 1024;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// Last-resort cleanup if the process exits without close() (SIGKILL still leaks; see implementation plan §5).
const liveTempDirs = new Set<string>();
let exitHookInstalled = false;
function trackTempDir(dir: string): void {
  liveTempDirs.add(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const d of liveTempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
}

function checkPosition(position: number, length: number): void {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) throw new RangeError("Invalid read range");
  if (length > MAX_READ) throw new RangeError(`Read of ${length} bytes exceeds the ${MAX_READ}-byte limit`);
}

/** Positional reads from one Node file handle. Every byte is read with `FileHandle.read`. */
class NodeFile implements RandomAccessFile {
  protected readonly handle: fs.FileHandle;
  private readonly onClose: (file: NodeFile) => void;
  protected openSize: number;
  private closed: Promise<void> | undefined;

  constructor(handle: fs.FileHandle, size: number, onClose: (file: NodeFile) => void) {
    this.handle = handle;
    this.openSize = size;
    this.onClose = onClose;
  }

  get size(): number {
    return this.openSize;
  }

  async read(position: number, length: number): Promise<Uint8Array> {
    checkPosition(position, length);
    if (this.closed) throw new Error("File is closed");
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(out, done, length - done, position + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return done === length ? out : out.subarray(0, done);
  }

  close(): Promise<void> {
    this.closed ??= (async () => {
      this.onClose(this);
      await this.handle.close().catch(() => undefined);
      await this.afterClose();
    })();
    return this.closed;
  }

  protected async afterClose(): Promise<void> {}
}

/** A private scratch file; its size is the high-water mark of what was written. */
class NodeTempFile extends NodeFile implements TempFile {
  private readonly path: string;

  constructor(handle: fs.FileHandle, path: string, onClose: (file: NodeFile) => void) {
    super(handle, 0, onClose);
    this.path = path;
  }

  async write(position: number, data: Uint8Array): Promise<void> {
    checkPosition(position, 0);
    let done = 0;
    while (done < data.length) {
      const { bytesWritten } = await this.handle.write(data, done, data.length - done, position + done);
      done += bytesWritten;
    }
    this.openSize = Math.max(this.openSize, position + data.length);
  }

  protected override async afterClose(): Promise<void> {
    await fs.rm(this.path, { force: true });
  }
}

/** Splits a source-relative POSIX path into on-disk segments; refuses anything that could leave the root. */
function segmentsOf(path: string): string[] {
  if (path === "") return [];
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes("\0") || (process.platform === "win32" && /[\\:]/.test(segment)))
      throw new Error(`Unsafe source path: ${path}`);
  }
  return segments;
}

function kindOf(d: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): SourceDirEntry["kind"] {
  return d.isSymbolicLink() ? "symlink" : d.isDirectory() ? "directory" : d.isFile() ? "file" : "other";
}

class NodeSourceHost implements SourceHost {
  readonly rootKind: "file" | "directory";
  readonly label: string;
  readonly location: string;
  private readonly root: string;
  private readonly tempRoot: string;
  private readonly files = new Set<NodeFile>();
  private tempDir: Promise<string> | undefined;
  private tempFiles = 0;
  private closed: Promise<void> | undefined;

  constructor(rootKind: "file" | "directory", root: string, label: string, location: string, tempRoot: string) {
    this.rootKind = rootKind;
    this.root = root;
    this.label = label;
    this.location = location;
    this.tempRoot = tempRoot;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Source host is closed");
  }

  /** Resolves a path under a directory root, refusing a symlink in any ancestor component (checked at call time). */
  private async resolveUnder(path: string): Promise<string> {
    if (this.rootKind !== "directory") throw new Error("Not a directory source");
    const segments = segmentsOf(path);
    const full = nodePath.join(this.root, ...segments);
    if (full !== this.root && !full.startsWith(this.root + nodePath.sep)) throw new Error(`Path escapes source root: ${path}`);
    let current = this.root;
    for (const segment of segments.slice(0, -1)) {
      current = nodePath.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlinked directory in source path: ${path}`);
      if (!stat.isDirectory()) throw new Error(`Not a directory in source path: ${path}`);
    }
    return full;
  }

  async list(dir: string): Promise<SourceDirEntry[]> {
    this.assertOpen();
    const full = await this.resolveUnder(dir);
    if (dir !== "" && (await fs.lstat(full)).isSymbolicLink()) throw new Error(`Symlinked directory in source path: ${dir}`);
    const result: SourceDirEntry[] = [];
    for (const d of await fs.readdir(full, { withFileTypes: true })) {
      const kind = kindOf(d);
      // lstat never follows symlinks; size is reported for regular files only.
      const size = kind === "file" ? (await fs.lstat(nodePath.join(full, d.name))).size : 0;
      result.push({ name: d.name, kind, size });
    }
    return result;
  }

  async open(path: string): Promise<RandomAccessFile> {
    this.assertOpen();
    let full: string;
    if (this.rootKind === "file") {
      if (path !== "") throw new Error("An archive source only opens the archive itself");
      full = this.root;
    } else {
      if (path === "") throw new Error("Cannot open the source folder as a file");
      full = await this.resolveUnder(path);
    }
    // O_NOFOLLOW refuses a symlinked final component; O_NONBLOCK keeps a FIFO from hanging the open.
    const handle = await fs.open(full, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`Not a regular file: ${path || this.label}`);
      const file = new NodeFile(handle, stat.size, (f) => this.files.delete(f));
      this.files.add(file);
      return file;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  /** A fresh owner-only (0700) mkdtemp directory per host, created on first use and verified private. */
  private privateDir(): Promise<string> {
    this.tempDir ??= (async () => {
      const dir = await fs.mkdtemp(nodePath.join(this.tempRoot, "thoth-import-"));
      trackTempDir(dir);
      await fs.chmod(dir, 0o700);
      const stat = await fs.lstat(dir);
      const isPrivate = process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.());
      if (!stat.isDirectory() || !isPrivate) throw new Error("Import temp directory is not private");
      return dir;
    })();
    return this.tempDir;
  }

  async createTemp(): Promise<TempFile> {
    this.assertOpen();
    const dir = await this.privateDir();
    this.assertOpen();
    const path = nodePath.join(dir, `part-${++this.tempFiles}.zip`);
    // O_EXCL|O_NOFOLLOW, 0600: nothing can be substituted, and it is only ever read back through this handle.
    const handle = await fs.open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    const file = new NodeTempFile(handle, path, (f) => this.files.delete(f));
    this.files.add(file);
    return file;
  }

  close(): Promise<void> {
    this.closed ??= (async () => {
      for (const file of [...this.files]) await file.close().catch(() => undefined);
      const dir = await this.tempDir?.catch(() => undefined);
      if (dir === undefined) return;
      await fs.rm(dir, { recursive: true, force: true });
      liveTempDirs.delete(dir);
    })();
    return this.closed;
  }
}

export interface NodeSourceHostOptions {
  /** Parent of the private temp directory used for compressed nested archives (default: `os.tmpdir()`). */
  tempRoot?: string;
}

/**
 * Node implementation of the `SourceHost` port, for tests and the CLI. Binds
 * to one chosen ZIP file or folder: the root is resolved once (symlinks in the
 * chosen path itself are followed, as when the user picks it), and every later
 * open refuses symlinks in any component, opens non-blocking and requires a
 * regular file.
 */
export async function openNodeSourceHost(location: string, options: NodeSourceHostOptions = {}): Promise<SourceHost> {
  const root = await fs.realpath(nodePath.resolve(location));
  const stat = await fs.stat(root);
  const label = nodePath.basename(location);
  const tempRoot = options.tempRoot ?? tmpdir();
  if (stat.isDirectory()) return new NodeSourceHost("directory", root, nodePath.basename(root), root, tempRoot);
  if (stat.isFile()) return new NodeSourceHost("file", root, label, location, tempRoot);
  throw new Error(`${label} is not a regular file or directory`);
}
