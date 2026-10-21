import { resolve } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ByteRange, ZipReader, type ZipEntry } from "@thoth/importer-core";
import { MemoryFile } from "../helpers/memory-host.ts";
import { buildZip, dirEntries } from "../helpers/zip.ts";
import { mutate, randomArchive, writeArchive } from "../helpers/zip-gen.ts";
import { yauzlRead, type OracleResult } from "../helpers/yauzl-oracle.ts";

/**
 * Differential tests: the portable reader against yauzl, over fixtures, 300+
 * seeded random valid archives and 300+ seeded mutations of them.
 */
type Outcome = { ok: true; entries: { entry: ZipEntry; content: { ok: true; data: Buffer } | { ok: false; error: string } }[] } | { ok: false; error: string };

const TIME_LIMIT_MS = 5_000;

async function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`HANG: ${what}`)), TIME_LIMIT_MS)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads every entry with the portable reader over an instrumented file. Never rejects except on a hang. */
async function portableRead(file: MemoryFile, range: ByteRange = ByteRange.of(file)): Promise<Outcome> {
  let zip: ZipReader;
  const entries: ZipEntry[] = [];
  try {
    zip = await ZipReader.open(range);
    for await (const e of zip.entries()) entries.push(e);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const out: Extract<Outcome, { ok: true }>["entries"] = [];
  for (const entry of entries) {
    if (entry.isDirectory || entry.encrypted || (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)) {
      out.push({ entry, content: { ok: false, error: "not read" } });
      continue;
    }
    try {
      const parts: Uint8Array[] = [];
      for await (const chunk of zip.openStream(entry)) {
        expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
        parts.push(chunk);
      }
      out.push({ entry, content: { ok: true, data: Buffer.concat(parts) } });
    } catch (error) {
      out.push({ entry, content: { ok: false, error: (error as Error).message } });
    }
  }
  return { ok: true, entries: out };
}

function expectSameAsYauzl(ours: Outcome, theirs: OracleResult, context: string): void {
  expect(theirs.ok, `${context}: yauzl should read a valid archive (${theirs.ok ? "" : theirs.error})`).toBe(true);
  expect(ours.ok, `${context}: portable reader failed (${ours.ok ? "" : ours.error})`).toBe(true);
  if (!ours.ok || !theirs.ok) return;
  expect(ours.entries.map(({ entry }) => entry.name)).toEqual(theirs.entries.map((e) => e.name));
  for (const [i, { entry, content }] of ours.entries.entries()) {
    const ref = theirs.entries[i]!;
    expect({ mode: entry.mode, method: entry.compressionMethod, encrypted: entry.encrypted, size: entry.uncompressedSize, compressed: entry.compressedSize }, `${context}: ${entry.name}`).toEqual({
      mode: ref.mode,
      method: ref.method,
      encrypted: ref.encrypted,
      size: ref.uncompressedSize,
      compressed: ref.compressedSize,
    });
    expect(content.ok, `${context}: ${entry.name} readable`).toBe(ref.content.ok);
    if (content.ok && ref.content.ok) expect(content.data.equals(ref.content.data), `${context}: ${entry.name} content`).toBe(true);
  }
}

describe("portable ZIP reader matches yauzl on valid archives", () => {
  it.each([
    ["notion-export", "Export-0f0e0d0c-0b0a-4908-8706-050403020100/"],
    ["obsidian-vault", "Vault/"],
  ])("over the %s fixture (STORED and DEFLATE)", async (fixture, prefix) => {
    const entries = await dirEntries(resolve(import.meta.dirname, "../fixtures", fixture), prefix);
    for (const deflate of [true, false]) {
      const zip = buildZip(entries.map((e) => ({ ...e, deflate })));
      const file = new MemoryFile(zip);
      expectSameAsYauzl(await portableRead(file), await yauzlRead(zip), `${fixture} deflate=${deflate}`);
      expect(file.outOfRange).toBe(0);
    }
  });

  it("over 320 seeded random archives (STORED/DEFLATE, data descriptors, ZIP64, UTF-8/CP437/Unicode Path names, empty files, directories)", { timeout: 120_000 }, async () => {
    const features = { zip64Entries: 0, zip64Eocd: 0, descriptors: 0, cp437: 0, unicodePath: 0, empty: 0, dirs: 0, deflate: 0, stored: 0, encrypted: 0, otherMethod: 0, big: 0 };
    for (let seed = 1; seed <= 320; seed++) {
      const archive = randomArchive(seed);
      for (const e of archive.entries) {
        if (e.zip64) features.zip64Entries++;
        if (e.dataDescriptor) features.descriptors++;
        if (!e.utf8) features.cp437++;
        if (e.unicodePath) features.unicodePath++;
        if (e.data.length === 0) features.empty++;
        if (e.name[e.name.length - 1] === 0x2f) features.dirs++;
        if (e.method === 8) features.deflate++;
        else if (e.method === 0) features.stored++;
        else features.otherMethod++;
        if (e.encrypted) features.encrypted++;
        if (e.data.length > 64 * 1024) features.big++;
      }
      if (archive.zip64Eocd) features.zip64Eocd++;
      const zip = writeArchive(archive);
      const file = new MemoryFile(zip);
      const ours = await withTimeout(portableRead(file), `seed ${seed}`);
      expectSameAsYauzl(ours, await yauzlRead(zip), `seed ${seed}`);
      expect(file.outOfRange, `seed ${seed}`).toBe(0);
    }
    console.info(`[zip-differential] 320 random archives; feature counts ${JSON.stringify(features)}`);
    for (const [feature, n] of Object.entries(features)) expect(n, feature).toBeGreaterThan(0);
  });
});

describe("portable ZIP reader on corrupted archives", () => {
  it("over 360 seeded mutations: never hangs, never reads outside its range, and returns only CRC-verified content (none where yauzl rejects the archive unless CRC-verified)", { timeout: 300_000 }, async () => {
    const tally = { mutations: 0, bothRejectedArchive: 0, oursRejectedYauzlRead: 0, bothRead: 0, entriesReturned: 0, entriesRefused: 0, byKind: {} as Record<string, number> };
    for (let seed = 1; seed <= 360; seed++) {
      let archive = randomArchive(10_000 + seed);
      if (archive.entries.length === 0) archive = randomArchive(20_000 + seed);
      const valid = writeArchive(archive);
      const { kind, bytes } = mutate(valid, seed);
      tally.mutations++;
      tally.byKind[kind] = (tally.byKind[kind] ?? 0) + 1;

      // Embed the mutated archive in the middle of a larger file and read it through a sub-range,
      // so any read outside the range is visible (as for a nested part read in place).
      const pad = 777;
      const host = Buffer.concat([Buffer.alloc(pad, 0x50), bytes, Buffer.alloc(pad, 0x4b)]);
      const file = new MemoryFile(host, { start: pad, end: pad + bytes.length });
      const ours = await withTimeout(portableRead(file, new ByteRange(file, pad, bytes.length)), `mutation ${seed} (${kind})`);
      expect(file.outOfRange, `mutation ${seed} (${kind}) read outside its range`).toBe(0);

      const theirs = await yauzlRead(bytes);
      if (!ours.ok) {
        if (theirs.ok) tally.oursRejectedYauzlRead++;
        else tally.bothRejectedArchive++;
        continue;
      }
      // Anything we return must be CRC-valid for the entry's declared CRC and exactly its declared size.
      for (const { entry, content } of ours.entries) {
        if (!content.ok) {
          tally.entriesRefused++;
          continue;
        }
        tally.entriesReturned++;
        expect(crc32(content.data) >>> 0, `mutation ${seed}: ${entry.name} CRC`).toBe(entry.crc32);
        expect(content.data.length).toBe(entry.uncompressedSize);
      }
      // Where yauzl rejects the archive, we may still open it, but only with CRC-verified entries (checked above).
      if (!theirs.ok) continue;
      tally.bothRead++;
      // Where both open it, every entry we return must also be readable by yauzl with identical bytes.
      const byIndex = theirs.entries;
      for (const [i, { entry, content }] of ours.entries.entries()) {
        if (!content.ok) continue;
        const ref = byIndex[i];
        expect(ref?.name, `mutation ${seed}: entry ${i} name`).toBe(entry.name);
        if (ref?.content.ok) expect(content.data.equals(ref.content.data), `mutation ${seed}: ${entry.name} content`).toBe(true);
      }
    }
    console.info(`[zip-mutations] ${JSON.stringify(tally)}`);
    expect(tally.mutations).toBeGreaterThanOrEqual(300);
  });
});
