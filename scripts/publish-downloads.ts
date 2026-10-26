/**
 * `node scripts/publish-downloads.ts <dir>`: uploads the desktop installers in <dir> to Cloudflare R2
 * (bucket `thoth-downloads`, https://download.thoth.creaml4tt3.me/), for .github/workflows/release-desktop.yml.
 *
 *   v<version>/<installer>   each file, immutable (cached for a year)
 *   v<version>/SHA256SUMS    `sha256sum -c` format
 *   latest.json              the newest release; the website's download manifest has the same facts. Its `notes` is
 *                            the version's entry on the website's changelog page, the update popup's "What's new"
 *                            link (ADR-0022); CHANGELOG.md must have the version (scripts/release-notes.ts checks it).
 *
 * The version is read from the file names (Tauri names them `Thoth_<version>_...`) and must match
 * apps/desktop/src-tauri/tauri.conf.json. Uploads use the AWS CLI on the runner, whose S3 API R2 speaks;
 * credentials come from the environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, R2_ACCOUNT_ID) and are
 * never printed. `--dry-run` prints the plan without uploading.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { changelogUrl } from "./changelog.ts";

export const BUCKET = "thoth-downloads";
export const PUBLIC_BASE = "https://download.thoth.creaml4tt3.me/";

export interface ReleaseFile {
  platform: "macos" | "windows" | "linux";
  kind: "dmg" | "exe" | "msi" | "appimage" | "deb";
  arch: "universal" | "x64" | "arm64";
  file: string;
  bytes: number;
  sha256: string;
}

export interface Release {
  version: string;
  date: string;
  base: string;
  /** The release notes: `https://thoth.creaml4tt3.me/changelog/#v0-1-3`. */
  notes: string;
  files: ReleaseFile[];
}

const KINDS: { test: RegExp; platform: ReleaseFile["platform"]; kind: ReleaseFile["kind"] }[] = [
  { test: /\.dmg$/, platform: "macos", kind: "dmg" },
  { test: /-setup\.exe$/, platform: "windows", kind: "exe" },
  { test: /\.msi$/, platform: "windows", kind: "msi" },
  { test: /\.AppImage$/, platform: "linux", kind: "appimage" },
  { test: /\.deb$/, platform: "linux", kind: "deb" },
];

/** What a Tauri installer name says: `Thoth_0.1.0_universal.dmg`, `Thoth_0.1.0_x64-setup.exe`, `Thoth_0.1.0_amd64.deb`. */
export function describe(file: string): Omit<ReleaseFile, "bytes" | "sha256"> & { version: string } {
  const match = /^Thoth_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)_(.+)$/.exec(file);
  const kind = KINDS.find((k) => k.test.test(file));
  if (!match || !kind) throw new Error(`not a Thoth installer name: ${file}`);
  const rest = match[2]!;
  const arch = /universal/.test(rest) ? "universal" : /aarch64|arm64/.test(rest) ? "arm64" : /x64|amd64|x86_64/.test(rest) ? "x64" : null;
  if (!arch) throw new Error(`unknown architecture in ${file}`);
  return { version: match[1]!, platform: kind.platform, kind: kind.kind, arch, file };
}

export async function collect(dir: string, today: string): Promise<Release> {
  const names = (await readdir(dir)).filter((n) => KINDS.some((k) => k.test.test(n))).sort();
  if (names.length === 0) throw new Error(`no installers in ${dir}`);
  const files: ReleaseFile[] = [];
  let version: string | undefined;
  for (const name of names) {
    const { version: v, ...info } = describe(name);
    if (version !== undefined && v !== version) throw new Error(`mixed versions: ${version} and ${v}`);
    version = v;
    const bytes = await readFile(join(dir, name));
    files.push({ ...info, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { version: version!, date: today, base: `${PUBLIC_BASE}v${version}/`, notes: changelogUrl(version!), files };
}

export function sha256sums(release: Release): string {
  return release.files.map((f) => `${f.sha256}  ${f.file}\n`).join("");
}

const CONTENT_TYPES: Record<ReleaseFile["kind"], string> = {
  dmg: "application/x-apple-diskimage",
  exe: "application/vnd.microsoft.portable-executable",
  msi: "application/x-msi",
  appimage: "application/vnd.appimage",
  deb: "application/vnd.debian.binary-package",
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) throw new Error("usage: node scripts/publish-downloads.ts <dir> [--dry-run]");
  const release = await collect(dir, new Date().toISOString().slice(0, 10));
  const conf = JSON.parse(await readFile(join(import.meta.dirname, "..", "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8")) as { version: string };
  if (conf.version !== release.version) throw new Error(`installers are ${release.version}, tauri.conf.json says ${conf.version}`);
  await writeFile(join(dir, "SHA256SUMS"), sha256sums(release));
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(release, null, 2)}\n`);
  console.log(JSON.stringify(release, null, 2));
  if (dryRun) return;

  const account = process.env.R2_ACCOUNT_ID;
  if (!account || !/^[0-9a-f]{32}$/.test(account)) throw new Error("R2_ACCOUNT_ID must be the 32-character Cloudflare account ID");
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (the R2 token) are required");
  const endpoint = `https://${account}.r2.cloudflarestorage.com`;
  const put = (local: string, key: string, type: string, cache: string) => {
    execFileSync("aws", ["s3api", "put-object", "--endpoint-url", endpoint, "--bucket", BUCKET, "--key", key, "--body", local, "--content-type", type, "--cache-control", cache], { stdio: ["ignore", "ignore", "inherit"] });
    console.log(`uploaded ${key}`);
  };
  const prefix = `v${release.version}/`;
  for (const f of release.files) {
    // A released file never changes: a fix is a new version.
    put(join(dir, f.file), prefix + f.file, CONTENT_TYPES[f.kind], "public, max-age=31536000, immutable");
  }
  put(join(dir, "SHA256SUMS"), `${prefix}SHA256SUMS`, "text/plain; charset=utf-8", "public, max-age=31536000, immutable");
  // Uploaded last, so it never names a file that is not there yet.
  put(join(dir, "latest.json"), "latest.json", "application/json", "public, max-age=300");
  const sizes = await Promise.all(release.files.map(async (f) => (await stat(join(dir, f.file))).size));
  console.log(`published ${release.files.length} files (${(sizes.reduce((a, b) => a + b, 0) / 1048576).toFixed(1)} MB) at ${release.base}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`publish-downloads: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
