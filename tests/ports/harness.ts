/**
 * Builds the `thoth-host-stdio` harness once per test file and wires port
 * factories for both runtimes: Node (`NodeVaultFs`, `NodeSqlDriver`,
 * `openNodeSourceHost`) and Rust (`Remote*` over `StdioTransport`).
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SourceHost } from "@thoth/importer-core";
import { openNodeSourceHost } from "@thoth/importer-core/node";
import type { SqlDriver, VaultFs } from "@thoth/local-store";
import { NodeSqlDriver, NodeVaultFs } from "@thoth/local-store/node";
import type { VaultConnection } from "@thoth/platform";
import { RemoteSourceHost, openRemoteVault } from "@thoth/platform/remote";
import { StdioTransport, type StdioTransportOptions } from "@thoth/platform/stdio";

export const REPO = resolve(import.meta.dirname, "../..");
const EXE = process.platform === "win32" ? ".exe" : "";
const BUILT = join(REPO, "target", "debug", `thoth-host-stdio${EXE}`);

let built: Promise<string> | undefined;

/**
 * `cargo build -p thoth-host` (incremental; slow only on the first run), then
 * copies the binary to a private path. Test files build in parallel and cargo
 * replaces `target/debug/thoth-host-stdio` while doing so, so each file spawns
 * its own copy rather than a path that can briefly disappear.
 */
export function buildHarness(): Promise<string> {
  built ??= (async () => {
    execFileSync("cargo", ["build", "-p", "thoth-host", "--bin", "thoth-host-stdio"], { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
    const dir = await mkdtemp(join(tmpdir(), "thoth-harness-bin-"));
    const binary = join(dir, `thoth-host-stdio${EXE}`);
    await copyFile(BUILT, binary);
    await chmod(binary, 0o755);
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    return binary;
  })();
  return built;
}

let mcpBuilt: Promise<string> | undefined;

/**
 * `cargo build -p thoth-mcp`, the MCP server other apps start (ADR-0021), copied to a private path as
 * `buildHarness` does.
 */
export function buildMcpServer(): Promise<string> {
  mcpBuilt ??= (async () => {
    execFileSync("cargo", ["build", "-p", "thoth-mcp"], { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
    const dir = await mkdtemp(join(tmpdir(), "thoth-mcp-bin-"));
    const binary = join(dir, `thoth-mcp${EXE}`);
    await copyFile(join(REPO, "target", "debug", `thoth-mcp${EXE}`), binary);
    await chmod(binary, 0o755);
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    return binary;
  })();
  return mcpBuilt;
}

/** A fresh canonical temp directory (macOS /var is a symlink to /private/var). */
export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export interface VaultFixture {
  root: string;
  fs: VaultFs;
  dispose(): Promise<void>;
}

export interface SqlFixture {
  sql: SqlDriver;
  dispose(): Promise<void>;
}

export interface SourceFixture {
  open(location: string): Promise<SourceHost>;
  dispose(): Promise<void>;
}

export interface PortRuntime {
  name: "node" | "rust";
  /** A VaultFs on a fresh temp root. `noHardlinks` makes `link` fail so no-replace rename takes the copy fallback. */
  vaultFs(options?: { noHardlinks?: boolean }): Promise<VaultFixture>;
  sqlDriver(): Promise<SqlFixture>;
  /** Opens import sources under `allowed` (the harness only opens allow-listed locations); temp files go under `tempRoot`. */
  sourceHost(allowed: string, tempRoot: string): Promise<SourceFixture>;
}

const hardlinkUnsupported = async () => {
  throw Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" });
};

export const nodeRuntime: PortRuntime = {
  name: "node",
  async vaultFs(options = {}) {
    const root = await tempDir("thoth-port-node-");
    const fs = new NodeVaultFs(root, options.noHardlinks ? { link: hardlinkUnsupported } : {});
    return { root, fs, dispose: () => rm(root, { recursive: true, force: true }) };
  },
  async sqlDriver() {
    const root = await tempDir("thoth-port-node-sql-");
    const sql = new NodeSqlDriver(join(root, "index.sqlite"));
    return {
      sql,
      async dispose() {
        await sql.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  },
  async sourceHost(_allowed, tempRoot) {
    return { open: (location) => openNodeSourceHost(location, { tempRoot }), dispose: async () => {} };
  },
};

/** One harness process per fixture, so env-based test hooks and allow-lists stay isolated. */
export async function rustTransport(options: Omit<StdioTransportOptions, "binary">): Promise<StdioTransport> {
  return new StdioTransport({ binary: await buildHarness(), ...options });
}

/** Opens a vault through the harness; `.thoth/` is created by the host on open. */
export async function rustVault(root: string, options: { noHardlinks?: boolean } = {}): Promise<{ connection: VaultConnection; transport: StdioTransport }> {
  const transport = await rustTransport({ allowRoots: [root], ...(options.noHardlinks ? { env: { THOTH_TEST_DISABLE_HARDLINK: "1" } } : {}) });
  return { connection: await openRemoteVault(transport, root), transport };
}

export const rustRuntime: PortRuntime = {
  name: "rust",
  async vaultFs(options = {}) {
    const root = await tempDir("thoth-port-rust-");
    const { connection, transport } = await rustVault(root, options);
    return {
      root,
      fs: connection.fs,
      async dispose() {
        await connection.close().catch(() => undefined);
        await transport.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  },
  async sqlDriver() {
    const root = await tempDir("thoth-port-rust-sql-");
    const { connection, transport } = await rustVault(root);
    return {
      sql: connection.sql,
      async dispose() {
        await connection.close().catch(() => undefined);
        await transport.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  },
  async sourceHost(allowed, tempRoot) {
    // The host's temp files go under the system temp dir, which `tempfile` takes from TMPDIR (TMP/TEMP on Windows).
    const transport = await rustTransport({ allowRoots: [allowed], env: { TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot } });
    return { open: (location) => RemoteSourceHost.open(transport, location), dispose: () => transport.close() };
  },
};

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
