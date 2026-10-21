import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSha256, sha256Hex } from "@thoth/domain";
import { hashStream, ImportCancelledError, planImport, runImport, type ImportSource } from "@thoth/importer-core";
import { openDirectorySource, openZipSource } from "@thoth/importer-core/node";
import { obsidianProvider } from "@thoth/importer-obsidian";
import { ObsidianVaultImporter, ObsidianZipImporter } from "@thoth/importer-obsidian/node";
import type { Vault } from "@thoth/local-store";
import { openNodeVault } from "@thoth/local-store/node";
import { InstrumentedSource } from "../helpers/instrumented-source.ts";
import { buildZip, dirEntries, writeZip, type RawZipEntry } from "../helpers/zip.ts";

// yauzl is a dependency of importer-core only; load the very instance it uses.
const yauzl = createRequire(resolve(import.meta.dirname, "../../packages/importer-core/package.json"))("yauzl") as Record<
  "fromBuffer" | "fromBufferPromise" | "fromRandomAccessReaderPromise",
  (...args: unknown[]) => unknown
>;

let work: string;
let tempRoot: string;
let vaultRoot: string;
let vault: Vault;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "thoth-stream-"));
  tempRoot = join(work, "tmp");
  await mkdir(tempRoot);
  vaultRoot = join(work, "vault");
  ({ vault } = await openNodeVault(vaultRoot));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await vault.close();
  await rm(work, { recursive: true, force: true });
});

async function drain(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c);
  return Buffer.concat(parts);
}

/** Bytes requested from any FileHandle while `fn` runs (every archive read goes through FileHandle.read). */
async function bytesReadDuring<T>(fn: () => Promise<T>): Promise<{ result: T; requested: number }> {
  const probe = await open(join(work, "probe"), "w");
  const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => unknown };
  await probe.close();
  const spy = vi.spyOn(proto, "read");
  try {
    const result = await fn();
    const requested = spy.mock.calls.reduce((n, call) => n + (typeof call[2] === "number" ? call[2] : 0), 0);
    return { result, requested };
  } finally {
    spy.mockRestore();
  }
}

const importAll = async (source: ImportSource) => {
  const { manifest } = await planImport({ vault, source, provider: obsidianProvider(), options: { destinationRoot: "", addIdentityFrontmatter: false } });
  return { manifest, report: await runImport(vault, source, manifest) };
};

describe("streaming SHA-256", () => {
  it("matches sha256Hex for every length and chunking", async () => {
    for (let n = 0; n < 300; n++) {
      const data = randomBytes(n);
      const h = createSha256();
      for (let i = 0; i < n; ) {
        const k = 1 + ((i * 7 + n) % 70);
        h.update(data.subarray(i, i + k));
        i += k;
      }
      expect(h.digestHex()).toBe(sha256Hex(data));
    }
    const big = randomBytes(3 * 1024 * 1024 + 17);
    async function* chunks() {
      for (let i = 0; i < big.length; i += 65_536) yield big.subarray(i, i + 65_536);
    }
    expect(await hashStream(chunks())).toEqual({ hash: sha256Hex(big), size: big.length });
  });
});

describe("planning memory is bounded by the largest file", () => {
  it.each(["zip", "directory"])("streams attachments while planning and never reads one whole (%s)", async (kind) => {
    const src = join(work, "src");
    await mkdir(join(src, "sub"), { recursive: true });
    const big = randomBytes(3 * 1024 * 1024);
    const small = randomBytes(200 * 1024);
    await writeFile(join(src, "a.md"), "# a\n![[big.bin]] [[b]] ![](sub/c.png)\n");
    await writeFile(join(src, "b.md"), "# b\n");
    await writeFile(join(src, "big.bin"), big);
    await writeFile(join(src, "sub/c.png"), small);
    const opened = kind === "zip" ? await ObsidianZipImporter.open(await writeZip(join(work, "src.zip"), await dirEntries(src))) : await ObsidianVaultImporter.open(src);
    const source = new InstrumentedSource(opened.source);

    const { manifest } = await planImport({ vault, source, provider: opened.provider, options: { destinationRoot: "" } });
    const attachments = manifest.items.filter((i) => i.kind === "attachment").map((i) => i.sourcePath).sort();
    expect(attachments).toEqual(["big.bin", "sub/c.png"]);
    // Planning never calls read() on an attachment; it hashes them from bounded chunks.
    expect(source.reads.filter((p) => attachments.includes(p))).toEqual([]);
    expect([...source.streams].sort()).toEqual(attachments);
    expect(source.maxChunk).toBeGreaterThan(0);
    expect(source.maxChunk).toBeLessThanOrEqual(256 * 1024);
    const bigItem = manifest.items.find((i) => i.sourcePath === "big.bin")!;
    expect(bigItem).toMatchObject({ sourceHash: sha256Hex(big), size: big.length });
    expect(manifest.items.find((i) => i.sourcePath === "sub/c.png")).toMatchObject({ sourceHash: sha256Hex(small), size: small.length });

    // Staging reads each attachment exactly once (one file in memory at a time).
    source.reads.length = 0;
    const report = await runImport(vault, source, manifest);
    await source.close();
    expect(report.state).toBe("completed");
    expect(source.reads.filter((p) => p === "big.bin")).toEqual(["big.bin"]);
    expect((await readFile(join(vaultRoot, "big.bin"))).equals(big)).toBe(true);
  });
});

describe("nested archives are never buffered", () => {
  it("opens a STORED nested part in place: only directory bytes are read, no Buffer copy, no temp file", async () => {
    const big = randomBytes(4 * 1024 * 1024);
    const part1 = buildZip([{ name: "a.md", data: "# a\n[b](b.md)\n" }, { name: "big.bin", data: big, deflate: false }]);
    const part2 = buildZip([{ name: "b.md", data: "# b\n" }]);
    const outer = await writeZip(join(work, "multi.zip"), [
      { name: "Export-Part-1.zip", data: part1, deflate: false },
      { name: "Export-Part-2.zip", data: part2, deflate: false },
    ]);
    const fromBuffer = vi.spyOn(yauzl, "fromBufferPromise");
    const fromBufferCb = vi.spyOn(yauzl, "fromBuffer");
    const fromReader = vi.spyOn(yauzl, "fromRandomAccessReaderPromise");

    const { result: source, requested } = await bytesReadDuring(() => openZipSource(outer, {}, { tempRoot }));
    // EOCD search windows (≤ 64 KiB each) + central directories + one local header; the 4 MiB part is never read.
    expect(requested).toBeLessThan(256 * 1024);
    expect(part1.length).toBeGreaterThan(16 * requested);
    expect(fromBuffer).not.toHaveBeenCalled();
    expect(fromBufferCb).not.toHaveBeenCalled();
    expect(fromReader).toHaveBeenCalledTimes(3); // control: the spies do see zip_source's yauzl calls (outer + 2 parts)
    expect(await readdir(tempRoot)).toEqual([]);
    expect(source.entries.map((e) => e.path)).toEqual(["a.md", "b.md", "big.bin"]);

    // Inner entries stream straight from the outer file's byte range.
    expect(await hashStream(source.openReadStream("big.bin"))).toEqual({ hash: sha256Hex(big), size: big.length });
    const { report } = await importAll(source);
    expect(report.state).toBe("completed");
    expect((await readFile(join(vaultRoot, "big.bin"))).equals(big)).toBe(true);
    expect(await readFile(join(vaultRoot, "a.md"), "utf8")).toContain("[b](b.md)");
    await source.close();
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("extracts a DEFLATE nested part to a private temp file and deletes it on close", async () => {
    const part1 = buildZip([{ name: "a.md", data: "# a\n[b](b.md)\n" }, { name: "pic.png", data: randomBytes(100_000) }]);
    const part2 = buildZip([{ name: "b.md", data: "# b\n" }]);
    const outer = await writeZip(join(work, "multi.zip"), [{ name: "Export-Part-1.zip", data: part1 }, { name: "Export-Part-2.zip", data: part2 }]);
    const source = await openZipSource(outer, {}, { tempRoot });

    const dirs = await readdir(tempRoot);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^thoth-import-/);
    const dir = join(tempRoot, dirs[0]!);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await readdir(dir)).sort()).toEqual(["part-1.zip", "part-2.zip"]);
    expect((await stat(join(dir, "part-1.zip"))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(dir, "part-1.zip"))).equals(part1)).toBe(true);

    const { report } = await importAll(source);
    expect(report.state).toBe("completed");
    expect(report.imported).toEqual({ pages: 2, attachments: 1, databases: 0 });
    await source.close();
    expect(await readdir(tempRoot)).toEqual([]);
    await source.close(); // idempotent
  });

  it("deletes extracted temp files when a later part fails mid-extraction", async () => {
    const part1 = buildZip([{ name: "a.md", data: "# a\n" }]);
    const part2 = buildZip([{ name: "b.md", data: "b".repeat(5000) }, { name: "c.bin", data: randomBytes(5000) }]);
    const name1 = Buffer.from("Export-Part-1.zip");
    const buf = buildZip([{ name: name1.toString(), data: part1 }, { name: "Export-Part-2.zip", data: part2 }]);
    // Under-declare part 2's uncompressed size in both headers: the lie is only discovered while inflating it.
    const local2 = 30 + name1.length + deflateRawSync(part1).length;
    buf.writeUInt32LE(100, local2 + 22);
    const cd = buf.readUInt32LE(buf.length - 22 + 16);
    buf.writeUInt32LE(100, cd + 46 + name1.length + 24);
    await writeFile(join(work, "lie.zip"), buf);

    await expect(openZipSource(join(work, "lie.zip"), {}, { tempRoot })).rejects.toMatchObject({ code: "malformed_zip", message: expect.stringMatching(/too many bytes/) });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("deletes the temp file when opening is cancelled mid-extraction", async () => {
    const part1 = buildZip([{ name: "a.md", data: "# a\n" }, { name: "noise.bin", data: randomBytes(1024 * 1024), deflate: false }]);
    const part2 = buildZip([{ name: "b.md", data: "# b\n" }]);
    const outer = await writeZip(join(work, "multi.zip"), [{ name: "Export-Part-1.zip", data: part1 }, { name: "Export-Part-2.zip", data: part2 }]);
    let checks = 0;
    let seenAtCancel: string[] = [];
    // Deterministic cancel: the third check happens after part 1 extraction has started writing.
    const signal = {
      get aborted() {
        checks++;
        if (checks === 3) seenAtCancel = (readdirSync(tempRoot, { recursive: true }) as string[]).map((p) => p.replaceAll("\\", "/"));
        return checks >= 3;
      },
    } as unknown as AbortSignal;

    await expect(openZipSource(outer, {}, { tempRoot, signal })).rejects.toBeInstanceOf(ImportCancelledError);
    expect(seenAtCancel.some((p) => /^thoth-import-[^/]+\/part-1\.zip$/.test(p))).toBe(true);
    expect(await readdir(tempRoot)).toEqual([]);
  });
});

describe("in-place reader bounds", () => {
  it("never lets a STORED part read bytes outside its own range", async () => {
    // A valid central-directory record for "leaked.md" placed in the *next* part's data.
    const leakedName = Buffer.from("leaked.md");
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(leakedName.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    const carrier = Buffer.concat([record, leakedName]);
    const part2 = buildZip([{ name: "carrier.bin", data: carrier, deflate: false }]);
    // Part 1 is only an end-of-central-directory record whose directory offset points past its end, at that record.
    const name1 = "Export-Part-1.zip";
    const name2 = "Export-Part-2.zip";
    const part1Start = 30 + name1.length;
    const carrierStart = part1Start + 22 + 30 + name2.length + 30 + "carrier.bin".length;
    const part1 = Buffer.alloc(22);
    part1.writeUInt32LE(0x06054b50, 0);
    part1.writeUInt16LE(1, 8);
    part1.writeUInt16LE(1, 10);
    part1.writeUInt32LE(carrier.length, 12);
    part1.writeUInt32LE(carrierStart - part1Start, 16);
    const outer = await writeZip(join(work, "escape.zip"), [
      { name: name1, data: part1, deflate: false },
      { name: name2, data: part2, deflate: false },
    ]);
    expect((await readFile(outer)).subarray(carrierStart, carrierStart + 4).readUInt32LE(0)).toBe(0x02014b50); // the record really is there

    await expect(openZipSource(outer, {}, { tempRoot })).rejects.toMatchObject({ code: "malformed_zip", message: expect.stringMatching(/outside archive bounds/) });
  });
});

describe.each([
  ["STORED part, opened in place", false],
  ["DEFLATE part, extracted to temp", true],
])("limits still apply inside nested parts (%s)", (_label, deflate) => {
  const multi = (parts: Buffer[]) => writeZip(join(work, "multi.zip"), parts.map((data, i) => ({ name: `Export-Part-${i + 1}.zip`, data, deflate })));

  it("rejects a compression-ratio bomb inside a part", async () => {
    const zip = await multi([buildZip([{ name: "ok.md", data: "ok" }]), buildZip([{ name: "bomb.md", data: Buffer.alloc(20 * 1024 * 1024) }])]);
    await expect(openZipSource(zip, {}, { tempRoot })).rejects.toMatchObject({ code: "compression_ratio" });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("rejects many medium entries across parts that add up to a bomb (archive-wide ratio)", async () => {
    const many = (k: number) => buildZip(Array.from({ length: 40 }, (_, i) => ({ name: `p${k}/f${i}.bin`, data: Buffer.alloc(1024 * 1024) })));
    const zip = await multi([many(1), many(2)]);
    await expect(openZipSource(zip, {}, { tempRoot })).rejects.toMatchObject({ code: "compression_ratio" });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("shares the total-size and entry budgets across parts", async () => {
    const entries = (k: number): RawZipEntry[] => Array.from({ length: 3 }, (_, i) => ({ name: `p${k}/${i}.bin`, data: randomBytes(1000), deflate: false }));
    const p1 = buildZip(entries(1));
    const p2 = buildZip(entries(2));
    const zip = await multi([p1, p2]);
    // Budget = the outer part entries + every inner entry, as before.
    const total = p1.length + p2.length + 6000;
    await expect(openZipSource(zip, { maxTotalBytes: total - 1 }, { tempRoot })).rejects.toMatchObject({ code: "too_large" });
    expect(await readdir(tempRoot)).toEqual([]);
    await expect(openZipSource(zip, { maxEntries: 2 + 6 - 1 }, { tempRoot })).rejects.toMatchObject({ code: "too_many_entries" });
    expect(await readdir(tempRoot)).toEqual([]);
    const ok = await openZipSource(zip, { maxTotalBytes: total, maxEntries: 8 }, { tempRoot });
    expect(ok.entries).toHaveLength(6);
    await ok.close();
  });

  it("rejects traversal, symlink, encrypted and duplicate entries inside a part and imports the rest", async () => {
    const zip = await multi([
      buildZip([
        { name: "../escape.md", data: "x" },
        { name: "a/../../escape2.md", data: "x" },
        { name: "/etc/passwd.md", data: "x" },
        { name: "..\\..\\win.md", data: "x" },
        { name: "link.md", data: "/etc/passwd", mode: 0o120777, deflate: false },
        { name: "secret.md", data: "x", flags: 0x1 },
        { name: "ok.md", data: "# ok\n" },
        { name: "ok.md", data: "# shadow\n" },
      ]),
      buildZip([{ name: "p2.md", data: "# p2\n" }]),
    ]);
    const source = await openZipSource(zip, {}, { tempRoot });
    expect(source.entries.map((e) => e.path)).toEqual(["ok.md", "p2.md"]);
    const codes = source.rejected.map((r) => r.code).sort();
    expect(codes).toEqual(["duplicate_entry", "encrypted_entry", "symlink_entry", "unsafe_path", "unsafe_path", "unsafe_path", "unsafe_path"]);
    const { report } = await importAll(source);
    await source.close();
    expect(report.state).toBe("completed");
    expect(await readFile(join(vaultRoot, "ok.md"), "utf8")).toBe("# ok\n");
    expect(await readdir(work)).toEqual(expect.not.arrayContaining(["escape.md", "escape2.md", "win.md"]));
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("rejects a part over the nested-part cap before reading it", async () => {
    const p1 = buildZip([{ name: "a.bin", data: randomBytes(200_000) }]);
    const p2 = buildZip([{ name: "b.md", data: "# b\n" }]);
    const zip = await multi([p1, p2]);
    const { result, requested } = await bytesReadDuring(() =>
      openZipSource(zip, { maxNestedArchiveBytes: p1.length - 1 }, { tempRoot }).then(
        () => undefined,
        (error: unknown) => error,
      ),
    );
    expect(result).toMatchObject({ code: "nested_archive_too_large" });
    // Only the outer EOCD window (≤ 64 KiB) and central directory are read; part 1 is neither opened nor extracted.
    expect(requested).toBeLessThan(70_000);
    expect(p1.length).toBeGreaterThan(200_000);
    expect(await readdir(tempRoot)).toEqual([]);
    const ok = await openZipSource(zip, { maxNestedArchiveBytes: p1.length }, { tempRoot });
    expect(ok.entries.map((e) => e.path)).toEqual(["a.bin", "b.md"]);
    await ok.close();
  });

  it("does not open archives nested more than one level deep", async () => {
    const zip = await multi([buildZip([{ name: "inner.zip", data: buildZip([{ name: "deep.md", data: "x" }]) }, { name: "a.md", data: "# a\n" }])]);
    const source = await openZipSource(zip, {}, { tempRoot });
    expect(source.entries.map((e) => e.path)).toEqual(["a.md", "inner.zip"]);
    expect(source.rejected.map((r) => r.code)).toContain("nested_archive");
    await source.close();
  });
});

describe("directory source streaming keeps its symlink guarantees", () => {
  it("refuses a file or ancestor replaced by a symlink after the scan", async () => {
    const src = join(work, "src");
    await mkdir(join(src, "notes"), { recursive: true });
    await writeFile(join(src, "notes/a.md"), "# a\n");
    await writeFile(join(src, "b.md"), "# b\n");
    await writeFile(join(work, "secret.txt"), "secret");
    const source = await openDirectorySource(src);
    expect((await drain(source.openReadStream("b.md"))).toString()).toBe("# b\n");

    await rm(join(src, "b.md"));
    await symlink(join(work, "secret.txt"), join(src, "b.md"));
    await expect(drain(source.openReadStream("b.md"))).rejects.toThrow();
    await expect(source.read("b.md")).rejects.toThrow();

    await rename(join(src, "notes"), join(work, "moved"));
    await symlink(join(work, "moved"), join(src, "notes"));
    await expect(drain(source.openReadStream("notes/a.md"))).rejects.toThrow(/Symlinked directory/);
    await expect(source.read("notes/a.md")).rejects.toThrow(/Symlinked directory/);
    await source.close();
  });
});

describe("hash verification at convert time", () => {
  it("fails a page edited between plan and run, with a clear item error", async () => {
    const src = join(work, "src");
    await mkdir(src);
    await writeFile(join(src, "a.md"), "# a\n[[b]]\n");
    await writeFile(join(src, "b.md"), "# b\n");
    const { source, provider } = await ObsidianVaultImporter.open(src);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "" } });
    await writeFile(join(src, "a.md"), "# a EDITED\n");
    const report = await runImport(vault, source, manifest);
    await source.close();
    expect(report.state).toBe("failed");
    expect(report.failed).toEqual([{ sourcePath: "a.md", error: expect.stringMatching(/Source file changed since the import was planned/) }]);
    expect(await vault.pageByPath("a.md")).toBeUndefined();
    expect(await vault.pageByPath("b.md")).toBeDefined();
  });

  it("verifies the exact bytes it converts, even if content changes after the link pass", async () => {
    const zip = await writeZip(join(work, "v.zip"), [{ name: "a.md", data: "# a\n[[b]]\n" }, { name: "b.md", data: "# b\n" }]);
    const opened = await ObsidianZipImporter.open(zip);
    const source = new InstrumentedSource(opened.source);
    // Read 1 = plan, 2 = run's link pass, 3 = convert/stage. Tamper only with the last.
    source.rewrite = (path, bytes, n) => (path === "a.md" && n >= 3 ? new TextEncoder().encode("# tampered\n") : bytes);
    const { manifest } = await planImport({ vault, source, provider: opened.provider, options: { destinationRoot: "" } });
    const report = await runImport(vault, source, manifest);
    await source.close();
    expect(source.reads.filter((p) => p === "a.md")).toHaveLength(3);
    expect(report.failed).toEqual([{ sourcePath: "a.md", error: expect.stringMatching(/Source file changed/) }]);
    expect(await vault.pageByPath("a.md")).toBeUndefined();
    expect(await readdir(vaultRoot)).not.toContain("a.md");
  });

  it("fails an attachment replaced between plan and run", async () => {
    const src = join(work, "src");
    await mkdir(src);
    await writeFile(join(src, "a.md"), "# a\n![[pic.png]]\n");
    await writeFile(join(src, "pic.png"), randomBytes(1000));
    const { source, provider } = await ObsidianVaultImporter.open(src);
    const { manifest } = await planImport({ vault, source, provider, options: { destinationRoot: "" } });
    await writeFile(join(src, "pic.png"), randomBytes(1000));
    const report = await runImport(vault, source, manifest);
    await source.close();
    expect(report.failed).toEqual([{ sourcePath: "pic.png", error: expect.stringMatching(/Source file changed/) }]);
    await expect(stat(join(vaultRoot, "pic.png"))).rejects.toThrow();
  });
});
