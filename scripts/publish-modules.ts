/**
 * `node scripts/publish-modules.ts <dir> [--publish]`: prepares, and with --publish signs and uploads, the OCR module
 * (ADR-0055, plan §5a) for .github/workflows/release-ocr.yml.
 *
 * <dir> holds the plain files at their published keys, `<dir>/modules/...`:
 *   modules/ocr/<version>/<target>/{thoth-ocr[.exe], ONNX Runtime library, NOTICE.txt}   program code: changes with the app
 *   modules/models/<id>/<version>/...   model files, as modules/models.json (the list's unsigned source) names them
 *   modules/test/...                    the list's test image
 * Each becomes a `.gz`; the list and runtime.json give the size and SHA-256 of the `.gz` as downloaded. Written to <dir>:
 *   models.json, models.json.sig        the signed model list, uploaded last (5-minute cache) so it never names a
 *                                       file that is not there yet
 *   runtime.json                        the program files per target, compiled into the app
 *                                       (crates/thoth-host/src/modules/runtime.json, committed by a person)
 *
 * Every URL must be under https://download.thothnotes.com/modules/, and the list's serial must be above the published
 * one. The list is signed with THOTH_MODULES_SIGNING_KEY (+ _PASSWORD) through Tauri's signer, as updates are
 * (ADR-0034), with its own key; the key is passed in the environment only and never printed. Uploads use the AWS CLI
 * against R2, with the same environment as publish-downloads.ts.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { BUCKET } from "./publish-downloads.ts";

export const MODULES_BASE = "https://download.thothnotes.com/modules/";
const HOST_ROOT = "https://download.thothnotes.com/";

export interface ModuleFile {
  name: string;
  url: string;
  size: number;
  sha256: string;
  /** Only on these targets (a file for every target when absent). The Intel Mac detectors differ (ADR-0055 Decision 2). */
  targets?: string[];
  executable?: boolean;
}

export interface ModelEntry {
  id: "fast" | "second";
  version: string;
  preset: "openthai" | "pp5";
  minApp: string;
  protocol: number;
  files: ModuleFile[];
}

export interface ModelList {
  serial: number;
  models: ModelEntry[];
  test: { file: ModuleFile; expect: string[] };
}

export interface Runtime {
  version: string;
  protocol: number;
  onnxruntime: string;
  targets: Record<string, ModuleFile[]>;
}

/** The URL itself, refused unless it is a plain https address under download.thothnotes.com/modules/. */
export function checkUrl(url: string): string {
  let href = "";
  try {
    href = new URL(url).href;
  } catch {
    // reported below
  }
  if (href !== url || !url.startsWith(MODULES_BASE)) throw new Error(`${url}: files are hosted only under ${MODULES_BASE}`);
  return url;
}

/** The local file a URL is published from. */
const localOf = (root: string, url: string) => join(root, ...checkUrl(url).slice(HOST_ROOT.length).split("/"));

/** gzip with no name or time in the header, so the same file always gives the same bytes and hash. */
export function gzipTo(src: string, dst: string): void {
  writeFileSync(dst, gzipSync(readFileSync(src), { level: 9 }));
}

function filled(root: string, file: ModuleFile): ModuleFile {
  const gz = readFileSync(localOf(root, file.url));
  return { ...file, size: gz.length, sha256: createHash("sha256").update(gz).digest("hex") };
}

/** The list with each `.gz`'s size and SHA-256 from <root>; refuses a foreign URL or a serial not above `published`. */
export function fillList(list: ModelList, root: string, published: number): ModelList {
  if (!Number.isInteger(list.serial) || list.serial <= published) throw new Error(`serial ${list.serial} must be above the published ${published}`);
  return {
    ...list,
    models: list.models.map((m) => ({ ...m, files: m.files.map((f) => filled(root, f)) })),
    test: { ...list.test, file: filled(root, list.test.file) },
  };
}

/** runtime.json from the `.gz` files under <root>/modules/ocr/<version>/<target>/. */
export function runtimeFor(root: string, version: string, onnxruntime: string, protocol: number): Runtime {
  const dir = join(root, "modules", "ocr", version);
  const targets: Record<string, ModuleFile[]> = {};
  for (const target of readdirSync(dir).sort()) {
    targets[target] = readdirSync(join(dir, target))
      .filter((n) => n.endsWith(".gz"))
      .sort()
      .map((gz) => {
        const name = gz.slice(0, -3);
        const file = filled(root, { name, url: `${MODULES_BASE}ocr/${version}/${target}/${gz}`, size: 0, sha256: "" });
        return /^thoth-ocr(\.exe)?$/.test(name) ? { ...file, executable: true } : file;
      });
  }
  return { version, protocol, onnxruntime, targets };
}

/**
 * What to upload, given what is already published at each key (`null`: nothing there). A published version never
 * changes: apps already shipped pin these files by SHA-256 (runtime.json, the signed list). The same bytes again are
 * skipped; different bytes stop the publish before anything is uploaded. A new program or model is a new version folder.
 */
export function uploadsFor(local: Record<string, string>, published: Record<string, string | null>): string[] {
  const changed = Object.keys(local).filter((k) => published[k] != null && published[k] !== local[k]);
  if (changed.length > 0) throw new Error(`already published with other bytes (bump the version instead): ${changed.join(", ")}`);
  return Object.keys(local).filter((k) => published[k] == null);
}

type Run = (args: string[], env: NodeJS.ProcessEnv) => void;
const runTauri: Run = (args, env) => execFileSync("pnpm", ["--filter", "@thoth/desktop", "exec", "tauri", ...args], { env, stdio: ["ignore", "ignore", "inherit"] });

/** Writes `<file>.sig` with the module list key from `env`; stops before anything runs when the key is missing. */
export function signList(file: string, env: NodeJS.ProcessEnv, run: Run = runTauri): void {
  const key = env.THOTH_MODULES_SIGNING_KEY;
  if (!key) throw new Error("THOTH_MODULES_SIGNING_KEY is missing: the model list would be unsigned");
  const { THOTH_MODULES_SIGNING_KEY: _, THOTH_MODULES_SIGNING_KEY_PASSWORD: password, ...rest } = env;
  run(["signer", "sign", file], { ...rest, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password ?? "" });
}

/** Every plain file under <dir>, as paths relative to it with `/`. */
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const path = join(dir, n);
    return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path).split(sep).join("/")];
  });
}

/** The published list's serial, 0 when there is none yet. */
async function publishedSerial(): Promise<number> {
  const res = await fetch(`${MODULES_BASE}models.json`, { redirect: "error" });
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`reading the published models.json: HTTP ${res.status}`);
  return ((await res.json()) as ModelList).serial;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const publish = args.includes("--publish");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) throw new Error("usage: node scripts/publish-modules.ts <dir> [--publish]");
  // Stops before anything is uploaded (and before the long steps) when the key is missing.
  if (publish && !process.env.THOTH_MODULES_SIGNING_KEY) throw new Error("THOTH_MODULES_SIGNING_KEY is missing: the model list would be unsigned");
  const repo = join(import.meta.dirname, "..");
  const plain = walk(join(dir, "modules")).filter((k) => !k.endsWith(".gz"));
  for (const key of plain) gzipTo(join(dir, "modules", key), join(dir, "modules", `${key}.gz`));

  const source = JSON.parse(readFileSync(join(repo, "modules", "models.json"), "utf8")) as ModelList;
  const list = fillList(source, dir, await publishedSerial());
  const crate = readFileSync(join(repo, "crates", "thoth-ocr", "Cargo.toml"), "utf8");
  const version = /^version = "([^"]+)"/m.exec(crate)?.[1];
  if (!version) throw new Error("no version in crates/thoth-ocr/Cargo.toml");
  const protocols = new Set(list.models.map((m) => m.protocol));
  if (protocols.size !== 1) throw new Error("every model in the list must name the same protocol for this release");
  const runtime = runtimeFor(dir, version, "1.28.0", [...protocols][0]!);
  // Every listed file must have been built and staged: a list naming a missing file would fail every install.
  for (const f of [...list.models.flatMap((m) => m.files), list.test.file, ...Object.values(runtime.targets).flat()]) checkUrl(f.url);
  writeFileSync(join(dir, "models.json"), `${JSON.stringify(list, null, 2)}\n`);
  writeFileSync(join(dir, "runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`);
  console.log(JSON.stringify({ runtime, list }, null, 2));
  if (!publish) return;

  signList(join(dir, "models.json"), process.env);
  const account = process.env.R2_ACCOUNT_ID;
  if (!account || !/^[0-9a-f]{32}$/.test(account)) throw new Error("R2_ACCOUNT_ID must be the 32-character Cloudflare account ID");
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (the R2 token) are required");
  const endpoint = `https://${account}.r2.cloudflarestorage.com`;
  const put = (local: string, key: string, type: string, cache: string) => {
    execFileSync("aws", ["s3api", "put-object", "--endpoint-url", endpoint, "--bucket", BUCKET, "--key", key, "--body", local, "--content-type", type, "--cache-control", cache], { stdio: ["ignore", "ignore", "inherit"] });
    console.log(`uploaded ${key}`);
  };
  // A published version never changes: a new model or program is a new version folder (see uploadsFor).
  const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const local = Object.fromEntries(plain.map((key) => [`modules/${key}.gz`, sha(join(dir, "modules", `${key}.gz`))]));
  const published: Record<string, string | null> = {};
  for (const key of Object.keys(local)) {
    const res = await fetch(`${HOST_ROOT}${key}`, { redirect: "error" });
    if (res.status !== 404 && !res.ok) throw new Error(`reading the published ${key}: HTTP ${res.status}`);
    published[key] = res.status === 404 ? null : createHash("sha256").update(new Uint8Array(await res.arrayBuffer())).digest("hex");
  }
  for (const key of uploadsFor(local, published)) put(join(dir, key), key, "application/gzip", "public, max-age=31536000, immutable");
  put(join(dir, "models.json.sig"), "modules/models.json.sig", "text/plain; charset=utf-8", "public, max-age=300");
  put(join(dir, "models.json"), "modules/models.json", "application/json", "public, max-age=300");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`publish-modules: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
