import { describe, expect, it } from "vitest";
import { ArchiveRejectedError, ByteRange, ZipReader, openArchiveSource, type ZipEntry } from "@thoth/importer-core";
import { MemoryFile, MemoryHost } from "../helpers/memory-host.ts";
import { buildZip } from "../helpers/zip.ts";
import { writeArchive, type GenEntry } from "../helpers/zip-gen.ts";
import { yauzlRead } from "../helpers/yauzl-oracle.ts";

/** Adversarial archives from the Phase 1c brief, each asserted against the portable reader (and yauzl where it differs). */
const enc = (s: string) => new TextEncoder().encode(s);
const entry = (name: string, data: string, extra: Partial<GenEntry> = {}): GenEntry => ({ name: enc(name), utf8: true, data: enc(data), method: 8, mode: 0o100644, madeBy: (3 << 8) | 20, ...extra });

async function open(bytes: Uint8Array): Promise<{ zip: ZipReader; entries: ZipEntry[]; file: MemoryFile }> {
  const file = new MemoryFile(bytes);
  const zip = await ZipReader.open(ByteRange.of(file));
  const entries: ZipEntry[] = [];
  for await (const e of zip.entries()) entries.push(e);
  return { zip, entries, file };
}

async function rejects(bytes: Uint8Array, message: RegExp): Promise<void> {
  const file = new MemoryFile(bytes);
  await expect(
    (async () => {
      const zip = await ZipReader.open(ByteRange.of(file));
      const entries: ZipEntry[] = [];
      for await (const e of zip.entries()) entries.push(e);
      for (const e of entries) for await (const _ of zip.openStream(e));
    })(),
  ).rejects.toThrow(message);
  expect(file.outOfRange).toBe(0);
}

async function drain(zip: ZipReader, e: ZipEntry): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of zip.openStream(e)) parts.push(c);
  return Buffer.concat(parts);
}

function eocdAt(b: Buffer): number {
  return b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
}

function centralAt(b: Buffer, index: number): number {
  let at = b.readUInt32LE(eocdAt(b) + 16);
  for (let i = 0; i < index; i++) at += 46 + b.readUInt16LE(at + 28) + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
  return at;
}

describe("adversarial archives", () => {
  it("rejects overlapping entries (two central records sharing one local record), which yauzl accepts", async () => {
    const b = writeArchive({ entries: [entry("a.md", "first"), entry("b.md", "second")] });
    // Point entry 2 at entry 1's local header: a classic "quine" / overlap bomb building block.
    b.writeUInt32LE(b.readUInt32LE(centralAt(b, 0) + 42), centralAt(b, 1) + 42);
    expect((await yauzlRead(b, false)).ok).toBe(true); // control: yauzl does not notice
    await rejects(b, /Archive entries overlap/);
  });

  it("rejects entry data that runs into the next local header", async () => {
    const b = writeArchive({ entries: [entry("a.md", "first", { method: 0 }), entry("b.md", "second", { method: 0 })] });
    // Grow entry 1's sizes so its data overlaps entry 2.
    for (const at of [centralAt(b, 0) + 20, centralAt(b, 0) + 24]) b.writeUInt32LE(40, at);
    await rejects(b, /overlap/);
  });

  it("rejects a central directory outside the archive, or overlapping the end records", async () => {
    const outside = writeArchive({ entries: [entry("a.md", "x")] });
    outside.writeUInt32LE(outside.length + 10, eocdAt(outside) + 16);
    await rejects(outside, /Central directory lies outside archive bounds/);

    const intoEocd = writeArchive({ entries: [entry("a.md", "x")] });
    intoEocd.writeUInt32LE(intoEocd.readUInt32LE(eocdAt(intoEocd) + 12) + 10, eocdAt(intoEocd) + 12);
    await rejects(intoEocd, /Central directory lies outside archive bounds/);
  });

  it("rejects a central directory that points outside a nested range even when the bytes it names exist in the parent", async () => {
    const inner = writeArchive({ entries: [entry("a.md", "x")] });
    const outer = Buffer.concat([inner, writeArchive({ entries: [entry("decoy.md", "y")] })]);
    // The nested range is just `inner`; make its directory offset point past its end, into the decoy.
    const nested = Buffer.from(outer);
    nested.writeUInt32LE(inner.length + 5, eocdAt(inner) + 16);
    const file = new MemoryFile(nested, { start: 0, end: inner.length });
    await expect(ZipReader.open(new ByteRange(file, 0, inner.length))).rejects.toThrow(/outside archive bounds/);
    expect(file.outOfRange).toBe(0);
  });

  it("rejects comment-length tricks: trailing bytes, and an end-record signature hidden in the comment", async () => {
    const trailing = Buffer.concat([writeArchive({ entries: [entry("a.md", "x")] }), Buffer.from("junk")]);
    await rejects(trailing, /comment length/);
    const fake = writeArchive({ entries: [entry("a.md", "x")] });
    const decoy = Buffer.from(fake.subarray(eocdAt(fake)));
    // A comment that itself contains a plausible end record: the last signature wins and its comment length is wrong.
    const tricked = writeArchive({ entries: [entry("a.md", "x")], comment: decoy });
    expect((await yauzlRead(tricked, false)).ok).toBe(true); // control: yauzl picks the last record and carries on
    await rejects(tricked, /Ambiguous end of central directory/);
  });

  it("rejects entry counts that disagree with the directory bytes, in either direction", async () => {
    const more = writeArchive({ entries: [entry("a.md", "x"), entry("b.md", "y")] });
    for (const at of [8, 10]) more.writeUInt16LE(3, eocdAt(more) + at);
    await rejects(more, /entry count disagrees|signature/);

    const fewer = writeArchive({ entries: [entry("a.md", "x"), entry("b.md", "y")] });
    for (const at of [8, 10]) fewer.writeUInt16LE(1, eocdAt(fewer) + at);
    expect((await yauzlRead(fewer, false)).ok).toBe(true); // control: yauzl silently ignores the hidden entry
    await rejects(fewer, /entry count disagrees/);

    const absurd = writeArchive({ entries: [entry("a.md", "x")] });
    for (const at of [8, 10]) absurd.writeUInt16LE(0xfffe, absurd.length - 22 + at);
    await rejects(absurd, /entry count disagrees/);
  });

  it("rejects ZIP64 lies: markers without a ZIP64 field, a short field, and end records that disagree", async () => {
    const noField = writeArchive({ entries: [entry("a.md", "x")] });
    noField.writeUInt32LE(0xffffffff, centralAt(noField, 0) + 24);
    await rejects(noField, /ZIP64 marker without a ZIP64 extra field/);

    const short = writeArchive({ entries: [entry("a.md", "x", { zip64: true })] });
    // Shrink the central ZIP64 field's declared size from 24 to 8: only the uncompressed size is present.
    const at = centralAt(short, 0);
    const extraStart = at + 46 + short.readUInt16LE(at + 28);
    expect(short.readUInt16LE(extraStart)).toBe(0x0001);
    short.writeUInt16LE(8, extraStart + 2);
    await rejects(short, /ZIP64 extra field does not include|Extra field/);

    const disagree = writeArchive({ entries: [entry("a.md", "x"), entry("b.md", "y")], zip64Eocd: true });
    const e = eocdAt(disagree);
    for (const o of [8, 10]) disagree.writeUInt16LE(1, e + o); // classic count says 1, ZIP64 says 2
    await rejects(disagree, /ZIP64 end of central directory disagrees/);

    const valid = writeArchive({ entries: [entry("a.md", "x", { zip64: true, dataDescriptor: true })], zip64Eocd: true });
    const { zip, entries } = await open(valid);
    expect((await drain(zip, entries[0]!)).toString()).toBe("x");
  });

  it("rejects multi-disk archives (classic and ZIP64)", async () => {
    const classic = writeArchive({ entries: [entry("a.md", "x")] });
    classic.writeUInt16LE(1, eocdAt(classic) + 4);
    await rejects(classic, /Multi-disk/);
    expect((await yauzlRead(classic, false)).ok).toBe(false);

    const cdDisk = writeArchive({ entries: [entry("a.md", "x")] });
    cdDisk.writeUInt16LE(1, eocdAt(cdDisk) + 6);
    await rejects(cdDisk, /Multi-disk/);

    const z64 = writeArchive({ entries: [entry("a.md", "x")], zip64Eocd: true });
    z64.writeUInt32LE(2, eocdAt(z64) - 20 + 16); // locator: total disks = 2
    await rejects(z64, /Multi-disk/);

    const entryDisk = writeArchive({ entries: [entry("a.md", "x")] });
    entryDisk.writeUInt16LE(3, centralAt(entryDisk, 0) + 34);
    await rejects(entryDisk, /Multi-disk/);
  });

  it("rejects a local header whose name disagrees with the central directory, which yauzl accepts", async () => {
    const b = writeArchive({ entries: [entry("safe.md", "x")] });
    b.write("evil.md", 30, "latin1"); // same length, different bytes, in the local header only
    expect((await yauzlRead(b)).ok).toBe(true);
    await rejects(b, /Local file header name disagrees/);

    const longer = writeArchive({ entries: [entry("a.md", "x")] });
    longer.writeUInt16LE(5, 26);
    await rejects(longer, /Local file header name disagrees/);
  });

  it("rejects a local header whose method or encryption flag disagrees with the central directory", async () => {
    const method = writeArchive({ entries: [entry("a.md", "hello", { method: 0 })] });
    method.writeUInt16LE(8, 8);
    await rejects(method, /compression method disagrees/);
    const encFlag = writeArchive({ entries: [entry("a.md", "hello")] });
    encFlag.writeUInt16LE(encFlag.readUInt16LE(6) | 1, 6);
    await rejects(encFlag, /encryption flag disagrees/);
  });

  it("rejects truncated files at every length", async () => {
    const b = writeArchive({ entries: [entry("a.md", "hello ".repeat(50)), entry("b.md", "world", { method: 0 })] });
    for (let n = 0; n < b.length; n++) {
      const file = new MemoryFile(b.subarray(0, n));
      const outcome = await (async () => {
        const zip = await ZipReader.open(ByteRange.of(file));
        const list: ZipEntry[] = [];
        for await (const e of zip.entries()) list.push(e);
        for (const e of list) await drain(zip, e);
      })().then(
        () => "ok",
        (error: unknown) => error,
      );
      expect(outcome, `length ${n}`).toBeInstanceOf(ArchiveRejectedError);
      expect(file.outOfRange).toBe(0);
    }
  });

  it("reports an unsupported method per entry and refuses to read it, without failing the archive", async () => {
    const b = writeArchive({ entries: [entry("bz.md", "data", { method: 12 }), entry("ok.md", "fine")] });
    const { zip, entries } = await open(b);
    expect(entries.map((e) => [e.name, e.compressionMethod])).toEqual([
      ["bz.md", 12],
      ["ok.md", 8],
    ]);
    await expect(drain(zip, entries[0]!)).rejects.toThrow(/Unsupported compression method: 12/);
    expect((await drain(zip, entries[1]!)).toString()).toBe("fine");

    const source = await openArchiveSource(MemoryHost.file("m.zip", b));
    expect(source.entries.map((e) => e.path)).toEqual(["ok.md"]);
    expect(source.rejected).toEqual([expect.objectContaining({ code: "unsupported_compression", sourcePath: "bz.md" })]);
    await source.close();
  });

  it("reports an encrypted entry and refuses to read it; strong encryption rejects the archive like yauzl", async () => {
    const b = writeArchive({ entries: [entry("secret.md", "x", { encrypted: true }), entry("ok.md", "fine")] });
    const { zip, entries } = await open(b);
    expect(entries[0]).toMatchObject({ name: "secret.md", encrypted: true });
    await expect(drain(zip, entries[0]!)).rejects.toThrow(/encrypted/);

    const strong = writeArchive({ entries: [entry("s.md", "x")] });
    for (const at of [6, centralAt(strong, 0) + 8]) strong.writeUInt16LE(strong.readUInt16LE(at) | 0x41, at);
    expect((await yauzlRead(strong, false)).ok).toBe(false);
    await rejects(strong, /Strong encryption/);
  });

  it("verifies CRC-32 and withholds the final chunk of corrupt data", async () => {
    const data = "z".repeat(200_000);
    const b = writeArchive({ entries: [entry("a.md", data, { method: 0 })] });
    b[30 + 4 + 150_000]! ^= 0xff; // corrupt one byte inside the stored data
    const { zip, entries } = await open(b);
    const seen: Uint8Array[] = [];
    await expect(
      (async () => {
        for await (const c of zip.openStream(entries[0]!)) seen.push(c);
      })(),
    ).rejects.toThrow(/CRC-32 mismatch/);
    // The full declared size was never delivered: the last chunk is held back until the CRC matches.
    expect(seen.reduce((n, c) => n + c.length, 0)).toBeLessThan(data.length);
  });

  it("holds inflated output to the declared size (a size lie cannot inflate past it)", async () => {
    const b = writeArchive({ entries: [entry("a.md", "x".repeat(100_000))] });
    for (const at of [22, centralAt(b, 0) + 24]) b.writeUInt32LE(1000, at);
    const { zip, entries } = await open(b);
    let delivered = 0;
    await expect(
      (async () => {
        for await (const c of zip.openStream(entries[0]!)) delivered += c.length;
      })(),
    ).rejects.toThrow(/too many bytes/);
    expect(delivered).toBeLessThanOrEqual(1000);
  });

  it("decodes names exactly like yauzl: CP437, UTF-8, the Unicode Path field, and backslashes", async () => {
    const cp437 = Uint8Array.from([0x80, 0x81, 0x5c, 0x41, 0xe1, 0xff, 0x01, 0x7f]);
    const b = writeArchive({
      entries: [
        { ...entry("", "a"), name: cp437, utf8: false },
        entry("dir\\file.md", "b"),
        { ...entry("", "c"), name: enc("legacy.md"), utf8: false, unicodePath: { name: "ไทย.md", validCrc: true } },
        { ...entry("", "d"), name: enc("kept.md"), utf8: false, unicodePath: { name: "ignored.md", validCrc: false } },
      ],
    });
    const ref = await yauzlRead(b, false);
    const { entries } = await open(b);
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    expect(entries.map((e) => e.name)).toEqual(ref.entries.map((e) => e.name));
    expect(entries.map((e) => e.name)).toEqual(["Çü/Aß\u00a0☺⌂", "dir/file.md", "ไทย.md", "kept.md"]);
  });

  it("reads the unix mode from the external attributes", async () => {
    const b = buildZip([
      { name: "link", data: "target", mode: 0o120777, deflate: false },
      { name: "exec.sh", data: "#!/bin/sh", mode: 0o100755 },
    ]);
    const { entries } = await open(b);
    expect(entries.map((e) => e.mode)).toEqual([0o120777, 0o100755]);
  });
});
