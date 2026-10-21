import type { EntryKind } from "@thoth/local-store";
import type { RandomAccessFile, SourceDirEntry, SourceHost, TempFile } from "@thoth/importer-core";

/**
 * In-memory `SourceHost` and `RandomAccessFile` fakes that use no Node APIs,
 * to prove the portable sources need nothing but the port. The file fake
 * records every read so tests can assert that none falls outside the file.
 */
export class MemoryFile implements RandomAccessFile {
  readonly data: Uint8Array;
  readonly reads: { position: number; length: number }[] = [];
  /** Reads that touched bytes outside [windowStart, windowEnd), or used a negative / non-integer position. */
  outOfRange = 0;
  closed = false;
  private readonly windowStart: number;
  private readonly windowEnd: number;

  /** `window` is the only part of the file a reader may touch (default: all of it). */
  constructor(data: Uint8Array, window: { start: number; end: number } = { start: 0, end: data.length }) {
    this.data = data;
    this.windowStart = window.start;
    this.windowEnd = window.end;
  }

  get size(): number {
    return this.data.length;
  }

  async read(position: number, length: number): Promise<Uint8Array> {
    if (this.closed) throw new Error("read after close");
    this.reads.push({ position, length });
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || length < 0 || position < this.windowStart || position + length > this.windowEnd) this.outOfRange++;
    // Copy, as a real host would: callers must not be able to see or change the backing bytes.
    return this.data.slice(Math.max(0, position), Math.max(0, position) + Math.max(0, length));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class MemoryTempFile implements TempFile {
  private bytes = new Uint8Array(0);
  closed = false;

  get size(): number {
    return this.bytes.length;
  }

  async read(position: number, length: number): Promise<Uint8Array> {
    if (this.closed) throw new Error("read after close");
    return this.bytes.slice(position, position + length);
  }

  async write(position: number, data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("write after close");
    const end = position + data.length;
    if (end > this.bytes.length) {
      const grown = new Uint8Array(Math.max(end, this.bytes.length * 2));
      grown.set(this.bytes);
      this.bytes = grown.subarray(0, end);
    }
    this.bytes.set(data, position);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A file tree: a string or bytes is a regular file, an object is a directory, a `{ kind }` marker is anything else. */
export type MemoryTree = { [name: string]: MemoryTree | Uint8Array | string | { kind: Exclude<EntryKind, "file" | "directory"> } };

export class MemoryHost implements SourceHost {
  readonly rootKind: "file" | "directory";
  readonly label: string;
  readonly location: string;
  readonly opened: MemoryFile[] = [];
  readonly temps: MemoryTempFile[] = [];
  closeCount = 0;
  private readonly archive: Uint8Array | undefined;
  private readonly tree: MemoryTree | undefined;

  private constructor(rootKind: "file" | "directory", label: string, archive: Uint8Array | undefined, tree: MemoryTree | undefined) {
    this.rootKind = rootKind;
    this.label = label;
    this.location = `memory:${label}`;
    this.archive = archive;
    this.tree = tree;
  }

  static file(label: string, bytes: Uint8Array): MemoryHost {
    return new MemoryHost("file", label, bytes, undefined);
  }

  static directory(label: string, tree: MemoryTree): MemoryHost {
    return new MemoryHost("directory", label, undefined, tree);
  }

  get closed(): boolean {
    return this.closeCount > 0;
  }

  private node(path: string): MemoryTree[string] | MemoryTree {
    let node: MemoryTree[string] | MemoryTree = this.tree!;
    for (const segment of path === "" ? [] : path.split("/")) {
      if (typeof node !== "object" || node instanceof Uint8Array || "kind" in node) throw new Error(`Not a directory: ${path}`);
      const child: MemoryTree[string] | undefined = (node as MemoryTree)[segment];
      if (child === undefined) throw new Error(`No such file: ${path}`);
      node = child;
    }
    return node;
  }

  async list(dir: string): Promise<SourceDirEntry[]> {
    if (this.closed) throw new Error("host closed");
    if (this.rootKind !== "directory") throw new Error("not a directory host");
    const node = this.node(dir);
    if (typeof node !== "object" || node instanceof Uint8Array || "kind" in node) throw new Error(`Not a directory: ${dir}`);
    return Object.entries(node as MemoryTree).map(([name, child]) => {
      if (typeof child === "string") return { name, kind: "file" as const, size: new TextEncoder().encode(child).length };
      if (child instanceof Uint8Array) return { name, kind: "file" as const, size: child.length };
      if ("kind" in child && typeof child.kind === "string") return { name, kind: child.kind as EntryKind, size: 0 };
      return { name, kind: "directory" as const, size: 0 };
    });
  }

  async open(path: string): Promise<RandomAccessFile> {
    if (this.closed) throw new Error("host closed");
    let bytes: Uint8Array;
    if (this.rootKind === "file") {
      if (path !== "") throw new Error("archive host only opens the archive");
      bytes = this.archive!;
    } else {
      const node = this.node(path);
      if (typeof node === "string") bytes = new TextEncoder().encode(node);
      else if (node instanceof Uint8Array) bytes = node;
      else throw new Error(`Not a regular file: ${path}`);
    }
    const file = new MemoryFile(bytes);
    this.opened.push(file);
    return file;
  }

  async createTemp(): Promise<TempFile> {
    if (this.closed) throw new Error("host closed");
    const temp = new MemoryTempFile();
    this.temps.push(temp);
    return temp;
  }

  async close(): Promise<void> {
    this.closeCount++;
    for (const f of this.opened) await f.close();
    for (const t of this.temps) await t.close();
  }
}
