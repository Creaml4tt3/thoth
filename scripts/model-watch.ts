/**
 * The weekly OCR model watch (ADR-0055, .github/workflows/model-watch.yml). For each Hugging Face repo a listed model
 * comes from: is there a newer commit that changes a file the model uses? If so the workflow stages that revision,
 * reads tools/ocr-spike/corpus with it and with the listed one, and opens a pull request that switches the model only
 * when its oCER is no worse on every image group. Nothing here signs or uploads: release-ocr.yml does, after a person
 * merges.
 *
 *   node scripts/model-watch.ts check                 → JSON {changed:[…]} (no newer model: an empty list)
 *   node scripts/model-watch.ts apply <check.json>    → edits the pinned revisions and version names, serial + 1
 *   node scripts/model-watch.ts read <exe> <models> <preset> <out.jsonl>   → the corpus through thoth-ocr
 *   node scripts/model-watch.ts decide <base.txt> <cand.txt>                → the table; exit 0 propose, 3 not
 *
 * shortcut: a new OpenThai release in a new repo (e.g. OpenThai2.2-…) is not seen; add it to WATCHED when iApp names one.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelList } from "./publish-modules.ts";

const HF = "https://huggingface.co";

export interface Watched {
  model: "fast" | "second";
  repo: string;
  /** The revision scripts/ocr/stage-models.sh pins (a test checks they agree). */
  revision: string;
  /** The files the model uses; a commit that changes none of them (a README) is not a new model. */
  files: string[];
}

export const WATCHED: Watched[] = [
  { model: "fast", repo: "iapp/OpenThai2.1-OCR-Text-20261118", revision: "c765cb8017c406ddc2a518de51db22bb2e2bbd07", files: ["det.onnx", "rec.onnx", "rec2.onnx", "rec_dict.txt", "config.json"] },
  { model: "second", repo: "PaddlePaddle/th_PP-OCRv5_mobile_rec_onnx", revision: "1d4adbbafb1034a2fd6618498575b81ea7b69f69", files: ["inference.onnx", "inference.yml"] },
  { model: "second", repo: "PaddlePaddle/PP-OCRv5_mobile_det_onnx", revision: "e6f4fa85f00e168c862bc462aebca69eef9b3d3d", files: ["inference.onnx"] },
];

/** A file in a repo tree, as the Hub's tree API gives it. */
export interface TreeEntry {
  path: string;
  oid: string;
  lfs?: { oid: string } | null;
}

/** True when a file the model uses differs (or appeared or went) between the two trees. */
export function modelChanged(pinned: readonly TreeEntry[], latest: readonly TreeEntry[], files: readonly string[]): boolean {
  const id = (tree: readonly TreeEntry[], path: string) => {
    const e = tree.find((t) => t.path === path);
    return e ? (e.lfs?.oid ?? e.oid) : null;
  };
  return files.some((f) => id(pinned, f) !== id(latest, f));
}

/** oCER per image group (percent) from score.py's summary lines for every language ("all"). */
export function parseScores(output: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of output.matchAll(/^\S+\s+(\S+)\s+all\s+items=\s*\d+\s+CER=\s*[\d.]+%\s+oCER=\s*([\d.]+)%$/gm)) out[m[1]!] = Number(m[2]);
  return out;
}

/** Proposes only when the candidate is no worse on every group the listed model was scored on. */
export function decide(base: Record<string, number>, candidate: Record<string, number>): { propose: boolean; table: string } {
  const groups = Object.keys(base).sort();
  const rows = groups.map((g) => {
    const c = candidate[g];
    const ok = c !== undefined && c <= base[g]! + 1e-9;
    return { g, b: base[g]!, c, ok };
  });
  const propose = groups.length > 0 && rows.every((r) => r.ok);
  const table = ["| Group | Listed oCER | New oCER | |", "|---|---:|---:|---|", ...rows.map((r) => `| ${r.g} | ${r.b.toFixed(2)} % | ${r.c === undefined ? "missing" : `${r.c.toFixed(2)} %`} | ${r.ok ? "no worse" : "**worse**"} |`)].join("\n");
  return { propose, table };
}

export interface Change {
  model: "fast" | "second";
  repo: string;
  from: string;
  to: string;
  /** The new commit's date, YYYYMMDD: the new version name ends with it. */
  date: string;
}

/** The new version name: the listed one with its date replaced, e.g. openthai-2.1-20261118 → openthai-2.1-20270102. */
export function nextVersion(version: string, date: string): string {
  if (!/-\d{8}$/.test(version)) throw new Error(`${version}: no date to replace`);
  return version.replace(/-\d{8}$/, `-${date}`);
}

/**
 * Applies the changes to the sources: the model list (version names in the entry and its URLs, serial + 1), the
 * revisions stage-models.sh pins, and the version folders stage-models.sh and release-ocr.yml use. Sizes and hashes in
 * the list stay empty: release-ocr fills them when it publishes. models.lock is rewritten by staging with RELOCK=1.
 */
export function applyChanges(texts: { list: string; stage: string; release: string }, changes: readonly Change[]): { list: string; stage: string; release: string; versions: Record<string, [string, string]> } {
  const list = JSON.parse(texts.list) as ModelList;
  let { stage, release } = texts;
  const versions: Record<string, [string, string]> = {};
  for (const c of changes) stage = stage.replaceAll(c.from, c.to);
  for (const model of new Set(changes.map((c) => c.model))) {
    const entry = list.models.find((m) => m.id === model);
    if (!entry) throw new Error(`no ${model} model in the list`);
    const date = changes.filter((c) => c.model === model).map((c) => c.date).sort().at(-1)!;
    const next = nextVersion(entry.version, date);
    versions[model] = [entry.version, next];
    entry.files = entry.files.map((f) => ({ ...f, url: f.url.replace(`/${entry.version}/`, `/${next}/`), size: 0, sha256: "" }));
    stage = stage.replaceAll(entry.version, next);
    release = release.replaceAll(entry.version, next);
    entry.version = next;
  }
  list.serial += 1;
  return { list: `${JSON.stringify(list, null, 2)}\n`, stage, release, versions };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function check(): Promise<Change[]> {
  const changed: Change[] = [];
  for (const w of WATCHED) {
    const head = await getJson<{ sha: string; lastModified: string }>(`${HF}/api/models/${w.repo}/revision/main`);
    if (head.sha === w.revision) continue;
    const [pinned, latest] = await Promise.all([getJson<TreeEntry[]>(`${HF}/api/models/${w.repo}/tree/${w.revision}`), getJson<TreeEntry[]>(`${HF}/api/models/${w.repo}/tree/${head.sha}`)]);
    if (!modelChanged(pinned, latest, w.files)) continue;
    changed.push({ model: w.model, repo: w.repo, from: w.revision, to: head.sha, date: head.lastModified.slice(0, 10).replaceAll("-", "") });
  }
  return changed;
}

/** Reads every corpus file through thoth-ocr; one JSONL line {id, text} per image or PDF page, as score.py reads. */
function readCorpus(exe: string, models: string, preset: string, out: string): void {
  const corpus = join(import.meta.dirname, "..", "tools", "ocr-spike", "corpus");
  const manifest = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8")) as { file: string }[];
  const lines: string[] = [];
  for (const file of [...new Set(manifest.map((m) => m.file))]) {
    const bytes = readFileSync(join(corpus, file));
    const pdf = file.endsWith(".pdf");
    const header = JSON.stringify(pdf ? { op: "pdf", len: bytes.length, maxPages: 50 } : { op: "image", len: bytes.length });
    const run = spawnSync(exe, ["serve", "--models", models, "--preset", preset], { input: Buffer.concat([Buffer.from(`${header}\n`), bytes]), maxBuffer: 64 << 20 });
    for (const line of run.stdout.toString("utf8").split("\n").filter(Boolean)) {
      const o = JSON.parse(line) as { page?: number; text?: string };
      if (o.page !== undefined) lines.push(JSON.stringify({ id: pdf ? `${file}#${o.page}` : file, text: o.text ?? "" }));
    }
  }
  writeFileSync(out, `${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const repo = join(import.meta.dirname, "..");
  if (command === "check") {
    console.log(JSON.stringify({ changed: await check() }, null, 2));
  } else if (command === "apply") {
    const changes = (JSON.parse(readFileSync(args[0]!, "utf8")) as { changed: Change[] }).changed;
    const paths = { list: join(repo, "modules", "models.json"), stage: join(repo, "scripts", "ocr", "stage-models.sh"), release: join(repo, ".github", "workflows", "release-ocr.yml") };
    const next = applyChanges({ list: readFileSync(paths.list, "utf8"), stage: readFileSync(paths.stage, "utf8"), release: readFileSync(paths.release, "utf8") }, changes);
    for (const key of ["list", "stage", "release"] as const) writeFileSync(paths[key], next[key]);
    // The revisions models.lock names in its header (its hashes are rewritten by staging with RELOCK=1), and WATCHED
    // here: next week's check starts from the new revision.
    for (const file of [join(repo, "tools", "ocr-spike", "models.lock"), join(repo, "scripts", "model-watch.ts")]) {
      writeFileSync(file, changes.reduce((text, c) => text.replaceAll(c.from, c.to), readFileSync(file, "utf8")));
    }
    console.log(JSON.stringify(next.versions));
  } else if (command === "read") {
    const [exe, models, preset, out] = args;
    readCorpus(exe!, models!, preset!, out!);
  } else if (command === "decide") {
    const result = decide(parseScores(readFileSync(args[0]!, "utf8")), parseScores(readFileSync(args[1]!, "utf8")));
    console.log(result.table);
    process.exit(result.propose ? 0 : 3);
  } else {
    throw new Error("usage: node scripts/model-watch.ts check | apply <check.json> | read <exe> <models> <preset> <out.jsonl> | decide <base.txt> <cand.txt>");
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`model-watch: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
