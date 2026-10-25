/**
 * Port adapters over a `Transport` (ADR-008). The same classes run over Tauri
 * IPC in the desktop app and over the stdio harness in tests, so the shared
 * port contract suite exercises exactly the code the app ships.
 */
import type { AgentFiles, AgentHost } from "@thoth/agent-core";
import type { RandomAccessFile, SourceDirEntry, SourceHost, TempFile } from "@thoth/importer-core";
import type { DirEntry, FileStat, SqlDriver, SqlRow, SqlValue, VaultFs } from "@thoth/local-store";
import type { Links, Platform, Servers, Updates, VaultConnection } from "./index.ts";
import type { HostErrorCode, Transport, WireRow, WireValue } from "./ipc.ts";

/** An error returned by the host, re-thrown with its `code` (e.g. "EEXIST") like a Node errno error. */
export class HostCallError extends Error {
  readonly code: HostErrorCode;

  constructor(code: HostErrorCode, message: string) {
    super(message);
    this.name = "HostCallError";
    this.code = code;
  }
}

/** True for a `{ code, message }` error object returned by a host. */
export function isHostErrorShape(value: unknown): value is { code: HostErrorCode; message: string } {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string" && typeof (value as { message?: unknown }).message === "string";
}

/** Largest single `source.file.read` the host accepts; larger port reads are split. */
export const MAX_HOST_READ = 16 * 1024 * 1024;

// ------------------------------------------------------------------ wire values

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function toWire(value: SqlValue): WireValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Uint8Array) return { $bytes: encodeBase64(value) };
  throw new TypeError("Unsupported SQL parameter type");
}

/** Integers within ±2^53 arrive as numbers (as `node:sqlite` returns them); larger ones as bigint. */
export function fromWire(value: WireValue): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if ("$bigint" in value) {
    const big = BigInt(value.$bigint);
    return big >= -SAFE && big <= SAFE ? Number(big) : big;
  }
  return decodeBase64(value.$bytes);
}

function fromWireRow(row: WireRow): SqlRow {
  const out: SqlRow = {};
  for (const [key, value] of Object.entries(row)) out[key] = fromWire(value);
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ----------------------------------------------------------------------- vault

export class RemoteVaultFs implements VaultFs {
  private readonly transport: Transport;
  private readonly vault: string;

  constructor(transport: Transport, vault: string) {
    this.transport = transport;
    this.vault = vault;
  }

  async stat(path: string): Promise<FileStat | undefined> {
    return (await this.transport.call("fs.stat", { vault: this.vault, path })) ?? undefined;
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.transport.call("fs.read", { vault: this.vault, path });
  }

  list(dir: string): Promise<DirEntry[]> {
    return this.transport.call("fs.list", { vault: this.vault, dir });
  }

  async mkdirp(dir: string): Promise<void> {
    await this.transport.call("fs.mkdirp", { vault: this.vault, dir });
  }

  async writeFile(path: string, data: Uint8Array, options: { exclusive?: boolean } = {}): Promise<void> {
    await this.transport.call("fs.write", { vault: this.vault, path, exclusive: options.exclusive ?? false }, data);
  }

  async rename(from: string, to: string, options: { noReplace?: boolean; replaceHash?: string } = {}): Promise<void> {
    await this.transport.call("fs.rename", { vault: this.vault, from, to, noReplace: options.noReplace ?? false, ...(options.replaceHash === undefined ? {} : { replaceHash: options.replaceHash }) });
  }

  async remove(path: string): Promise<void> {
    await this.transport.call("fs.remove", { vault: this.vault, path });
  }
}

/** `close()` does not close the vault; `VaultConnection.close()` does. */
export class RemoteSqlDriver implements SqlDriver {
  private readonly transport: Transport;
  private readonly vault: string;

  constructor(transport: Transport, vault: string) {
    this.transport = transport;
    this.vault = vault;
  }

  async exec(sql: string): Promise<void> {
    await this.transport.call("sql.exec", { vault: this.vault, sql });
  }

  run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    return this.transport.call("sql.run", { vault: this.vault, sql, params: params.map(toWire) });
  }

  async all<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const rows = await this.transport.call("sql.all", { vault: this.vault, sql, params: params.map(toWire) });
    return rows.map(fromWireRow) as T[];
  }

  async get<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T | undefined> {
    const row = await this.transport.call("sql.get", { vault: this.vault, sql, params: params.map(toWire) });
    return row ? (fromWireRow(row) as T) : undefined;
  }

  async close(): Promise<void> {}
}

// --------------------------------------------------------------------- sources

class RemoteFile implements RandomAccessFile {
  protected readonly transport: Transport;
  protected readonly handle: string;
  protected currentSize: number;
  private closed: Promise<void> | undefined;

  constructor(transport: Transport, handle: string, size: number) {
    this.transport = transport;
    this.handle = handle;
    this.currentSize = size;
  }

  get size(): number {
    return this.currentSize;
  }

  async read(position: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) throw new RangeError("Invalid read range");
    if (this.closed) throw new Error("File is closed");
    if (length <= MAX_HOST_READ) return this.transport.call("source.file.read", { file: this.handle, position, length });
    // Split large reads; stop at end of file like a single positional read would.
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const chunk = await this.transport.call("source.file.read", { file: this.handle, position: position + done, length: Math.min(MAX_HOST_READ, length - done) });
      out.set(chunk, done);
      done += chunk.length;
      if (chunk.length === 0) break;
    }
    return done === length ? out : out.subarray(0, done);
  }

  close(): Promise<void> {
    this.closed ??= this.transport.call("source.file.close", { file: this.handle }).then(() => undefined);
    return this.closed;
  }
}

class RemoteTempFile extends RemoteFile implements TempFile {
  async write(position: number, data: Uint8Array): Promise<void> {
    if (!Number.isSafeInteger(position) || position < 0) throw new RangeError("Invalid write position");
    await this.transport.call("source.temp.write", { file: this.handle, position }, data);
    this.currentSize = Math.max(this.currentSize, position + data.length);
  }
}

export class RemoteSourceHost implements SourceHost {
  readonly rootKind: "file" | "directory";
  readonly label: string;
  readonly location: string;
  private readonly transport: Transport;
  private readonly source: string;
  private closed: Promise<void> | undefined;

  constructor(transport: Transport, opened: { source: string; rootKind: "file" | "directory"; label: string; location: string }) {
    this.transport = transport;
    this.source = opened.source;
    this.rootKind = opened.rootKind;
    this.label = opened.label;
    this.location = opened.location;
  }

  static async open(transport: Transport, location: string): Promise<RemoteSourceHost> {
    return new RemoteSourceHost(transport, await transport.call("source.open", { location }));
  }

  list(dir: string): Promise<SourceDirEntry[]> {
    return this.transport.call("source.list", { source: this.source, dir });
  }

  async open(path: string): Promise<RandomAccessFile> {
    const { file, size } = await this.transport.call("source.file.open", { source: this.source, path });
    return new RemoteFile(this.transport, file, size);
  }

  async createTemp(): Promise<TempFile> {
    const { file } = await this.transport.call("source.temp.create", { source: this.source });
    return new RemoteTempFile(this.transport, file, 0);
  }

  close(): Promise<void> {
    this.closed ??= this.transport.call("source.close", { source: this.source }).then(() => undefined);
    return this.closed;
  }
}

// -------------------------------------------------------------------- platform

export async function openRemoteVault(transport: Transport, root: string): Promise<VaultConnection> {
  const opened = await transport.call("vault.open", { root });
  const vault = opened.vault;
  let closed: Promise<void> | undefined;
  return {
    root: opened.root,
    label: opened.label,
    shared: opened.shared === true,
    fs: new RemoteVaultFs(transport, vault),
    sql: new RemoteSqlDriver(transport, vault),
    async watch(listener) {
      const unlisten = await transport.listen("vault.changed", (event) => {
        if (event.vault === vault) listener({ paths: event.paths, rescan: event.rescan });
      });
      try {
        await transport.call("watch.start", { vault });
      } catch (error) {
        unlisten();
        throw error;
      }
      return async () => {
        unlisten();
        await transport.call("watch.stop", { vault });
      };
    },
    async reveal() {
      await transport.call("vault.reveal", { vault });
    },
    isShared: () => transport.call("vault.shared", { vault }),
    close() {
      closed ??= transport.call("vault.close", { vault }).then(() => undefined);
      return closed;
    },
  };
}

export function remoteServers(transport: Transport): Servers {
  return {
    list: () => transport.call("server.list", {}),
    add: (url) => transport.call("server.add", { url }),
    remove: async (server) => void (await transport.call("server.remove", { server })),
    signIn: (server, provider) => transport.call("server.signIn", { server, ...(provider === undefined ? {} : { provider }) }),
    cancelSignIn: async (server) => void (await transport.call("server.signInCancel", { server })),
    useToken: (server, token) => transport.call("server.useToken", { server, token }),
    signOut: (server) => transport.call("server.signOut", { server }),
    call: (args, body) => transport.call("api.call", args, body),
  };
}

/** The Agent Hub's host port over the `agent.*` commands. */
export function remoteAgents(transport: Transport): AgentHost {
  const files = (run: string): AgentFiles => ({
    stat: async (path) => (await transport.call("agent.fs.stat", { run, path })) ?? undefined,
    readFile: (path) => transport.call("agent.fs.read", { run, path }),
    list: (dir) => transport.call("agent.fs.list", { run, dir }),
    mkdirp: async (dir) => void (await transport.call("agent.fs.mkdirp", { run, dir })),
    writeFile: async (path, data, options) => void (await transport.call("agent.fs.write", { run, path, ...(options?.readOnly ? { readOnly: true } : {}) }, data)),
  });
  return {
    detect: (provider) => transport.call("agent.detect", { provider }),
    createRun: (provider) => transport.call("agent.run.create", { provider }),
    files,
    start: async (run, argv, stdin, timeoutMs) => void (await transport.call("agent.start", { run, argv, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, stdin)),
    events: (run, after, waitMs) => transport.call("agent.events", { run, after, waitMs }),
    cancel: async (run) => void (await transport.call("agent.cancel", { run })),
    dispose: async (run) => void (await transport.call("agent.run.dispose", { run })),
    sweep: async () => (await transport.call("agent.sweep", {})).removed,
    history: {
      write: async (id, name, data) => void (await transport.call("agent.history.write", { id, name }, data)),
      read: (id, name) => transport.call("agent.history.read", { id, name }),
      list: () => transport.call("agent.history.list", {}),
      delete: async (id) => void (await transport.call("agent.history.delete", { id })),
    },
  };
}

export function remoteLinks(transport: Transport): Links {
  return {
    preview: (url) => transport.call("link.preview", { url }),
    clearPreviews: async () => void (await transport.call("link.preview.clear", {})),
    open: async (url) => void (await transport.call("link.open", { url })),
  };
}

export function remoteUpdates(transport: Transport): Updates {
  return {
    check: (options) => transport.call("update.check", options?.force ? { force: true } : {}),
    settings: () => transport.call("update.settings", {}),
    setNotify: (on) => transport.call("update.settings", { notify: on }),
    skip: (version) => transport.call("update.settings", { skip: version }),
  };
}

export function createRemotePlatform(transport: Transport, kind: Platform["kind"]): Platform {
  return {
    servers: remoteServers(transport),
    agents: remoteAgents(transport),
    links: remoteLinks(transport),
    updates: remoteUpdates(transport),
    kind,
    pickVaultFolder: () => transport.call("vault.pick", {}),
    recentVaults: () => transport.call("vault.recent", {}),
    openVault: (root) => openRemoteVault(transport, root),
    pickImportSource: (sourceKind) => transport.call("source.pick", { kind: sourceKind }),
    openImportSource: (location) => RemoteSourceHost.open(transport, location),
  };
}
