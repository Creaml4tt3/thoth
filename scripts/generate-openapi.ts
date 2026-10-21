/**
 * Generates protocol/openapi.yaml (OpenAPI 3.1) from the workspace-protocol route
 * registry and Zod schemas (ADR-0004). Output is deterministic.
 * Run: node scripts/generate-openapi.ts [--check]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderOpenApiYaml } from "@thoth/workspace-protocol";

// THOTH_OPENAPI_PATH lets tests point the drift check at a scratch file.
const PATH = process.env.THOTH_OPENAPI_PATH ?? join(import.meta.dirname, "..", "protocol", "openapi.yaml");
const text = renderOpenApiYaml();

if (process.argv.includes("--check")) {
  const current = await readFile(PATH, "utf8").catch(() => "");
  if (current !== text) {
    console.error(`stale: ${PATH} (run: pnpm openapi)`);
    process.exit(1);
  }
  console.log("openapi.yaml up to date");
} else {
  await writeFile(PATH, text);
  console.log(`wrote ${PATH}`);
}
