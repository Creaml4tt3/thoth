/**
 * Shared port contract (ADR-008): every `VaultFs`, `SqlDriver` and
 * `SourceHost` implementation must pass these, so the Rust host gives the same
 * guarantees as the Node reference implementations.
 */
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import type { PortRuntime, SourceFixture, SqlFixture, VaultFixture } from "./harness.ts";
import { tempDir } from "./harness.ts";

const text = (s: string) => new TextEncoder().encode(s);
/** Windows has no FIFOs and no mode bits; those checks run on macOS and Linux only. */
const WINDOWS = process.platform === "win32";
// Known gap (case- and normalization-sensitive file systems, i.e. Linux): see the tests marked with it.
const onLinux = (process.platform === "linux" ? it.fails : it) as typeof it;
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

export function vaultFsContract(runtime: PortRuntime): void {
  describe(`VaultFs contract (${runtime.name})`, () => {
    let fx: VaultFixture;
    let outside: string;

    beforeEach(async () => {
      fx = await runtime.vaultFs();
      outside = await tempDir("thoth-port-outside-");
      await writeFile(join(outside, "secret.md"), "secret");
    });
    afterEach(async () => {
      await fx.dispose();
      await rm(outside, { recursive: true, force: true });
    });

    it("writes, fsyncs and reads bytes, creating and truncating", async () => {
      await fx.fs.mkdirp("a/b");
      await fx.fs.writeFile("a/b/n.md", text("hello world"));
      await fx.fs.writeFile("a/b/n.md", text("hi"));
      expect(decode(await fx.fs.readFile("a/b/n.md"))).toBe("hi");
      expect(await readFile(join(fx.root, "a/b/n.md"), "utf8")).toBe("hi");
      await fx.fs.writeFile("empty.bin", new Uint8Array());
      expect((await fx.fs.readFile("empty.bin")).length).toBe(0);
      const binary = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
      await fx.fs.writeFile("bin.dat", binary);
      expect(await fx.fs.readFile("bin.dat")).toEqual(binary);
    });

    it("refuses paths that escape the vault", async () => {
      for (const bad of ["../escape.md", "a/../../escape.md", "/etc/passwd", "a\\b.md", "C:x.md", "a\0b.md"]) {
        await expect(fx.fs.writeFile(bad, text("x")), bad).rejects.toThrow(/Unsafe path/);
        await expect(fx.fs.readFile(bad), bad).rejects.toThrow(/Unsafe path/);
        await expect(fx.fs.stat(bad), bad).rejects.toThrow(/Unsafe path/);
        await expect(fx.fs.remove(bad), bad).rejects.toThrow(/Unsafe path/);
      }
      await expect(fx.fs.list("..")).rejects.toThrow(/Unsafe path/);
      await expect(fx.fs.mkdirp("../x")).rejects.toThrow(/Unsafe path/);
      await expect(fx.fs.rename("../secret.md", "x.md")).rejects.toThrow(/Unsafe path/);
    });

    it("refuses to operate through a symlinked ancestor directory", async () => {
      await symlink(outside, join(fx.root, "linked"));
      await expect(fx.fs.writeFile("linked/x.md", text("x"))).rejects.toThrow(/symlink/);
      await expect(fx.fs.readFile("linked/secret.md")).rejects.toThrow(/symlink/);
      await expect(fx.fs.stat("linked/secret.md")).rejects.toThrow(/symlink/);
      await expect(fx.fs.mkdirp("linked/sub")).rejects.toThrow(/symlink/);
      await expect(fx.fs.remove("linked/secret.md")).rejects.toThrow(/symlink/);
      await expect(fx.fs.rename("linked/secret.md", "stolen.md")).rejects.toThrow(/symlink/);
      await mkdir(join(fx.root, "real"));
      await writeFile(join(fx.root, "real/x.md"), "x");
      await expect(fx.fs.rename("real/x.md", "linked/x.md")).rejects.toThrow(/symlink/);
      expect(await readdir(outside)).toEqual(["secret.md"]);
    });

    it("never follows a symlink in the final component (O_NOFOLLOW)", async () => {
      await symlink(join(outside, "secret.md"), join(fx.root, "link.md"));
      await expect(fx.fs.readFile("link.md")).rejects.toMatchObject({ code: expect.stringMatching(/ELOOP|EMLINK|EIO|NOT_A_REGULAR_FILE/) });
      await expect(fx.fs.writeFile("link.md", text("pwned"))).rejects.toThrow();
      expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("secret");
      expect(await fx.fs.stat("link.md")).toMatchObject({ kind: "symlink" });
    });

    it("exclusive create fails with EEXIST and leaves the file intact", async () => {
      await fx.fs.writeFile("x.md", text("first"), { exclusive: true });
      await expect(fx.fs.writeFile("x.md", text("second"), { exclusive: true })).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(join(fx.root, "x.md"), "utf8")).toBe("first");
    });

    it("renames, replacing by default and refusing with noReplace", async () => {
      await fx.fs.writeFile("a.tmp", text("A"));
      await fx.fs.writeFile("b.md", text("B"));
      await fx.fs.rename("a.tmp", "b.md");
      expect(await readFile(join(fx.root, "b.md"), "utf8")).toBe("A");
      await fx.fs.writeFile("c.tmp", text("C"));
      await expect(fx.fs.rename("c.tmp", "b.md", { noReplace: true })).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(join(fx.root, "b.md"), "utf8")).toBe("A");
      await fx.fs.mkdirp("d");
      await fx.fs.rename("c.tmp", "d/c.md", { noReplace: true });
      expect(await readFile(join(fx.root, "d/c.md"), "utf8")).toBe("C");
      expect(await fx.fs.stat("c.tmp")).toBeUndefined();
      await expect(fx.fs.rename("missing.md", "z.md")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("renames over a file only while it still has the expected hash (replaceHash, ADR-0019)", async () => {
      await fx.fs.writeFile("page.md", text("old"));
      await fx.fs.writeFile("new.tmp", text("new"));
      await expect(fx.fs.rename("new.tmp", "page.md", { replaceHash: sha256Hex("something else") })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(decode(await fx.fs.readFile("page.md"))).toBe("old");
      expect(await fx.fs.stat("new.tmp")).toBeDefined();
      await fx.fs.rename("new.tmp", "page.md", { replaceHash: sha256Hex("old") });
      expect(decode(await fx.fs.readFile("page.md"))).toBe("new");
      expect(await fx.fs.stat("new.tmp")).toBeUndefined();
      await fx.fs.writeFile("other.tmp", text("x"));
      await expect(fx.fs.rename("other.tmp", "absent.md", { replaceHash: sha256Hex("x") })).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("stat reports kind, size and mtime, and undefined for ENOENT/ENOTDIR", async () => {
      await fx.fs.writeFile("f.md", text("12345"));
      const when = new Date("2024-01-02T03:04:05.678Z");
      await utimes(join(fx.root, "f.md"), when, when);
      const s = await fx.fs.stat("f.md");
      expect(s).toMatchObject({ kind: "file", size: 5 });
      expect(Math.abs(s!.mtimeMs - when.getTime())).toBeLessThan(1);
      expect(s!.mtimeMs).toBe((await lstat(join(fx.root, "f.md"))).mtimeMs);
      expect(await fx.fs.stat("")).toMatchObject({ kind: "directory" });
      expect(await fx.fs.stat("missing.md")).toBeUndefined();
      expect(await fx.fs.stat("missing/deeper.md")).toBeUndefined();
      expect(await fx.fs.stat("f.md/child")).toBeUndefined();
    });

    // Linux: a name stored in NFD is listed in NFC but cannot be opened by that name (macOS and Windows match both).
    onLinux("lists entries with kinds and NFC names, even for NFD names on disk", async () => {
      const nfd = "café.md";
      await writeFile(join(fx.root, nfd), "x");
      await mkdir(join(fx.root, "dir"));
      await symlink(outside, join(fx.root, "sym"));
      // A host may create `.thoth/` when it opens the vault; it is not part of this check.
      const entries = (await fx.fs.list("")).filter((e) => e.name !== ".thoth").sort((a, b) => a.name.localeCompare(b.name));
      expect(entries).toEqual([
        { name: "café.md", kind: "file" },
        { name: "dir", kind: "directory" },
        { name: "sym", kind: "symlink" },
      ]);
      // The NFC name returned by list is usable for reads.
      expect(decode(await fx.fs.readFile("café.md"))).toBe("x");
      await expect(fx.fs.list("missing")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("mkdirp is idempotent and refuses a file in the way", async () => {
      await fx.fs.mkdirp("x/y/z");
      await fx.fs.mkdirp("x/y/z");
      await fx.fs.mkdirp("");
      expect((await stat(join(fx.root, "x/y/z"))).isDirectory()).toBe(true);
      await fx.fs.writeFile("x/file", text("f"));
      await expect(fx.fs.mkdirp("x/file")).rejects.toMatchObject({ code: "EEXIST" });
      await expect(fx.fs.mkdirp("x/file/sub")).rejects.toMatchObject({ code: "ENOTDIR" });
    });

    it("removes recursively without following symlinks", async () => {
      await mkdir(join(fx.root, "tree/inner"), { recursive: true });
      await writeFile(join(fx.root, "tree/inner/a.md"), "a");
      await symlink(outside, join(fx.root, "tree/inner/out"));
      await symlink(join(outside, "secret.md"), join(fx.root, "tree/file-link"));
      await fx.fs.remove("tree");
      expect(await fx.fs.stat("tree")).toBeUndefined();
      expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("secret");
      // Removing a symlink removes the link only.
      await symlink(outside, join(fx.root, "top-link"));
      await fx.fs.remove("top-link");
      expect(await readdir(outside)).toEqual(["secret.md"]);
      // Missing paths are not an error (rm -f).
      await fx.fs.remove("never-existed/x.md");
    });
  });

  describe(`VaultFs no-replace rename without hardlinks (${runtime.name})`, () => {
    let fx: VaultFixture;
    beforeEach(async () => {
      fx = await runtime.vaultFs({ noHardlinks: true });
    });
    afterEach(() => fx.dispose());

    it("falls back to an exclusive copy and never replaces", async () => {
      await fx.fs.writeFile("a.tmp", text("A"));
      await fx.fs.rename("a.tmp", "moved.md", { noReplace: true });
      expect(await readFile(join(fx.root, "moved.md"), "utf8")).toBe("A");
      await expect(stat(join(fx.root, "a.tmp"))).rejects.toThrow();
      await fx.fs.writeFile("b.tmp", text("B"));
      await expect(fx.fs.rename("b.tmp", "moved.md", { noReplace: true })).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(join(fx.root, "moved.md"), "utf8")).toBe("A");
      expect(await readFile(join(fx.root, "b.tmp"), "utf8")).toBe("B");
    });
  });
}

export function sqlDriverContract(runtime: PortRuntime): void {
  describe(`SqlDriver contract (${runtime.name})`, () => {
    let fx: SqlFixture;
    beforeEach(async () => {
      fx = await runtime.sqlDriver();
    });
    afterEach(() => fx.dispose());

    it("runs multiple statements in exec and reports changes from run", async () => {
      await fx.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('a'); INSERT INTO t (name) VALUES ('b');");
      expect(await fx.sql.run("UPDATE t SET name = name || ?", ["!"])).toEqual({ changes: 2 });
      expect(await fx.sql.all("SELECT id, name FROM t ORDER BY id")).toEqual([
        { id: 1, name: "a!" },
        { id: 2, name: "b!" },
      ]);
      expect(await fx.sql.get("SELECT name FROM t WHERE id = ?", [2])).toEqual({ name: "b!" });
      expect(await fx.sql.get("SELECT name FROM t WHERE id = ?", [99])).toBeUndefined();
      expect(await fx.sql.all("SELECT * FROM t WHERE id > 99")).toEqual([]);
    });

    it("round-trips types: null, text, integer, real, bigint and blobs", async () => {
      await fx.sql.exec("CREATE TABLE v (n, i INTEGER, r REAL, s TEXT, b BLOB, big INTEGER)");
      const blob = Uint8Array.from([0, 1, 254, 255]);
      await fx.sql.run("INSERT INTO v VALUES (?, ?, ?, ?, ?, ?)", [null, 42, 1.5, "ไทย ✓", blob, 9007199254740993n]);
      const row = await fx.sql.get("SELECT n, i, r, s, b, CAST(big AS TEXT) AS big, typeof(i) AS ti, typeof(big) AS tbig FROM v");
      expect(row).toEqual({ n: null, i: 42, r: 1.5, s: "ไทย ✓", b: blob, big: "9007199254740993", ti: "integer", tbig: "integer" });
      // JS numbers bind as REAL, as in node:sqlite.
      expect(await fx.sql.get("SELECT typeof(?) AS t", [3])).toEqual({ t: "real" });
      // A bigint within the safe range binds as INTEGER and reads back as a number.
      expect(await fx.sql.get("SELECT ? AS x, typeof(?) AS t", [5n, 5n])).toEqual({ x: 5, t: "integer" });
      expect(await fx.sql.get("SELECT length(?) AS n", [new Uint8Array(0)])).toEqual({ n: 0 });
    });

    it("searches FTS5 with unicode61 remove_diacritics 2 and trigram (Thai)", async () => {
      await fx.sql.exec(`
        CREATE VIRTUAL TABLE w USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');
        CREATE VIRTUAL TABLE g USING fts5(body, tokenize = 'trigram');`);
      await fx.sql.run("INSERT INTO w (body) VALUES (?)", ["Crème brûlée at the Café"]);
      await fx.sql.run("INSERT INTO g (body) VALUES (?)", ["ประชุมเรื่องสถาปัตยกรรมระบบ"]);
      expect(await fx.sql.all("SELECT body FROM w WHERE w MATCH ?", ["creme AND cafe"])).toHaveLength(1);
      expect(await fx.sql.all("SELECT body FROM g WHERE g MATCH ?", ['"สถาปัตย"'])).toHaveLength(1);
      expect(await fx.sql.all("SELECT body FROM g WHERE g MATCH ?", ['"ไม่มี"'])).toHaveLength(0);
    });

    it("supports transactions with commit and rollback", async () => {
      await fx.sql.exec("CREATE TABLE t (x)");
      await fx.sql.exec("BEGIN");
      await fx.sql.run("INSERT INTO t VALUES (1)");
      await fx.sql.exec("ROLLBACK");
      await fx.sql.exec("BEGIN");
      await fx.sql.run("INSERT INTO t VALUES (2)");
      await fx.sql.exec("COMMIT");
      expect(await fx.sql.all("SELECT x FROM t")).toEqual([{ x: 2 }]);
    });

    it("fails with errors and keeps the connection usable", async () => {
      await expect(fx.sql.exec("SELEC 1")).rejects.toThrow(/syntax error/);
      await fx.sql.exec("CREATE TABLE u (k TEXT UNIQUE)");
      await fx.sql.run("INSERT INTO u VALUES ('a')");
      await expect(fx.sql.run("INSERT INTO u VALUES ('a')")).rejects.toThrow(/UNIQUE constraint failed/);
      await expect(fx.sql.get("SELECT * FROM missing_table")).rejects.toThrow(/no such table/);
      expect(await fx.sql.get("SELECT count(*) AS n FROM u")).toEqual({ n: 1 });
    });

    it("enables foreign keys and WAL", async () => {
      expect(await fx.sql.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
      expect(await fx.sql.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
    });
  });
}

export function sourceHostContract(runtime: PortRuntime): void {
  describe(`SourceHost contract (${runtime.name})`, () => {
    let base: string;
    let folder: string;
    let archive: string;
    let host: SourceFixture;
    let temps: string;

    beforeEach(async () => {
      base = await tempDir("thoth-port-source-");
      folder = join(base, "Export");
      archive = join(base, "export.zip");
      await mkdir(join(folder, "sub"), { recursive: true });
      await writeFile(join(folder, "a.md"), "0123456789");
      await writeFile(join(folder, "sub", "b.md"), "bee");
      await writeFile(archive, "PK\u0005\u0006archive-bytes");
      const outside = join(base, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "secret.md"), "secret");
      await symlink(join(outside, "secret.md"), join(folder, "link.md"));
      await symlink(outside, join(folder, "linkdir"));
      if (!WINDOWS) execFileSync("mkfifo", [join(folder, "fifo")]);
      temps = await tempDir("thoth-port-temps-");
      host = await runtime.sourceHost(base, temps);
    });
    afterEach(async () => {
      await host.dispose();
      await rm(base, { recursive: true, force: true });
      await rm(temps, { recursive: true, force: true });
    });

    it("opens a folder source and lists entries without following symlinks", async () => {
      const source = await host.open(folder);
      expect(source.rootKind).toBe("directory");
      expect(source.label).toBe("Export");
      const entries = (await source.list("")).sort((a, b) => a.name.localeCompare(b.name));
      expect(entries).toEqual([
        { name: "a.md", kind: "file", size: 10 },
        ...(WINDOWS ? [] : [{ name: "fifo", kind: "other", size: 0 }]),
        { name: "link.md", kind: "symlink", size: 0 },
        { name: "linkdir", kind: "symlink", size: 0 },
        { name: "sub", kind: "directory", size: 0 },
      ]);
      expect(await source.list("sub")).toEqual([{ name: "b.md", kind: "file", size: 3 }]);
      await expect(source.list("linkdir")).rejects.toThrow(/[Ss]ymlink/);
      await expect(source.list("../outside")).rejects.toThrow();
      await source.close();
      await source.close();
    });

    it("reads at positions and stops at end of file", async () => {
      const source = await host.open(folder);
      const file = await source.open("a.md");
      expect(file.size).toBe(10);
      expect(decode(await file.read(3, 4))).toBe("3456");
      expect(decode(await file.read(8, 100))).toBe("89");
      expect((await file.read(50, 10)).length).toBe(0);
      expect(decode(await (await source.open("sub/b.md")).read(0, 3))).toBe("bee");
      await file.close();
      await file.close();
      await source.close();
    });

    it("refuses symlinks, FIFOs, directories and escapes", async () => {
      const source = await host.open(folder);
      await expect(source.open("link.md")).rejects.toThrow();
      await expect(source.open("linkdir/secret.md")).rejects.toThrow(/[Ss]ymlink/);
      if (!WINDOWS) await expect(source.open("fifo")).rejects.toThrow(/regular file/);
      await expect(source.open("sub")).rejects.toThrow();
      await expect(source.open("../outside/secret.md")).rejects.toThrow();
      await expect(source.open("")).rejects.toThrow();
      await source.close();
    });

    it("opens an archive source only as the archive itself", async () => {
      const source = await host.open(archive);
      expect(source.rootKind).toBe("file");
      expect(source.label).toBe("export.zip");
      const file = await source.open("");
      expect(decode(await file.read(0, 4))).toBe("PK\u0005\u0006");
      await expect(source.open("inner.md")).rejects.toThrow();
      await source.close();
    });

    it("creates private temp files (0600 in a 0700 dir) deleted on close and on source close", async () => {
      const source = await host.open(archive);
      const temp = await source.createTemp();
      await temp.write(0, text("hello"));
      await temp.write(5, text(" world"));
      expect(temp.size).toBe(11);
      expect(decode(await temp.read(0, 11))).toBe("hello world");
      const path = await findTempFile(temps);
      expect(path).toBeDefined();
      if (!WINDOWS) {
        expect((await stat(path!)).mode & 0o777).toBe(0o600);
        expect((await stat(join(path!, ".."))).mode & 0o777).toBe(0o700);
      }
      await temp.close();
      await expect(stat(path!)).rejects.toThrow();
      const second = await source.createTemp();
      await second.write(0, text("x"));
      const secondPath = await findTempFile(temps);
      await source.close();
      await expect(stat(join(secondPath!, ".."))).rejects.toThrow();
      await source.close();
    });
  });
}

/** The newest file in any `thoth-import-*` directory under `root`. */
async function findTempFile(root: string): Promise<string | undefined> {
  let newest: { path: string; mtime: number } | undefined;
  for (const name of await readdir(root)) {
    if (!name.startsWith("thoth-import-")) continue;
    const dir = join(root, name);
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      const s = await stat(join(dir, file)).catch(() => undefined);
      if (s && (!newest || s.mtimeMs >= newest.mtime)) newest = { path: join(dir, file), mtime: s.mtimeMs };
    }
  }
  return newest?.path;
}
