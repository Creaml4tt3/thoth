/**
 * Builds the API for Vercel as a prebuilt Build Output API v3 directory (docs/deploy/trial.md §3):
 *
 *   apps/server/.vercel/output/config.json            routes everything to one function, plus the daily cron
 *   apps/server/.vercel/output/functions/index.func/  the bundled server (src/vercel.ts), Node 24
 *
 * The server and the workspace packages it imports are TypeScript, which Node refuses to strip below
 * node_modules, so the function is one bundled file instead of the workspace layout. Deploy it with
 * `vercel deploy --prebuilt --prod` from apps/server. The function region is `sin1`, next to the Neon database.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "rolldown";

const SERVER = join(import.meta.dirname, "..");
const OUTPUT = join(SERVER, ".vercel", "output");
const FUNCTION = join(OUTPUT, "functions", "index.func");

await rm(OUTPUT, { recursive: true, force: true });
await mkdir(FUNCTION, { recursive: true });
await build({
  input: join(SERVER, "src", "vercel.ts"),
  platform: "node",
  // pg loads its optional native binding only when asked; it is not installed.
  external: ["pg-native"],
  output: { file: join(FUNCTION, "index.cjs"), format: "cjs", exports: "default", minify: false, sourcemap: false },
  logLevel: "warn",
});
await writeFile(
  join(FUNCTION, ".vc-config.json"),
  `${JSON.stringify({ runtime: "nodejs24.x", handler: "index.cjs", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: 30, regions: ["sin1"] }, null, 2)}\n`,
);
await writeFile(
  join(OUTPUT, "config.json"),
  `${JSON.stringify({ version: 3, routes: [{ src: "/(.*)", dest: "/index" }], crons: [{ path: "/internal/maintenance", schedule: "0 20 * * *" }] }, null, 2)}\n`,
);
console.log(`Built ${OUTPUT}`);
