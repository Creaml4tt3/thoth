/**
 * Rust host security controls that have no Node counterpart: the allow-list,
 * handle isolation, SQL sandboxing, request limits and the watcher.
 */
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRemotePlatform, openRemoteVault, RemoteSourceHost } from "@thoth/platform/remote";
import type { StdioTransport } from "@thoth/platform/stdio";
import { buildHarness, rustTransport, tempDir } from "./harness.ts";

const text = (s: string) => new TextEncoder().encode(s);

beforeAll(() => buildHarness(), 600_000);

let base: string;
let transports: StdioTransport[] = [];

async function transport(options: Parameters<typeof rustTransport>[0]): Promise<StdioTransport> {
  const t = await rustTransport(options);
  transports.push(t);
  return t;
}

beforeEach(async () => {
  base = await tempDir("thoth-host-");
});
afterEach(async () => {
  for (const t of transports) await t.close();
  transports = [];
  await rm(base, { recursive: true, force: true });
});

describe("allow-list", () => {
  it("refuses to open a root the user did not pick", async () => {
    const picked = join(base, "picked");
    const other = join(base, "other");
    await mkdir(picked);
    await mkdir(other);
    const t = await transport({ pickVault: picked, dataDir: join(base, "data") });
    const platform = createRemotePlatform(t, "bridge");
    await expect(platform.openVault(other)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(platform.openVault(picked)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    expect(await platform.pickVaultFolder()).toBe(picked);
    const vault = await platform.openVault(picked);
    expect(vault.label).toBe("picked");
    await vault.close();
    await expect(platform.openImportSource(other)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("reveals an open vault's own folder, by handle, and nothing after it is closed", async () => {
    const picked = join(base, "picked");
    await mkdir(picked);
    const revealed: unknown[] = [];
    const t = await transport({ pickVault: picked, dataDir: join(base, "data"), onHostEvent: (event, payload) => event === "vault.revealed" && revealed.push(payload) });
    const platform = createRemotePlatform(t, "bridge");
    await platform.pickVaultFolder();
    const vault = await platform.openVault(picked);
    await vault.reveal!();
    expect(revealed).toEqual([{ root: vault.root }]);
    await expect(t.call("vault.reveal", { vault: picked })).rejects.toMatchObject({ code: "BAD_HANDLE" });
    await vault.close();
    await expect(vault.reveal!()).rejects.toMatchObject({ code: "BAD_HANDLE" });
    expect(revealed).toHaveLength(1);
  });

  it("opens an import source only after source.pick returned it", async () => {
    const archive = join(base, "export.zip");
    await writeFile(archive, "zip");
    const platform = createRemotePlatform(await transport({ pickSource: archive }), "bridge");
    await expect(platform.openImportSource(archive)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    expect(await platform.pickImportSource("file")).toBe(archive);
    const source = await platform.openImportSource(archive);
    expect(source.rootKind).toBe("file");
    await source.close();
  });

  it("reopens roots from the host's own recent list, persisted in the data dir", async () => {
    const picked = join(base, "picked");
    await mkdir(picked);
    const dataDir = join(base, "data");
    const first = createRemotePlatform(await transport({ pickVault: picked, dataDir }), "bridge");
    await first.pickVaultFolder();
    await (await first.openVault(picked)).close();
    expect(await first.recentVaults()).toEqual([picked]);
    // A new process with no pick can reopen it from the recent list, and nothing else.
    const second = createRemotePlatform(await transport({ dataDir }), "bridge");
    expect(await second.recentVaults()).toEqual([picked]);
    await (await second.openVault(picked)).close();
    await expect(second.openVault(base)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("refuses the filesystem root, home and system directories even when allow-listed", async () => {
    const windows = process.platform === "win32";
    const t = await transport({ allowRoots: [windows ? "C:\\" : "/"] });
    const roots = windows ? ["C:\\", process.env.USERPROFILE!, "C:\\Windows", "C:\\Program Files", "C:\\Users"] : ["/", process.env.HOME!, "/usr", "/System", "/etc"];
    for (const root of roots) {
      await expect(openRemoteVault(t, root), root).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    }
    await expect(openRemoteVault(t, "relative/path")).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
  });

  it("canonicalizes a picked root reached through a symlink", async () => {
    const real = join(base, "real");
    await mkdir(real);
    await symlink(real, join(base, "alias"));
    const t = await transport({ pickVault: join(base, "alias") });
    const platform = createRemotePlatform(t, "bridge");
    expect(await platform.pickVaultFolder()).toBe(real);
    const vault = await platform.openVault(join(base, "alias"));
    expect(vault.root).toBe(real);
    await vault.close();
  });
});

describe("handles", () => {
  it("a handle from vault A cannot reach vault B, and closed handles are dead", async () => {
    const a = join(base, "a");
    const b = join(base, "b");
    await mkdir(a);
    await mkdir(b);
    await writeFile(join(b, "secret.md"), "secret");
    const t = await transport({ allowRoots: [a, b] });
    const va = await openRemoteVault(t, a);
    const vb = await openRemoteVault(t, b);
    expect(await va.fs.stat("secret.md")).toBeUndefined();
    await expect(va.fs.readFile("secret.md")).rejects.toMatchObject({ code: "ENOENT" });
    await va.fs.writeFile("mine.md", text("a"));
    expect(await vb.fs.stat("mine.md")).toBeUndefined();
    await vb.close();
    await expect(vb.fs.readFile("secret.md")).rejects.toMatchObject({ code: "BAD_HANDLE" });
    await expect(t.call("fs.stat", { vault: "vault_00000000000000000000000000000000", path: "x" })).rejects.toMatchObject({ code: "BAD_HANDLE" });
    await va.close();
  });

  it("source handles, file handles and vault handles cannot be swapped", async () => {
    const vaultRoot = join(base, "v");
    await mkdir(vaultRoot);
    await writeFile(join(base, "a.zip"), "zip-a");
    await writeFile(join(base, "b.zip"), "zip-b");
    const t = await transport({ allowRoots: [base] });
    const vault = await t.call("vault.open", { root: vaultRoot });
    const a = await t.call("source.open", { location: join(base, "a.zip") });
    const b = await t.call("source.open", { location: join(base, "b.zip") });
    const fileA = await t.call("source.file.open", { source: a.source, path: "" });
    // A file handle is not a source handle, nor a vault handle, and vice versa.
    await expect(t.call("source.list", { source: fileA.file, dir: "" })).rejects.toMatchObject({ code: "BAD_HANDLE" });
    await expect(t.call("fs.stat", { vault: a.source, path: "x" })).rejects.toMatchObject({ code: "BAD_HANDLE" });
    await expect(t.call("source.file.read", { file: vault.vault, position: 0, length: 1 })).rejects.toMatchObject({ code: "BAD_HANDLE" });
    // Closing source A kills its files but not B.
    await t.call("source.close", { source: a.source });
    await expect(t.call("source.file.read", { file: fileA.file, position: 0, length: 5 })).rejects.toMatchObject({ code: "BAD_HANDLE" });
    const fileB = await t.call("source.file.open", { source: b.source, path: "" });
    expect(new TextDecoder().decode(await t.call("source.file.read", { file: fileB.file, position: 0, length: 5 }))).toBe("zip-b");
    await t.call("source.close", { source: a.source });
  });
});

describe("SQL sandbox", () => {
  it("refuses ATTACH, VACUUM INTO, load_extension and file-naming pragmas", async () => {
    const root = join(base, "v");
    await mkdir(root);
    const t = await transport({ allowRoots: [root] });
    const vault = await openRemoteVault(t, root);
    const other = join(base, "other.sqlite");
    await expect(vault.sql.exec(`ATTACH DATABASE '${other}' AS o`)).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    await expect(vault.sql.exec(`VACUUM INTO '${join(base, "copy.sqlite")}'`)).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    await expect(vault.sql.get("SELECT load_extension('/usr/lib/libz.dylib')")).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    await expect(vault.sql.exec("PRAGMA writable_schema = ON")).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    await expect(vault.sql.exec("PRAGMA journal_mode = DELETE")).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    await expect(vault.sql.exec("CREATE VIRTUAL TABLE r USING rtree(id, a, b)")).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    await expect(stat(other)).rejects.toThrow();
    await expect(stat(join(base, "copy.sqlite"))).rejects.toThrow();
    expect(await vault.sql.get("SELECT 1 AS ok")).toEqual({ ok: 1 });
    await vault.close();
  });

  it("maps errors to SQLITE_* codes and integers beyond 2^53 to bigint", async () => {
    const root = join(base, "v");
    await mkdir(root);
    const vault = await openRemoteVault(await transport({ allowRoots: [root] }), root);
    await vault.sql.exec("CREATE TABLE u (k TEXT UNIQUE)");
    await vault.sql.run("INSERT INTO u VALUES ('a')");
    await expect(vault.sql.run("INSERT INTO u VALUES ('a')")).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT" });
    await expect(vault.sql.exec("SELEC")).rejects.toMatchObject({ code: "SQLITE_ERROR" });
    expect(await vault.sql.get("SELECT 9007199254740993 AS big, -9223372036854775808 AS lo, ? AS echo", [123456789012345678901n % 9223372036854775807n])).toEqual({
      big: 9007199254740993n,
      lo: -9223372036854775808n,
      echo: 123456789012345678901n % 9223372036854775807n,
    });
    await vault.close();
  });

  it("protects the live index files from the file API", async () => {
    const root = join(base, "v");
    await mkdir(root);
    const vault = await openRemoteVault(await transport({ allowRoots: [root] }), root);
    await expect(vault.fs.writeFile(".thoth/index.sqlite", text("junk"))).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(vault.fs.remove(".thoth/index.sqlite-wal")).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(vault.fs.remove(".thoth")).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(vault.fs.rename(".thoth/index.sqlite", "stolen.sqlite")).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    // Other .thoth files remain writable (Vault keeps config and journals there).
    await vault.fs.writeFile(".thoth/config.json", text("{}"));
    await vault.close();
  });

  it("refuses an index database that is a symlink", async () => {
    const root = join(base, "v");
    await mkdir(join(root, ".thoth"), { recursive: true });
    await writeFile(join(base, "elsewhere.sqlite"), "");
    await symlink(join(base, "elsewhere.sqlite"), join(root, ".thoth", "index.sqlite"));
    await expect(openRemoteVault(await transport({ allowRoots: [root] }), root)).rejects.toMatchObject({ code: "SQLITE_ERROR" });
  });

  it("refuses a .thoth directory that is a symlink", async () => {
    const root = join(base, "v");
    await mkdir(root);
    await mkdir(join(base, "elsewhere"));
    await symlink(join(base, "elsewhere"), join(root, ".thoth"));
    await expect(openRemoteVault(await transport({ allowRoots: [root] }), root)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(stat(join(base, "elsewhere", "index.sqlite"))).rejects.toThrow();
  });
});

describe("limits", () => {
  it("bounds source reads at 16 MiB and rejects bad arguments", async () => {
    await writeFile(join(base, "a.zip"), "zip");
    const t = await transport({ allowRoots: [base] });
    const { source } = await t.call("source.open", { location: join(base, "a.zip") });
    const { file } = await t.call("source.file.open", { source, path: "" });
    await expect(t.call("source.file.read", { file, position: 0, length: 16 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
    await expect(t.call("source.file.read", { file, position: -1, length: 1 })).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
    await expect(t.call("source.file.read", { file, position: 2 ** 60, length: 1 })).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
    await expect(t.call("fs.stat", { vault: 42 } as never)).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
    await expect(t.call("nope" as never, {} as never)).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
    // The adapter splits a large port read into host-sized calls.
    const host = await RemoteSourceHost.open(t, join(base, "a.zip"));
    const whole = await (await host.open("")).read(0, 32 * 1024 * 1024);
    expect(new TextDecoder().decode(whole)).toBe("zip");
    await host.close();
  });

  it("refuses request bytes on commands that take none", async () => {
    const root = join(base, "v");
    await mkdir(root);
    const t = await transport({ allowRoots: [root] });
    const { vault } = await t.call("vault.open", { root });
    await expect(t.call("fs.stat", { vault, path: "x" }, text("x"))).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
    await expect(t.call("fs.write", { vault, path: "x", exclusive: false })).rejects.toMatchObject({ code: "BAD_ARGUMENT" });
  });
});

describe("watcher", () => {
  it("emits vault-relative paths after an external write and excludes .thoth/", async () => {
    const root = join(base, "v");
    await mkdir(root);
    const t = await transport({ allowRoots: [root] });
    const vault = await openRemoteVault(t, root);
    const events: { paths: string[]; rescan: boolean }[] = [];
    const stop = await vault.watch((e) => events.push(e));
    // FSEvents may deliver the watch's own startup; let it settle.
    await new Promise((r) => setTimeout(r, 300));
    events.length = 0;
    await mkdir(join(root, "Notes"));
    await writeFile(join(root, "Notes", "new.md"), "# New\n");
    await writeFile(join(root, ".thoth", "scratch.json"), "{}");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !events.some((e) => e.paths.includes("Notes/new.md") || e.rescan)) await new Promise((r) => setTimeout(r, 50));
    const paths = events.flatMap((e) => e.paths);
    expect(paths.includes("Notes/new.md") || events.some((e) => e.rescan)).toBe(true);
    expect(paths.filter((p) => p.startsWith(".thoth"))).toEqual([]);
    expect(paths.every((p) => !p.startsWith("/"))).toBe(true);
    await stop();
    events.length = 0;
    await writeFile(join(root, "after-stop.md"), "x");
    await new Promise((r) => setTimeout(r, 600));
    expect(events.flatMap((e) => e.paths)).not.toContain("after-stop.md");
    expect(await readFile(join(root, "Notes", "new.md"), "utf8")).toBe("# New\n");
    await vault.close();
  });
});
