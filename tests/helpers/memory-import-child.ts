/**
 * Child process for the memory smoke test: imports a Notion ZIP into a fresh
 * vault and reports the peak of heapUsed + arrayBuffers.
 * Usage: node memory-import-child.ts <zip> <vaultRoot> <tempRoot>
 */
import { planImport, runImport } from "@thoth/importer-core";
import { openZipSource } from "@thoth/importer-core/node";
import { notionProvider } from "@thoth/importer-notion";
import { openNodeVault } from "@thoth/local-store/node";

const [zipPath, vaultRoot, tempRoot] = process.argv.slice(2) as [string, string, string];
let peak = 0;
const phasePeaks: Record<string, number> = {};
let phase = "open";
const sample = () => {
  const m = process.memoryUsage();
  const used = m.heapUsed + m.arrayBuffers;
  peak = Math.max(peak, used);
  phasePeaks[phase] = Math.max(phasePeaks[phase] ?? 0, used);
};
const timer = setInterval(sample, 1);
const baseline = process.memoryUsage();

const started = Date.now();
const { vault } = await openNodeVault(vaultRoot);
const source = await openZipSource(zipPath, {}, { tempRoot });
sample();
phase = "plan";
const { manifest } = await planImport({ vault, source, provider: notionProvider(), options: { destinationRoot: "Big" } });
sample();
phase = "run";
const report = await runImport(vault, source, manifest);
sample();
await source.close();
await vault.close();
clearInterval(timer);

process.stdout.write(
  JSON.stringify({
    peak,
    phasePeaks,
    baseline: baseline.heapUsed + baseline.arrayBuffers,
    ms: Date.now() - started,
    state: report.state,
    imported: report.imported,
    failed: report.failed.length,
    totalBytes: manifest.items.reduce((n, i) => n + i.size, 0),
  }),
);
