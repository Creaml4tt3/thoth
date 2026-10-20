import { z } from "zod";
import { ImportItemStateSchema, ImportJobStateSchema, ImportSourceKindSchema, ImportWarningSchema } from "@thoth/domain";
import type { VaultFs } from "@thoth/local-store";

/**
 * Durable import manifest (ADR-010). Lives in `.thoth/manifests/` so job
 * state, ID assignments, and provenance survive index loss and crashes.
 * It never contains page content.
 */
export const MANIFEST_VERSION = 1;
export const MANIFEST_DIR = ".thoth/manifests";
export const IMPORT_STAGING_DIR = ".thoth/operations/imports";

export const ImportItemKindSchema = z.enum(["page", "attachment", "database", "skipped"]);
export type ImportItemKind = z.infer<typeof ImportItemKindSchema>;

export const ImportItemSchema = z.object({
  /** Deterministic idempotency key: system + normalized source path. */
  key: z.string(),
  sourcePath: z.string(),
  kind: ImportItemKindSchema,
  destPath: z.string().optional(),
  sourceHash: z.string(),
  size: z.number().int().nonnegative(),
  /** Thoth ID assigned at plan time and reused on resume. */
  pageId: z.string().optional(),
  /** ID recovered from the source system (e.g. Notion 32-hex). */
  sourceId: z.string().optional(),
  state: ImportItemStateSchema,
  stagedHash: z.string().optional(),
  warnings: z.array(ImportWarningSchema),
  error: z.string().optional(),
});
export type ImportItem = z.infer<typeof ImportItemSchema>;

export const ImportOptionsSchema = z.object({
  /** Vault folder that receives the import; "" imports into the vault root. */
  destinationRoot: z.string(),
  conflictPolicy: z.enum(["rename", "skip"]),
  /** Write `thoth_id` / `thoth_source` frontmatter into imported pages (ADR-003). */
  addIdentityFrontmatter: z.boolean(),
});
export type ImportOptions = z.infer<typeof ImportOptionsSchema>;

export const LinkStatsSchema = z.object({
  total: z.number().int(),
  resolved: z.number().int(),
  rewritten: z.number().int(),
  unresolved: z.number().int(),
  ambiguous: z.number().int(),
  external: z.number().int(),
});
export type LinkStats = z.infer<typeof LinkStatsSchema>;

export const ImportManifestSchema = z.object({
  manifestVersion: z.literal(MANIFEST_VERSION),
  jobId: z.string(),
  system: z.enum(["notion", "obsidian"]),
  sourceKind: ImportSourceKindSchema,
  sourceLabel: z.string(),
  sourceLocation: z.string(),
  /** sha256 over sorted (path, hash) pairs; detects re-imports of the same source. */
  sourceFingerprint: z.string(),
  /** Leading folder stripped from every source path (zipped vault folder, Notion export wrapper). */
  sourceRootPrefix: z.string(),
  options: ImportOptionsSchema,
  state: ImportJobStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  items: z.array(ImportItemSchema),
  warnings: z.array(ImportWarningSchema),
  links: LinkStatsSchema.optional(),
});
export type ImportManifest = z.infer<typeof ImportManifestSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function manifestPath(jobId: string): string {
  return `${MANIFEST_DIR}/import-${jobId}.json`;
}

/** Atomic manifest write: temp file + rename. */
export async function saveManifest(fs: VaultFs, manifest: ImportManifest): Promise<void> {
  const path = manifestPath(manifest.jobId);
  const temp = `${path}.tmp`;
  await fs.mkdirp(MANIFEST_DIR);
  await fs.writeFile(temp, encoder.encode(JSON.stringify(manifest, null, 2)));
  await fs.rename(temp, path);
}

export async function loadManifest(fs: VaultFs, jobId: string): Promise<ImportManifest> {
  return ImportManifestSchema.parse(JSON.parse(decoder.decode(await fs.readFile(manifestPath(jobId)))));
}

export async function listManifests(fs: VaultFs): Promise<ImportManifest[]> {
  if (!(await fs.stat(MANIFEST_DIR))) return [];
  const result: ImportManifest[] = [];
  for (const entry of await fs.list(MANIFEST_DIR)) {
    if (entry.kind !== "file" || !/^import-.+\.json$/.test(entry.name)) continue;
    const parsed = ImportManifestSchema.safeParse(JSON.parse(decoder.decode(await fs.readFile(`${MANIFEST_DIR}/${entry.name}`))));
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}
