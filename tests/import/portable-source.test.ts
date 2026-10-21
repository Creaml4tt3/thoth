import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ArchiveRejectedError, ImportCancelledError, openArchiveSource, openFolderSource, type ImportSource } from "@thoth/importer-core";
import { NotionMarkdownCsvImporter, NotionZipImporter } from "@thoth/importer-notion";
import { ObsidianVaultImporter, ObsidianZipImporter } from "@thoth/importer-obsidian";
import { MemoryHost } from "../helpers/memory-host.ts";
import { buildZip, type RawZipEntry } from "../helpers/zip.ts";

/**
 * The portable sources over an in-memory `SourceHost`: the same policy as the
 * Node wrappers, with nothing but the port. A child process with every Node
 * builtin blocked proves the main entries are webview-ready.
 */
const run = promisify(execFile);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function drain(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c);
  return Buffer.concat(parts);
}

describe("openArchiveSource over an in-memory host", () => {
  it("scans, reads and streams an archive, and closing it closes the host once", async () => {
    const big = randomBytes(300_000);
    const host = MemoryHost.file("vault.zip", buildZip([{ name: "Vault/a.md", data: "# a\n" }, { name: "Vault/big.bin", data: big }, { name: "Vault/.DS_Store", data: "x" }]));
    const source = await openArchiveSource(host);
    expect(source.label).toBe("vault.zip");
    expect(source.location).toBe("memory:vault.zip");
    expect(source.entries).toEqual([
      { path: "Vault/a.md", size: 4 },
      { path: "Vault/big.bin", size: big.length },
    ]);
    expect(text(await source.read("Vault/a.md"))).toBe("# a\n");
    expect(Buffer.from(await drain(source.openReadStream("Vault/big.bin"))).equals(big)).toBe(true);
    expect(host.opened.every((f) => f.outOfRange === 0)).toBe(true);
    await source.close();
    await source.close();
    expect(host.closeCount).toBe(1);
  });

  it("applies the same rejections as the Node source (traversal, symlink, special, encrypted, duplicate, NFC)", async () => {
    const host = MemoryHost.file(
      "evil.zip",
      buildZip([
        { name: "../escape.md", data: "x" },
        { name: "/etc/passwd.md", data: "x" },
        { name: "C:/win.md", data: "x" },
        { name: "..\\..\\win.md", data: "x" },
        { name: "nul\0.md", data: "x" },
        { name: "link.md", data: "/etc/passwd", mode: 0o120777, deflate: false },
        { name: "fifo", data: "", mode: 0o010644, deflate: false },
        { name: "secret.md", data: "x", flags: 0x1 },
        { name: "Cafe\u0301.md", data: "nfd" },
        { name: "Caf\u00e9.md", data: "nfc" },
        { name: "__MACOSX/._a.md", data: "x" },
        { name: "ok.md", data: "ok" },
      ]),
    );
    const source = await openArchiveSource(host);
    expect(source.entries.map((e) => e.path)).toEqual(["Caf\u00e9.md", "ok.md"]);
    expect(text(await source.read("Caf\u00e9.md"))).toBe("nfd"); // first copy wins
    expect(source.rejected.map((r) => r.code).sort()).toEqual(["duplicate_entry", "encrypted_entry", "special_entry", "symlink_entry", ...Array(5).fill("unsafe_path")]);
    await source.close();
  });

  it("enforces size, count, ratio and total limits before inflating anything", async () => {
    const reject = async (entries: RawZipEntry[], limits: object, code: string) => {
      const bytes = buildZip(entries);
      const host = MemoryHost.file("x.zip", bytes);
      await expect(openArchiveSource(host, limits)).rejects.toMatchObject({ code });
      expect(host.closeCount).toBe(1); // a failed open closes the host
      // Only the end-record search window (which ends at end of file) and the central directory were read:
      // no local header was opened and nothing was inflated.
      const cdOffset = bytes.readUInt32LE(bytes.length - 22 + 16);
      const reads = host.opened.flatMap((f) => f.reads);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.filter((r) => r.position + r.length !== bytes.length && r.position < cdOffset)).toEqual([]);
    };
    await reject([{ name: "bomb.md", data: Buffer.alloc(20 * 1024 * 1024) }], {}, "compression_ratio");
    await reject(Array.from({ length: 80 }, (_, i) => ({ name: `f${i}.bin`, data: Buffer.alloc(1024 * 1024) })), {}, "compression_ratio");
    await reject(Array.from({ length: 11 }, (_, i) => ({ name: `${i}.md`, data: "x" })), { maxEntries: 10 }, "too_many_entries");
    await reject(Array.from({ length: 11 }, (_, i) => ({ name: `${i}.md`, data: "x" })), { maxTotalBytes: 5 }, "too_large");

    const host = MemoryHost.file("big.zip", buildZip([{ name: "big.bin", data: Buffer.alloc(2048, 7), deflate: false }, { name: "ok.md", data: "ok" }]));
    const source = await openArchiveSource(host, { maxEntryBytes: 1024 });
    expect(source.entries.map((e) => e.path)).toEqual(["ok.md"]);
    expect(source.rejected).toContainEqual(expect.objectContaining({ code: "entry_too_large" }));
    await source.close();
  });

  it("rejects malformed archives and a directory host with malformed_zip, closing the host", async () => {
    const garbage = MemoryHost.file("g.zip", new TextEncoder().encode("this is not a zip file at all"));
    await expect(openArchiveSource(garbage)).rejects.toMatchObject({ code: "malformed_zip" });
    expect(garbage.closed).toBe(true);
    const dir = MemoryHost.directory("folder", {});
    await expect(openArchiveSource(dir)).rejects.toMatchObject({ code: "malformed_zip" });
    expect(dir.closed).toBe(true);
  });

  it.each([
    ["STORED parts read in place", false],
    ["DEFLATE parts inflated to host temp files", true],
  ])("opens multi-part exports: %s", async (_label, deflate) => {
    const part1 = buildZip([{ name: "a.md", data: "# a\n[b](b.md)\n" }, { name: "pic.png", data: randomBytes(100_000) }]);
    const part2 = buildZip([{ name: "b.md", data: "# b\n" }]);
    const host = MemoryHost.file("multi.zip", buildZip([{ name: "Export-Part-1.zip", data: part1, deflate }, { name: "Export-Part-2.zip", data: part2, deflate }]));
    const source = await openArchiveSource(host);
    expect(source.entries.map((e) => e.path)).toEqual(["a.md", "b.md", "pic.png"]);
    expect(text(await source.read("b.md"))).toBe("# b\n");
    expect(host.temps).toHaveLength(deflate ? 2 : 0);
    expect(host.opened).toHaveLength(1); // parts never reopen or copy the outer archive
    expect(host.opened[0]!.outOfRange).toBe(0);
    await source.close();
    expect(host.temps.every((t) => t.closed)).toBe(true);
    expect(host.closeCount).toBe(1);
  });

  it("caps nested parts with maxNestedArchiveBytes and shares budgets across parts", async () => {
    const p1 = buildZip([{ name: "a.bin", data: randomBytes(50_000) }]);
    const p2 = buildZip([{ name: "b.md", data: "# b\n" }]);
    const bytes = buildZip([{ name: "Export-Part-1.zip", data: p1 }, { name: "Export-Part-2.zip", data: p2 }]);
    const capped = MemoryHost.file("multi.zip", bytes);
    await expect(openArchiveSource(capped, { maxNestedArchiveBytes: p1.length - 1 })).rejects.toMatchObject({ code: "nested_archive_too_large" });
    expect(capped.temps).toHaveLength(0);
    await expect(openArchiveSource(MemoryHost.file("multi.zip", bytes), { maxEntries: 3 })).rejects.toMatchObject({ code: "too_many_entries" });
    const ok = await openArchiveSource(MemoryHost.file("multi.zip", bytes), { maxEntries: 4 });
    expect(ok.entries.map((e) => e.path)).toEqual(["a.bin", "b.md"]);
    await ok.close();
  });

  it("cancels opening via the AbortSignal and releases temp files", async () => {
    const part = buildZip([{ name: "a.md", data: "# a\n" }, { name: "noise.bin", data: randomBytes(300_000), deflate: false }]);
    const host = MemoryHost.file("multi.zip", buildZip([{ name: "Export-Part-1.zip", data: part }, { name: "Export-Part-2.zip", data: part }]));
    const controller = new AbortController();
    const original = host.createTemp.bind(host);
    host.createTemp = async () => {
      const temp = await original();
      const write = temp.write.bind(temp);
      temp.write = async (position, data) => {
        controller.abort(); // cancel mid-extraction
        return write(position, data);
      };
      return temp;
    };
    await expect(openArchiveSource(host, {}, { signal: controller.signal })).rejects.toBeInstanceOf(ImportCancelledError);
    expect(host.temps.length).toBeGreaterThan(0);
    expect(host.temps.every((t) => t.closed)).toBe(true);
    expect(host.closeCount).toBe(1);
  });
});

describe("openFolderSource over an in-memory host", () => {
  it("lists without following symlinks, maps NFD disk names to NFC paths, and applies limits", async () => {
    const host = MemoryHost.directory("Vault", {
      "Cafe\u0301": { "note.md": "# nfd folder\n" },
      "a.md": "# a\n",
      "big.bin": new Uint8Array(2048),
      ".DS_Store": "x",
      link: { kind: "symlink" },
      pipe: { kind: "other" },
    });
    const source = await openFolderSource(host, { maxEntryBytes: 1024 });
    expect(source.entries.map((e) => e.path)).toEqual(["Caf\u00e9/note.md", "a.md"]);
    expect(source.rejected.map((r) => [r.code, r.sourcePath])).toEqual(
      expect.arrayContaining([
        ["symlink_entry", "link"],
        ["special_entry", "pipe"],
        ["entry_too_large", "big.bin"],
      ]),
    );
    // Reads go to the on-disk (NFD) name.
    expect(text(await source.read("Caf\u00e9/note.md"))).toBe("# nfd folder\n");
    expect(text(await drain(source.openReadStream("a.md")))).toBe("# a\n");
    expect(host.opened.every((f) => f.closed)).toBe(true);
    await source.close();
    await source.close();
    expect(host.closeCount).toBe(1);

    await expect(openFolderSource(MemoryHost.directory("v", { a: "1", b: "2" }), { maxEntries: 1 })).rejects.toMatchObject({ code: "too_many_entries" });
    await expect(openFolderSource(MemoryHost.directory("v", { a: "12", b: "34" }), { maxTotalBytes: 3 })).rejects.toMatchObject({ code: "too_large" });
    const fileHost = MemoryHost.file("x.zip", buildZip([]));
    await expect(openFolderSource(fileHost)).rejects.toBeInstanceOf(ArchiveRejectedError);
    expect(fileHost.closed).toBe(true);
  });
});

describe("host importers from the browser-safe main entries", () => {
  it("declare their host kind and open through openHost", async () => {
    expect([NotionZipImporter, ObsidianZipImporter].map((i) => i.hostKind)).toEqual(["file", "file"]);
    expect([NotionMarkdownCsvImporter, ObsidianVaultImporter].map((i) => i.hostKind)).toEqual(["directory", "directory"]);
    const zip = buildZip([{ name: "MyVault/note.md", data: "# n\n" }]);
    const opened = await ObsidianZipImporter.openHost(MemoryHost.file("v.zip", zip));
    expect(opened.provider.sourceKind).toBe("obsidian-zip");
    expect(opened.provider.rootPrefix?.(opened.source.entries.map((e) => e.path))).toBe("MyVault/");
    await opened.source.close();
    const folder = await NotionMarkdownCsvImporter.openHost(MemoryHost.directory("export", { "Page 0123456789abcdef0123456789abcdef.md": "# p\n" }));
    expect(folder.provider.sourceKind).toBe("notion-folder");
    expect(folder.source.entries).toHaveLength(1);
    await folder.source.close();
  });

  it("refuse the wrong host kind and close it", async () => {
    const dir = MemoryHost.directory("folder", {});
    await expect(NotionZipImporter.openHost(dir)).rejects.toBeInstanceOf(ArchiveRejectedError);
    expect(dir.closed).toBe(true);
    const file = MemoryHost.file("x.zip", buildZip([]));
    await expect(ObsidianVaultImporter.openHost(file)).rejects.toBeInstanceOf(ArchiveRejectedError);
    expect(file.closed).toBe(true);
  });
});

describe("webview readiness", () => {
  it("opens and reads archives (STORED, DEFLATE, nested) and folders in a process where first-party code cannot load any Node builtin", async () => {
    const child = resolve(import.meta.dirname, "../helpers/no-node-child.ts");
    const fixtures = {
      flat: buildZip([{ name: "a.md", data: "# a\n" }, { name: "b.bin", data: Buffer.alloc(200_000, 3) }]),
      nested: buildZip([
        { name: "Export-Part-1.zip", data: buildZip([{ name: "p1.md", data: "# one\n" }]) },
        { name: "Export-Part-2.zip", data: buildZip([{ name: "p2.md", data: "# two\n" }]), deflate: false },
      ]),
    };
    const { stdout } = await run(process.execPath, [child, JSON.stringify(Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, v.toString("base64")])))], { timeout: 60_000 });
    expect(JSON.parse(stdout)).toEqual({
      blockedBuiltins: true,
      flat: { entries: ["a.md", "b.bin"], a: "# a\n", bSize: 200_000 },
      nested: { entries: ["p1.md", "p2.md"], p1: "# one\n", p2: "# two\n" },
      folder: { entries: ["Caf\u00e9.md"], text: "folder" },
      importers: ["NotionZipImporter", "NotionMarkdownCsvImporter", "ObsidianVaultImporter", "ObsidianZipImporter"],
    });
  });
});

export type { ImportSource };
