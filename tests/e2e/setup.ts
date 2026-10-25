/**
 * Builds what the e2e scenario runs: the desktop UI (Vite), a browser bundle of
 * the bridge transport, and the Rust host harness.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { REPO, buildHarness } from "../ports/harness.ts";

export const DIST = join(REPO, "apps", "desktop", "dist");
/** Kept outside `dist` so the test-only bridge can never be packaged into the app. */
export const BRIDGE_DIR = join(REPO, "tests", ".tmp", "e2e-bridge");

export async function buildAll(): Promise<{ dist: string; bridgeDir: string; binary: string }> {
  // Built once by `global-setup.ts`; rebuilding here would rewrite files other workers are serving.
  if (process.env.THOTH_E2E_PREBUILT === "1") return { dist: DIST, bridgeDir: BRIDGE_DIR, binary: await buildHarness() };
  const desktop = join(REPO, "apps", "desktop");
  execFileSync("pnpm", ["exec", "vite", "build", "--logLevel", "warn"], { cwd: desktop, stdio: "inherit" });
  // The bridge transport as a standalone ES module served at /__bridge__.js (test-only; never part of the app bundle).
  const script = `import { build } from "vite";
await build({ configFile: false, logLevel: "warn", build: { outDir: ${JSON.stringify(BRIDGE_DIR)}, emptyOutDir: true, target: "es2022", lib: { entry: ${JSON.stringify(join(REPO, "packages/platform/src/http.ts"))}, formats: ["es"], fileName: () => "__bridge__.js" } } });`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: desktop, stdio: "inherit" });
  return { dist: DIST, bridgeDir: BRIDGE_DIR, binary: await buildHarness() };
}
