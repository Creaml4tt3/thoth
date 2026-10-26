/**
 * Builds `thoth-mcp` (ADR-0021) for the desktop bundle: Tauri's `externalBin` (`apps/desktop/src-tauri/
 * tauri.sidecar.conf.json`) expects `src-tauri/binaries/thoth-mcp-<target triple>[.exe]`, and puts it next to the
 * app's own program, where Settings → Connected apps points apps to it.
 *
 *   node scripts/build-mcp-sidecar.ts <target triple | universal-apple-darwin>
 *
 * The universal macOS build is the two Apple builds joined with `lipo`, and each is kept under its own name too. The release workflow runs this before
 * `tauri build --config src-tauri/tauri.sidecar.conf.json`.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const BINARIES = join(REPO, "apps", "desktop", "src-tauri", "binaries");

export interface SidecarPlan {
  /** `cargo build` argument lists, one per target. */
  builds: string[][];
  /** The built programs, in the order of `builds`. */
  built: string[];
  /** The file Tauri bundles. */
  output: string;
  /**
   * Each built program under its own target's name: a universal build compiles each architecture on its own, and
   * Tauri's build script looks for that architecture's sidecar then.
   */
  copies: [string, string][];
  /** Join the built programs with `lipo` (universal macOS) instead of copying the one. */
  lipo: boolean;
}

export function sidecarPlan(target: string, targetDir = process.env.CARGO_TARGET_DIR ?? join(REPO, "target")): SidecarPlan {
  if (!/^[a-z0-9_]+(-[a-z0-9_]+){2,3}$/.test(target)) throw new Error(`Not a target triple: ${target}`);
  const targets = target === "universal-apple-darwin" ? ["aarch64-apple-darwin", "x86_64-apple-darwin"] : [target];
  const exe = target.includes("windows") ? ".exe" : "";
  return {
    builds: targets.map((t) => ["build", "--release", "--locked", "-p", "thoth-mcp", "--target", t]),
    built: targets.map((t) => join(targetDir, t, "release", `thoth-mcp${exe}`)),
    output: join(BINARIES, `thoth-mcp-${target}${exe}`),
    copies: targets.map((t) => [join(targetDir, t, "release", `thoth-mcp${exe}`), join(BINARIES, `thoth-mcp-${t}${exe}`)]),
    lipo: targets.length > 1,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/build-mcp-sidecar.ts <target triple | universal-apple-darwin>");
    process.exit(2);
  }
  const plan = sidecarPlan(target);
  for (const args of plan.builds) execFileSync("cargo", args, { cwd: REPO, stdio: "inherit" });
  mkdirSync(BINARIES, { recursive: true });
  for (const [from, to] of plan.copies) copyFileSync(from, to);
  if (plan.lipo) execFileSync("lipo", ["-create", "-output", plan.output, ...plan.built], { stdio: "inherit" });
  console.log(`thoth-mcp → ${plan.output}`);
}
