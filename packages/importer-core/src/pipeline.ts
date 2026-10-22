import { decodeText, encodeText, FrontmatterError, LinkResolver, parsePage, rewriteTargets, updateFrontmatter, type ParsedReference, type TargetEdit } from "@thoth/content";
import {
  basename,
  collisionKey,
  dirname,
  extname,
  isMarkdownPath,
  isReservedPath,
  isStableId,
  joinVaultPath,
  newStableId,
  normalizeVaultPath,
  relativeLink,
  sha256Hex,
  stripExtension,
  type ImportWarning,
} from "@thoth/domain";
import type { Vault } from "@thoth/local-store";
import { defaultImportRoot, folderExists, importFolderName } from "./folder-name.ts";
import { hashStream } from "./hash.ts";
import {
  IMPORT_STAGING_DIR,
  listManifests,
  loadManifest,
  MANIFEST_VERSION,
  saveManifest,
  type ImportItem,
  type ImportManifest,
  type ImportOptions,
  type LinkStats,
} from "./manifest.ts";
import type { ImportProvider } from "./provider.ts";
import type { ImportSource } from "./source.ts";

/** Top-level metadata folders never imported regardless of provider (compared case-insensitively). */
const ALWAYS_SKIP = new Set([".thoth", ".git"]);


export interface ImportPreview {
  jobId: string;
  sourceLabel: string;
  destinationRoot: string;
  pages: number;
  attachments: number;
  databases: number;
  folders: number;
  skipped: number;
  rejected: ImportWarning[];
  links: LinkStats;
  /** Titles shared by more than one page; never merged (spec §7.2). */
  duplicateTitles: { title: string; sourcePaths: string[] }[];
  /** Items renamed or skipped to avoid destination collisions. */
  collisions: { sourcePath: string; destPath?: string; action: "renamed" | "skipped" }[];
  /** Warning counts by code, for the compatibility report. */
  warningCounts: Record<string, number>;
  /** Earlier completed jobs that imported identical source content. */
  previousImports: { jobId: string; completedAt: string; destinationRoot: string }[];
}

export interface ImportReport {
  jobId: string;
  state: ImportManifest["state"];
  imported: { pages: number; attachments: number; databases: number };
  skipped: number;
  failed: { sourcePath: string; error: string }[];
  links: LinkStats | undefined;
  warnings: ImportWarning[];
  warningCounts: Record<string, number>;
}

export type ImportPhase = "staging" | "verifying" | "committing";

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { phase: ImportPhase; done: number; total: number }) => void;
  /** Test hook: called after each committed item, to simulate crashes. */
  afterCommitItem?: (item: ImportItem) => void | Promise<void>;
}

export class ImportCancelledError extends Error {
  constructor() {
    super("Import cancelled");
    this.name = "ImportCancelledError";
  }
}

/** What link resolution needs from a page. Page text is never retained across files. */
interface PageLinkInfo {
  rel: string;
  aliases: readonly string[];
}

/** Planning keeps these facts per page instead of its text (spec §7.1 step 4). */
interface PageFacts extends PageLinkInfo {
  /** Absent for pages that are not valid UTF-8 (imported byte-for-byte). */
  doc?: {
    references: ParsedReference[];
    frontmatterError?: string;
    thothId?: string;
    title?: string;
  };
  /** Provider analysis warnings, applied only if the page is not skipped. */
  analysis: ImportWarning[];
}

/** Strips the shared wrapper prefix from a source path. */
function relPath(manifest: Pick<ImportManifest, "sourceRootPrefix">, sourcePath: string): string {
  return sourcePath.slice(manifest.sourceRootPrefix.length);
}

function countWarnings(warnings: readonly ImportWarning[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const w of warnings) counts[w.code] = (counts[w.code] ?? 0) + 1;
  return counts;
}

function allWarnings(manifest: ImportManifest): ImportWarning[] {
  return [...manifest.warnings, ...manifest.items.flatMap((i) => i.warnings)];
}

function fingerprint(items: { sourcePath: string; sourceHash: string }[]): string {
  return sha256Hex(items.map((i) => `${i.sourcePath}\0${i.sourceHash}`).join("\n"));
}

/** Appends " 2", " 3", … before the extension until the key is free. */
function withSuffix(path: string, n: number): string {
  const ext = extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  return `${stem} ${n}${ext}`;
}

/** Text for pages that can be edited losslessly (BOM kept); undefined for non-UTF-8. */
function decodePage(bytes: Uint8Array): string | undefined {
  const decoded = decodeText(bytes);
  return decoded.editable ? decoded.text : undefined;
}

function pageFacts(provider: ImportProvider, rel: string, sourcePath: string, bytes: Uint8Array): PageFacts {
  const text = decodePage(bytes);
  if (text === undefined) return { rel, aliases: [], analysis: [] };
  const doc = parsePage(rel, text);
  const title = doc.frontmatter["title"];
  return {
    rel,
    aliases: doc.aliases,
    doc: {
      references: doc.references,
      ...(doc.frontmatterError ? { frontmatterError: doc.frontmatterError } : {}),
      ...(doc.thothId !== undefined ? { thothId: doc.thothId } : {}),
      ...(typeof title === "string" ? { title } : {}),
    },
    analysis: provider.analyzePage(doc, sourcePath),
  };
}

/**
 * Re-reads one entry and checks it against the hash recorded at plan time, so
 * content that changed after planning is never converted or staged.
 */
async function readVerified(source: ImportSource, item: ImportItem): Promise<Uint8Array> {
  const raw = await source.read(item.sourcePath);
  if (sha256Hex(raw) !== item.sourceHash) throw new Error("Source file changed since the import was planned; not imported");
  return raw;
}

// ------------------------------------------------------------------- planning

export interface PlanInput {
  vault: Vault;
  source: ImportSource;
  provider: ImportProvider;
  options?: Partial<ImportOptions>;
  jobId?: string;
  now?: () => number;
}

/**
 * Scans and validates a source and produces a manifest plus preview.
 * Writes nothing to the vault (spec §7.1 step 4).
 */
export async function planImport(input: PlanInput): Promise<{ manifest: ImportManifest; preview: ImportPreview }> {
  const { vault, source, provider } = input;
  const now = input.now ?? Date.now;
  const jobId = input.jobId ?? newStableId(now());
  const options: ImportOptions = {
    destinationRoot: input.options?.destinationRoot ?? (await defaultImportRoot(folderExists((dir) => vault.fs.list(dir)), importFolderName(source.label, provider.system, now()))),
    conflictPolicy: input.options?.conflictPolicy ?? "rename",
    addIdentityFrontmatter: input.options?.addIdentityFrontmatter ?? true,
  };
  const destinationRoot = options.destinationRoot === "" ? "" : normalizeVaultPath(options.destinationRoot);
  if (isReservedPath(destinationRoot)) throw new Error("Cannot import into .thoth/");
  options.destinationRoot = destinationRoot;

  const warnings: ImportWarning[] = [...source.rejected];
  const usable = source.entries.filter((e) => {
    const top = e.path.split("/")[0]!;
    if (ALWAYS_SKIP.has(collisionKey(top))) {
      warnings.push({ code: "skipped_metadata", severity: "info", message: `Skipped ${top}/ metadata`, sourcePath: e.path });
      return false;
    }
    return true;
  });
  const prefix = provider.rootPrefix?.(usable.map((e) => e.path)) ?? "";
  const classified = provider.classify(usable.map((e) => ({ ...e, path: e.path.slice(prefix.length) })));

  // Hash every entry so resume and duplicate-import detection are content-based.
  // Memory stays O(largest file): pages and database CSVs are read one at a time
  // and only their parsed facts are kept; every other file is hashed by streaming.
  const items: ImportItem[] = [];
  const facts = new Map<string, PageFacts>();
  const fileWarnings = new Map<string, ImportWarning[]>();
  for (const c of classified) {
    const sourcePath = prefix + c.sourcePath;
    let digest: { hash: string; size: number };
    if (c.kind === "page") {
      const bytes = await source.read(sourcePath);
      digest = { hash: sha256Hex(bytes), size: bytes.length };
      facts.set(sourcePath, pageFacts(provider, c.sourcePath, sourcePath, bytes));
    } else if (c.kind === "database" && provider.analyzeFile) {
      const bytes = await source.read(sourcePath);
      digest = { hash: sha256Hex(bytes), size: bytes.length };
      fileWarnings.set(sourcePath, provider.analyzeFile(sourcePath, bytes));
    } else {
      digest = await hashStream(source.openReadStream(sourcePath));
    }
    items.push({
      key: `${provider.system}:${sourcePath}`,
      sourcePath,
      kind: c.kind,
      ...(c.relDest !== undefined ? { destPath: c.relDest } : {}),
      sourceHash: digest.hash,
      size: digest.size,
      ...(c.sourceId !== undefined ? { sourceId: c.sourceId } : {}),
      state: c.kind === "skipped" ? "skipped" : "pending",
      warnings: c.warnings ?? [],
    });
  }

  // Destination paths: deterministic order, case-insensitive collision handling.
  const existing = new Set((await vault.scanFiles()).files.map(collisionKey));
  const taken = new Set<string>();
  const collisions: ImportPreview["collisions"] = [];
  const sorted = [...items].sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : 1));
  for (const item of sorted) {
    if (item.state === "skipped" || item.destPath === undefined) continue;
    const base = joinVaultPath(destinationRoot, normalizeVaultPath(item.destPath));
    if (isReservedPath(base)) {
      // Thoth metadata inside an archive (at any depth, any case) is never imported.
      item.state = "skipped";
      delete item.destPath;
      item.warnings.push({ code: "reserved_path", severity: "warning", message: "Skipped: path is inside a .thoth/ metadata folder", sourcePath: item.sourcePath });
      continue;
    }
    let candidate = base;
    let n = 1;
    while (taken.has(collisionKey(candidate)) || existing.has(collisionKey(candidate))) {
      if (existing.has(collisionKey(candidate)) && options.conflictPolicy === "skip") break;
      candidate = withSuffix(base, ++n);
    }
    if (existing.has(collisionKey(candidate))) {
      item.state = "skipped";
      delete item.destPath;
      item.warnings.push({ code: "destination_exists", severity: "warning", message: `Skipped: ${base} already exists`, sourcePath: item.sourcePath });
      collisions.push({ sourcePath: item.sourcePath, action: "skipped" });
      continue;
    }
    if (candidate !== base) {
      item.warnings.push({ code: "renamed_on_collision", severity: "info", message: `Renamed to ${basename(candidate)} to avoid a name collision`, sourcePath: item.sourcePath });
      collisions.push({ sourcePath: item.sourcePath, destPath: candidate, action: "renamed" });
    }
    taken.add(collisionKey(candidate));
    item.destPath = candidate;
  }

  // A destination used as both a file and a folder (e.g. "notes" and "notes/x.md")
  // can never be committed; skip the file and report it instead of failing later.
  const dirKeys = new Set<string>();
  for (const item of items) {
    if (item.state === "skipped" || item.destPath === undefined) continue;
    const parts = item.destPath.split("/");
    for (let i = 1; i < parts.length; i++) dirKeys.add(collisionKey(parts.slice(0, i).join("/")));
  }
  const existingDirs = new Set<string>();
  for (const f of (await vault.scanFiles()).files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) existingDirs.add(collisionKey(parts.slice(0, i).join("/")));
  }
  for (const item of items) {
    if (item.state === "skipped" || item.destPath === undefined) continue;
    const key = collisionKey(item.destPath);
    const parts = item.destPath.split("/");
    const parentIsFile = parts.slice(1).some((_, i) => existing.has(collisionKey(parts.slice(0, i + 1).join("/"))));
    if (dirKeys.has(key) || existingDirs.has(key) || parentIsFile) {
      item.state = "skipped";
      item.warnings.push({ code: "file_folder_conflict", severity: "warning", message: `Skipped: ${item.destPath} is needed both as a file and as a folder`, sourcePath: item.sourcePath });
      delete item.destPath;
    }
  }

  const manifest: ImportManifest = {
    manifestVersion: MANIFEST_VERSION,
    jobId,
    system: provider.system,
    sourceKind: provider.sourceKind,
    sourceLabel: source.label,
    sourceLocation: source.location,
    sourceFingerprint: fingerprint(items),
    sourceRootPrefix: prefix,
    options,
    state: "planned",
    createdAt: new Date(now()).toISOString(),
    updatedAt: new Date(now()).toISOString(),
    items,
    warnings,
  };

  // Assign IDs, collect analysis warnings, and preview links from the facts gathered above.
  const pages = new Map<string, PageLinkInfo>();
  const existingIds = new Set((await vault.listPages()).map((p) => p.id));
  const seenIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== "page" || item.state === "skipped") continue;
    const info = facts.get(item.sourcePath)!;
    pages.set(item.sourcePath, info);
    if (!info.doc) {
      item.warnings.push({ code: "invalid_utf8", severity: "warning", message: "Not valid UTF-8; imported byte-for-byte without link rewriting", sourcePath: item.sourcePath });
    } else {
      if (info.doc.frontmatterError)
        item.warnings.push({ code: "malformed_frontmatter", severity: "warning", message: `Frontmatter could not be parsed and is imported verbatim: ${info.doc.frontmatterError}`, sourcePath: item.sourcePath });
      item.warnings.push(...info.analysis);
    }
    if (info.doc?.frontmatterError || !info.doc) {
      // Identity cannot be written without rewriting unparseable content (ADR-001); the index assigns a provisional ID.
      if (manifest.options.addIdentityFrontmatter)
        item.warnings.push({ code: "identity_not_written", severity: "info", message: "No thoth_id written because the file could not be safely edited; it is indexed with a provisional ID", sourcePath: item.sourcePath });
      continue;
    }
    const sourceThothId = info.doc.thothId;
    if (sourceThothId && isStableId(sourceThothId) && !existingIds.has(sourceThothId) && !seenIds.has(sourceThothId)) item.pageId = sourceThothId;
    else item.pageId = newStableId(now());
    seenIds.add(item.pageId);
  }
  for (const item of items) {
    if (item.kind === "database" && item.state !== "skipped") item.warnings.push(...(fileWarnings.get(item.sourcePath) ?? []));
  }
  const links = await linkContext(manifest, pages, vault);
  const linkStats = emptyLinkStats();
  for (const item of links.active) {
    const doc = item.kind === "page" ? facts.get(item.sourcePath)?.doc : undefined;
    if (!doc) continue;
    const result = planLinks(links, item, relPath(manifest, item.sourcePath), doc.references);
    for (const key of Object.keys(linkStats) as (keyof LinkStats)[]) linkStats[key] += result.stats[key];
    item.warnings.push(...result.warnings);
  }
  manifest.links = linkStats;

  const titles = new Map<string, string[]>();
  const titleNames = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "page" || item.state === "skipped") continue;
    // Destination name, not source name: provider-specific ID suffixes are already stripped.
    const fmTitle = facts.get(item.sourcePath)?.doc?.title;
    const title = fmTitle?.trim() ? fmTitle.trim() : stripExtension(basename(item.destPath ?? item.sourcePath));
    titles.set(collisionKey(title), [...(titles.get(collisionKey(title)) ?? []), item.sourcePath]);
    if (!titleNames.has(collisionKey(title))) titleNames.set(collisionKey(title), title);
  }
  const previous = (await listManifests(vault.fs)).filter((m) => m.state === "completed" && m.sourceFingerprint === manifest.sourceFingerprint);
  const active = items.filter((i) => i.state !== "skipped");
  const preview: ImportPreview = {
    jobId,
    sourceLabel: source.label,
    destinationRoot,
    pages: active.filter((i) => i.kind === "page").length,
    attachments: active.filter((i) => i.kind === "attachment").length,
    databases: active.filter((i) => i.kind === "database").length,
    folders: new Set(active.map((i) => dirname(relPath(manifest, i.sourcePath))).filter(Boolean)).size,
    skipped: items.length - active.length,
    rejected: [...source.rejected],
    links: linkStats,
    duplicateTitles: [...titleNames.entries()].filter(([key]) => titles.get(key)!.length > 1).map(([key, title]) => ({ title, sourcePaths: titles.get(key)! })),
    collisions,
    warningCounts: countWarnings(allWarnings(manifest)),
    previousImports: previous.map((m) => ({ jobId: m.jobId, completedAt: m.updatedAt, destinationRoot: m.options.destinationRoot })),
  };
  return { manifest, preview };
}

// ----------------------------------------------------------------- conversion

interface LinkContext {
  /** Items that will have a destination (resolution targets). */
  active: ImportItem[];
  destBySource: Map<string, string>;
  sourceResolver: LinkResolver;
  destResolver: LinkResolver;
}

function emptyLinkStats(): LinkStats {
  return { total: 0, resolved: 0, rewritten: 0, unresolved: 0, ambiguous: 0, external: 0 };
}

/**
 * Resolvers over the complete source file set (never per-file) and the
 * destination vault. Built from paths and aliases only, so no page text is held.
 */
async function linkContext(manifest: ImportManifest, pages: Map<string, PageLinkInfo>, vault: Vault): Promise<LinkContext> {
  const active = manifest.items.filter((i) => i.state !== "skipped" && i.destPath !== undefined);
  const destBySource = new Map(active.map((i) => [relPath(manifest, i.sourcePath), i.destPath!]));
  const sourceResolver = new LinkResolver(
    manifest.items.map((i) => relPath(manifest, i.sourcePath)),
    [...pages.values()].map((p) => ({ path: p.rel, aliases: p.aliases })),
  );
  const vaultFiles = (await vault.scanFiles()).files;
  const vaultPages = await vault.listPages();
  const destResolver = new LinkResolver(
    [...vaultFiles, ...destBySource.values()],
    [
      ...vaultPages.map((p) => ({ path: p.path, aliases: p.aliases })),
      ...[...pages.values()].flatMap((p) => (destBySource.has(p.rel) ? [{ path: destBySource.get(p.rel)!, aliases: p.aliases }] : [])),
    ],
  );
  return { active, destBySource, sourceResolver, destResolver };
}

/**
 * Maps one page's links to destination paths and decides which to rewrite:
 * only links whose meaning would otherwise change (spec §7.3, §9.3).
 */
function planLinks(ctx: LinkContext, item: ImportItem, rel: string, references: readonly ParsedReference[]): { edits: TargetEdit[]; warnings: ImportWarning[]; stats: LinkStats } {
  const destPath = item.destPath!;
  const stats = emptyLinkStats();
  const warnings: ImportWarning[] = [];
  const edits: TargetEdit[] = [];
  for (const ref of references) {
    stats.total++;
    const result = ctx.sourceResolver.resolve(rel, ref);
    if (result.state === "external") {
      stats.external++;
      continue;
    }
    if (result.state === "ambiguous") {
      stats.ambiguous++;
      warnings.push({ code: "ambiguous_link", severity: "warning", message: `Link "${ref.rawTarget}" matches ${result.candidates.length} files (${result.candidates.join(", ")}); left unchanged`, sourcePath: item.sourcePath, line: ref.range.startLine });
      continue;
    }
    const targetDest = result.state === "resolved" ? ctx.destBySource.get(result.path) : undefined;
    if (result.state === "unresolved" || targetDest === undefined) {
      stats.unresolved++;
      warnings.push({ code: "unresolved_link", severity: "warning", message: `Link target "${ref.rawTarget}" was not found in the import; left unchanged`, sourcePath: item.sourcePath, line: ref.range.startLine });
      continue;
    }
    stats.resolved++;
    if (ref.target === "") continue; // same-page fragment
    if (ref.syntax === "wikilink" || ref.syntax === "embed") {
      const still = ctx.destResolver.resolve(destPath, ref);
      if (still.state === "resolved" && still.path === targetDest) continue;
      const newTarget = isMarkdownPath(targetDest) ? stripExtension(targetDest) : targetDest;
      if (/[[\]|#\n]/.test(newTarget)) {
        stats.unresolved++;
        warnings.push({ code: "link_not_rewritable", severity: "warning", message: `Link "${ref.rawTarget}" could not be rewritten to ${targetDest}`, sourcePath: item.sourcePath, line: ref.range.startLine });
        continue;
      }
      edits.push({ reference: ref, newTarget });
    } else {
      const newTarget = relativeLink(destPath, targetDest);
      if (newTarget === ref.target) continue;
      edits.push({ reference: ref, newTarget });
    }
    stats.rewritten++;
  }
  return { edits, warnings, stats };
}

/**
 * Converts one page from its verified source bytes: rewrites links and adds
 * identity frontmatter. Untouched pages are staged from the original bytes,
 * not re-encoded; non-UTF-8 pages are copied byte-for-byte.
 */
function convertPage(manifest: ImportManifest, ctx: LinkContext, item: ImportItem, raw: Uint8Array): Uint8Array {
  const original = decodePage(raw);
  if (original === undefined) return raw;
  const rel = relPath(manifest, item.sourcePath);
  const { edits } = planLinks(ctx, item, rel, parsePage(rel, original).references);
  let text = edits.length > 0 ? rewriteTargets(original, edits) : original;
  if (manifest.options.addIdentityFrontmatter && item.pageId) {
    // Malformed frontmatter never reaches here: such items have no pageId.
    try {
      const provenance = { system: manifest.system, sourcePath: rel, ...(item.sourceId ? { sourceId: item.sourceId } : {}), importJobId: manifest.jobId };
      text = updateFrontmatter(text, { thoth_id: item.pageId, thoth_source: provenance });
    } catch (error) {
      if (!(error instanceof FrontmatterError)) throw error;
    }
  }
  return text === original ? raw : encodeText(text);
}

// ------------------------------------------------------------------ execution

function stagingPath(jobId: string, index: number): string {
  return `${IMPORT_STAGING_DIR}/${jobId}/${index}.bin`;
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportCancelledError();
}

/**
 * Runs (or resumes) an import: stage → verify → commit → report.
 * Idempotent per job: items already staged or committed are verified by hash
 * and never duplicated. The source is only ever read.
 */
export async function runImport(vault: Vault, source: ImportSource, manifest: ImportManifest, options: RunOptions = {}): Promise<ImportReport> {
  const { signal } = options;
  const touch = async (state?: ImportManifest["state"]) => {
    if (state) manifest.state = state;
    manifest.updatedAt = new Date().toISOString();
    await saveManifest(vault.fs, manifest);
    await vault.sql.run("INSERT OR REPLACE INTO import_jobs (id, source_kind, state, updated_at) VALUES (?, ?, ?, ?)", [manifest.jobId, manifest.sourceKind, manifest.state, Date.now()]);
  };

  try {
    if (manifest.state === "completed") return buildReport(manifest);
    await vault.fs.mkdirp(`${IMPORT_STAGING_DIR}/${manifest.jobId}`);
    await touch("staging");

    // Link context: aliases of every page so links resolve exactly as planned.
    // Pages are read and verified one at a time; no text is kept.
    const pages = new Map<string, PageLinkInfo>();
    const changed = new Map<string, string>();
    for (const item of manifest.items) {
      if (item.kind !== "page" || item.state === "skipped") continue;
      checkCancelled(signal);
      const rel = relPath(manifest, item.sourcePath);
      let aliases: readonly string[] = [];
      try {
        const text = decodePage(await readVerified(source, item));
        if (text !== undefined) aliases = parsePage(rel, text).aliases;
      } catch (error) {
        changed.set(item.sourcePath, (error as Error).message);
      }
      pages.set(item.sourcePath, { rel, aliases });
    }
    const links = await linkContext(manifest, pages, vault);

    // Stage: convert and write every pending item into .thoth staging, one file in memory at a time.
    const work = manifest.items.map((item, index) => ({ item, index })).filter(({ item }) => item.state !== "skipped" && item.state !== "committed");
    let done = 0;
    for (const { item, index } of work) {
      checkCancelled(signal);
      if (item.state === "staged" && item.stagedHash) {
        const existing = await vault.fs.stat(stagingPath(manifest.jobId, index));
        if (existing) {
          options.onProgress?.({ phase: "staging", done: ++done, total: work.length });
          continue;
        }
      }
      try {
        const earlier = changed.get(item.sourcePath);
        if (earlier !== undefined) throw new Error(earlier);
        // Convert only from bytes that match the planned hash; the staged file derives from exactly these bytes.
        const raw = await readVerified(source, item);
        const bytes = item.kind === "page" ? convertPage(manifest, links, item, raw) : raw;
        await vault.fs.writeFile(stagingPath(manifest.jobId, index), bytes);
        item.stagedHash = sha256Hex(bytes);
        item.state = "staged";
        delete item.error;
      } catch (error) {
        if (error instanceof ImportCancelledError) throw error;
        item.state = "failed";
        item.error = (error as Error).message;
      }
      options.onProgress?.({ phase: "staging", done: ++done, total: work.length });
    }
    await touch("staged");

    // Verify: staged bytes match recorded hashes.
    done = 0;
    for (const { item, index } of work) {
      if (item.state !== "staged") continue;
      checkCancelled(signal);
      const bytes = await vault.fs.readFile(stagingPath(manifest.jobId, index));
      if (sha256Hex(bytes) !== item.stagedHash) {
        item.state = "failed";
        item.error = "Staged file failed hash verification";
      }
      options.onProgress?.({ phase: "verifying", done: ++done, total: work.length });
    }

    // Commit: atomic no-replace rename from staging into the vault.
    await touch("committing");
    done = 0;
    for (const { item, index } of work) {
      if (item.state !== "staged") continue;
      checkCancelled(signal);
      const dest = item.destPath!;
      await vault.fs.mkdirp(dirname(dest));
      try {
        await vault.fs.rename(stagingPath(manifest.jobId, index), dest, { noReplace: true });
        item.state = "committed";
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
        // Already committed before a crash? Accept only an identical file.
        const existing = sha256Hex(await vault.fs.readFile(dest));
        if (existing === item.stagedHash) {
          await vault.fs.remove(stagingPath(manifest.jobId, index));
          item.state = "committed";
        } else {
          item.state = "failed";
          item.error = `Destination ${dest} was created by something else during the import; not overwritten`;
        }
      }
      if (done % 25 === 0) await touch();
      await options.afterCommitItem?.(item);
      options.onProgress?.({ phase: "committing", done: ++done, total: work.length });
    }

    await vault.fs.remove(`${IMPORT_STAGING_DIR}/${manifest.jobId}`);
    await touch(manifest.items.some((i) => i.state === "failed") ? "failed" : "completed");
    await vault.reconcile();
    return buildReport(manifest);
  } catch (error) {
    if (error instanceof ImportCancelledError) {
      await touch("cancelled");
      await vault.reconcile();
      return buildReport(manifest);
    }
    await touch();
    throw error;
  }
}

/** Resumes a job from its durable manifest (after a crash or cancellation). */
export async function resumeImport(vault: Vault, jobId: string, source: ImportSource, options: RunOptions = {}): Promise<ImportReport> {
  const manifest = await loadManifest(vault.fs, jobId);
  if (manifest.state === "failed") {
    for (const item of manifest.items) if (item.state === "failed") item.state = "pending";
  }
  return runImport(vault, source, manifest, options);
}

export function buildReport(manifest: ImportManifest): ImportReport {
  const committed = manifest.items.filter((i) => i.state === "committed");
  const warnings = allWarnings(manifest);
  return {
    jobId: manifest.jobId,
    state: manifest.state,
    imported: {
      pages: committed.filter((i) => i.kind === "page").length,
      attachments: committed.filter((i) => i.kind === "attachment").length,
      databases: committed.filter((i) => i.kind === "database").length,
    },
    skipped: manifest.items.filter((i) => i.state === "skipped").length,
    failed: manifest.items.filter((i) => i.state === "failed").map((i) => ({ sourcePath: i.sourcePath, error: i.error ?? "unknown error" })),
    links: manifest.links,
    warnings,
    warningCounts: countWarnings(warnings),
  };
}
