/**
 * Context staging (ADR-0007 rule 4): copies of exactly the pages and folders the user selected, plus the
 * attachments those pages link to, go into the run's empty working directory at their vault paths, so relative links
 * still resolve there. Each file is read once and hashed from the same bytes that are copied; the manifest of
 * (path, hash) is what review compares against and what apply's compare-and-swap expects.
 */
import { dirname, isMarkdownPath, isReservedPath, normalizeVaultPath, sha256Hex } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";
import type { AgentFiles } from "./host.ts";

export interface ContextEntry {
  path: string;
  /** sha256 of the bytes copied into the working directory. */
  hash: string;
  size: number;
  kind: "page" | "file";
  /** Why it is there: picked by the user, inside a picked folder, or an attachment a picked page links to. */
  via: "selected" | "folder" | "linked";
}

export interface StagingLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_STAGING_LIMITS: StagingLimits = { maxFiles: 2000, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 };

export type StagingProblem =
  | { code: "empty" }
  | { code: "not_found"; path: string }
  | { code: "reserved"; path: string }
  | { code: "too_many"; count: number; limit: number }
  | { code: "file_too_large"; path: string; size: number; limit: number }
  | { code: "too_large"; size: number; limit: number };

export class StagingError extends Error {
  readonly problem: StagingProblem;

  constructor(problem: StagingProblem) {
    super(`Cannot prepare the agent's context: ${problem.code}${"path" in problem ? ` (${problem.path})` : ""}`);
    this.name = "StagingError";
    this.problem = problem;
  }
}

/**
 * The files a selection stands for, without reading them. `selection` holds vault paths of pages, other files or
 * folders. Unknown and reserved paths are refused rather than skipped, so the user never gets less than they picked
 * without being told.
 */
export async function resolveContext(vault: Vault, selection: readonly string[]): Promise<{ path: string; via: ContextEntry["via"] }[]> {
  if (selection.length === 0) throw new StagingError({ code: "empty" });
  const { files } = await vault.scanFiles();
  const known = new Set(files);
  const picked = new Map<string, ContextEntry["via"]>();
  for (const raw of selection) {
    const path = normalizeVaultPath(raw);
    if (isReservedPath(path)) throw new StagingError({ code: "reserved", path });
    if (known.has(path)) {
      picked.set(path, "selected");
      continue;
    }
    const inside = files.filter((f) => f.startsWith(`${path}/`));
    if (inside.length === 0) throw new StagingError({ code: "not_found", path });
    for (const file of inside) if (!picked.has(file)) picked.set(file, "folder");
  }
  // Attachments a picked page links to or embeds, wherever they are (pages it links to are not added: only what
  // was picked). Links are the index's, so a page whose links did not resolve brings nothing extra.
  for (const [path] of [...picked]) {
    if (!isMarkdownPath(path)) continue;
    const links = await vault.outgoingLinks(path).catch(() => []);
    for (const link of links) {
      const target = link.targetPath;
      if (link.resolution !== "resolved" || !target || isMarkdownPath(target) || picked.has(target) || !known.has(target)) continue;
      picked.set(target, "linked");
    }
  }
  return [...picked].map(([path, via]) => ({ path, via })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Copies the selection into an empty working directory and returns the manifest. */
export async function stageContext(vault: Vault, files: AgentFiles, selection: readonly string[], limits: StagingLimits = DEFAULT_STAGING_LIMITS): Promise<ContextEntry[]> {
  const planned = await resolveContext(vault, selection);
  if (planned.length > limits.maxFiles) throw new StagingError({ code: "too_many", count: planned.length, limit: limits.maxFiles });
  let total = 0;
  for (const item of planned) {
    const stat = await vault.fs.stat(item.path);
    if (!stat || stat.kind !== "file") throw new StagingError({ code: "not_found", path: item.path });
    if (stat.size > limits.maxFileBytes) throw new StagingError({ code: "file_too_large", path: item.path, size: stat.size, limit: limits.maxFileBytes });
    total += stat.size;
  }
  if (total > limits.maxTotalBytes) throw new StagingError({ code: "too_large", size: total, limit: limits.maxTotalBytes });

  const manifest: ContextEntry[] = [];
  const made = new Set<string>();
  for (const item of planned) {
    const bytes = await vault.fs.readFile(item.path);
    if (bytes.length > limits.maxFileBytes) throw new StagingError({ code: "file_too_large", path: item.path, size: bytes.length, limit: limits.maxFileBytes });
    const dir = dirname(item.path);
    if (dir !== "" && !made.has(dir)) {
      await files.mkdirp(dir);
      made.add(dir);
    }
    await files.writeFile(item.path, bytes);
    manifest.push({ path: item.path, hash: sha256Hex(bytes), size: bytes.length, kind: isMarkdownPath(item.path) ? "page" : "file", via: item.via });
  }
  return manifest;
}
