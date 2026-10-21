/**
 * Generates JSON Schema files in protocol/schemas/ from the Zod schemas that
 * are the runtime-validated source of truth (ADR-002, ADR-004).
 * Run: node scripts/generate-schemas.ts [--check]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PageDocumentSchema } from "@thoth/content";
import { AttachmentSchema, ContentReferenceSchema, ImportWarningSchema, PageSummarySchema, ProvenanceSchema, SpaceSchema, TransferStateSchema } from "@thoth/domain";
import { ImportManifestSchema } from "@thoth/importer-core";
import { PROTOCOL_SCHEMAS } from "@thoth/workspace-protocol";

const OUT = join(import.meta.dirname, "..", "protocol", "schemas");
const schemas: Record<string, z.ZodType> = {
  "page-document.v1": PageDocumentSchema,
  "page-summary.v1": PageSummarySchema,
  "provenance.v1": ProvenanceSchema,
  "content-reference.v1": ContentReferenceSchema,
  "attachment.v1": AttachmentSchema,
  "space.v1": SpaceSchema,
  "transfer-state.v1": TransferStateSchema,
  "import-warning.v1": ImportWarningSchema,
  "import-manifest.v1": ImportManifestSchema,
};

// Workspace protocol schemas (ADR-0004). Generated with io "input" so unknown members stay allowed.
const protocolSchemas = new Map<string, z.ZodType>(PROTOCOL_SCHEMAS.map((entry) => [entry.file, entry.schema]));
const entries: [string, z.ZodType, "input" | "output"][] = [
  ...Object.entries(schemas).map(([name, schema]): [string, z.ZodType, "input" | "output"] => [name, schema, "output"]),
  ...[...protocolSchemas].map(([name, schema]): [string, z.ZodType, "input" | "output"] => [name, schema, "input"]),
];

const check = process.argv.includes("--check");
let stale = 0;
for (const [name, schema, io] of entries) {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any", io });
  const text = JSON.stringify({ $id: `https://thoth.invalid/schemas/${name}.json`, title: name, ...json }, null, 2) + "\n";
  const path = join(OUT, `${name}.json`);
  if (check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== text) {
      console.error(`stale: ${path}`);
      stale++;
    }
  } else await writeFile(path, text);
}
if (stale) process.exit(1);
console.log(check ? "schemas up to date" : `wrote ${entries.length} schemas to protocol/schemas/`);
