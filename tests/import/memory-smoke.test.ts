import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeStoredMultiPart, type BigEntry } from "../helpers/big-zip.ts";

/**
 * Coarse memory smoke test (implementation-plan §5 item 11): a ≥ 300 MB
 * multi-part Notion export of STORED parts is imported in a child process,
 * and the child's peak heapUsed + arrayBuffers must stay far below the export
 * size. Set THOTH_SKIP_MEMORY_SMOKE=1 to skip it on very slow machines.
 */
const run = promisify(execFile);
const CHILD = resolve(import.meta.dirname, "../helpers/memory-import-child.ts");
const MiB = 1024 * 1024;
const PARTS = 3;
const FILES_PER_PART = 13;
const FILE_SIZE = 8 * MiB;
const PEAK_LIMIT = 200 * MiB;

const hex = (n: number) => n.toString(16).padStart(32, "0");

let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "thoth-memsmoke-"));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe.skipIf(process.env["THOTH_SKIP_MEMORY_SMOKE"] === "1")("memory smoke test", () => {
  it("imports a 300+ MB multi-part export with peak heap + arrayBuffers under 200 MB", { timeout: 120_000 }, async () => {
    const parts = Array.from({ length: PARTS }, (_, p) => {
      const title = `Part ${p}`;
      const id = hex(p + 1);
      const links = Array.from({ length: FILES_PER_PART }, (_, k) => `![f${k}](${encodeURIComponent(title)}/file-${k}.bin)`).join("\n");
      const entries: BigEntry[] = [
        { name: `${title} ${id}.md`, text: `# ${title}\n\n${links}\n` },
        ...Array.from({ length: FILES_PER_PART }, (_, k) => ({ name: `${title}/file-${k}.bin`, size: FILE_SIZE, seed: p * 100 + k })),
      ];
      return { name: `Export-0f0e0d0c-0b0a-4908-8706-050403020100-Part-${p + 1}.zip`, entries };
    });
    const zip = join(work, "big.zip");
    const zipBytes = await writeStoredMultiPart(zip, parts);
    expect(zipBytes).toBeGreaterThan(300 * MiB);
    const tempRoot = join(work, "tmp");
    await mkdir(tempRoot);

    const { stdout } = await run(process.execPath, [CHILD, zip, join(work, "vault"), tempRoot], { maxBuffer: 1024 * 1024, timeout: 110_000 });
    const result = JSON.parse(stdout) as { peak: number; phasePeaks: Record<string, number>; baseline: number; ms: number; state: string; imported: unknown; failed: number; totalBytes: number };
    console.info(
      `[memory-smoke] export ${(zipBytes / MiB).toFixed(0)} MiB, imported ${(result.totalBytes / MiB).toFixed(0)} MiB in ${result.ms} ms; ` +
        `peak heapUsed+arrayBuffers ${(result.peak / MiB).toFixed(1)} MiB (baseline ${(result.baseline / MiB).toFixed(1)} MiB; ` +
        Object.entries(result.phasePeaks).map(([k, v]) => `${k} ${(v / MiB).toFixed(1)}`).join(", ") +
        ")",
    );
    expect(result.state).toBe("completed");
    expect(result.failed).toBe(0);
    expect(result.imported).toEqual({ pages: PARTS, attachments: PARTS * FILES_PER_PART, databases: 0 });
    expect(result.totalBytes).toBeGreaterThan(300 * MiB);
    expect(result.peak).toBeLessThan(PEAK_LIMIT);
    // STORED parts are read in place: nothing was extracted to temp.
    expect(await readdir(tempRoot)).toEqual([]);
    expect((await stat(join(work, "vault", "Big", "Part 0", "file-0.bin"))).size).toBe(FILE_SIZE);
  });
});
