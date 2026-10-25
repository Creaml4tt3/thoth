/**
 * Review of what an agent left in its working directory (ADR-0007 rule 5). Agent output is untrusted input: the
 * directory is walked through the host's scoped file API, never by path, and anything that could not be applied
 * safely is reported with a reason instead of being offered:
 *
 * - names that are not safe vault paths, anything under a `.thoth` folder (any letter case);
 * - symlinks and special files (never followed, never read);
 * - files over the size limit; pages (`.md`) that are not valid UTF-8;
 * - more entries than the walk limit;
 * - anything under the read-only folder of workspace pages (`read_only`): a change there is shown and discarded, and
 *   never offered, applied or kept as a copy.
 *
 * Each change compares the agent's bytes with the staged manifest: modified, added or deleted. The page as it is in
 * the vault now is read for the diff; if it no longer has the staged hash, the change is marked `stale` (applying it
 * will be a conflict, never an overwrite).
 */
import { decodeText } from "@thoth/content";
import { collisionKey, isMarkdownPath, isReservedPath, normalizeVaultPath, sha256Hex } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";
import type { AgentFiles } from "./host.ts";
import type { ContextEntry } from "./staging.ts";

export type ChangeKind = "modified" | "added" | "deleted";

export type ChangeProblem = "unsafe_path" | "reserved" | "symlink" | "special_file" | "too_large" | "not_utf8" | "too_many" | "unreadable" | "read_only";

export interface ProposedChange {
  path: string;
  change: ChangeKind;
  /** A Markdown page (diffed as text) rather than another file. */
  page: boolean;
  /** The staged hash (modified, deleted); null for added. */
  beforeHash: string | null;
  /** The agent's bytes (modified, added); null for deleted or when unreadable. */
  afterHash: string | null;
  afterSize: number | null;
  /** Why this change cannot be applied; such changes cannot be approved. */
  problem?: ChangeProblem;
  /** The vault file no longer has the staged hash (or was removed): applying would conflict. */
  stale: boolean;
  /** Page text for the diff: the vault's current page (the staged one unless `stale`) and the agent's (`after` is null for a deleted page). */
  before?: string | null;
  after?: string | null;
}

export interface ReviewLimits {
  maxFileBytes: number;
  maxEntries: number;
  maxDepth: number;
}

export const DEFAULT_REVIEW_LIMITS: ReviewLimits = { maxFileBytes: 32 * 1024 * 1024, maxEntries: 10_000, maxDepth: 64 };

interface Found {
  path: string;
  problem?: ChangeProblem;
}

/** Every entry under the working directory that is not a directory, with problems for what cannot be used. */
async function walk(files: AgentFiles, limits: ReviewLimits): Promise<{ found: Found[]; overflow: boolean }> {
  const found: Found[] = [];
  let seen = 0;
  let overflow = false;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (overflow) return;
    for (const entry of await files.list(dir)) {
      if (++seen > limits.maxEntries) {
        overflow = true;
        return;
      }
      const raw = dir === "" ? entry.name : `${dir}/${entry.name}`;
      let path: string;
      try {
        path = normalizeVaultPath(raw);
      } catch {
        found.push({ path: raw, problem: "unsafe_path" });
        continue;
      }
      if (isReservedPath(path)) {
        found.push({ path, problem: "reserved" });
        continue;
      }
      if (entry.kind === "directory") {
        if (depth >= limits.maxDepth) found.push({ path, problem: "too_many" });
        else await visit(path, depth + 1);
      } else if (entry.kind === "file") {
        if (entry.name !== ".DS_Store") found.push({ path });
      } else {
        found.push({ path, problem: entry.kind === "symlink" ? "symlink" : "special_file" });
      }
    }
  };
  await visit("", 0);
  return { found, overflow };
}

/** The top level folders that hold read-only reference copies (workspace pages), compared case-insensitively. */
export function readOnlyRoots(context: readonly ContextEntry[]): Set<string> {
  return new Set(context.filter((c) => c.readOnly).map((c) => collisionKey(c.path.split("/")[0]!)));
}

async function vaultText(vault: Vault, path: string): Promise<{ hash: string | null; text: string | null }> {
  const stat = await vault.fs.stat(path);
  if (!stat || stat.kind !== "file") return { hash: null, text: null };
  const bytes = await vault.fs.readFile(path);
  return { hash: sha256Hex(bytes), text: decodeText(bytes).text };
}

/** The agent's proposed changes, in path order. Unchanged files are left out. */
export async function collectChanges(vault: Vault, files: AgentFiles, context: readonly ContextEntry[], limits: ReviewLimits = DEFAULT_REVIEW_LIMITS): Promise<ProposedChange[]> {
  const staged = new Map(context.map((c) => [c.path, c]));
  const roots = readOnlyRoots(context);
  const underReadOnly = (path: string): boolean => roots.has(collisionKey(path.split("/")[0]!));
  const { found, overflow } = await walk(files, limits);
  const changes: ProposedChange[] = [];
  const present = new Set<string>();

  for (const item of found) {
    present.add(item.path);
    const before = staged.get(item.path);
    const base: Omit<ProposedChange, "change"> = { path: item.path, page: isMarkdownPath(item.path), beforeHash: before?.hash ?? null, afterHash: null, afterSize: null, stale: false };
    const readOnly = underReadOnly(item.path);
    // Anything under the read-only folder that is not exactly what was staged is discarded: it is shown, never offered.
    if (item.problem) {
      changes.push({ ...base, change: before ? "modified" : "added", problem: readOnly ? "read_only" : item.problem });
      continue;
    }
    const stat = await files.stat(item.path);
    if (!stat || stat.kind !== "file") {
      changes.push({ ...base, change: before ? "modified" : "added", problem: readOnly ? "read_only" : stat?.kind === "symlink" ? "symlink" : "unreadable" });
      continue;
    }
    if (stat.size > limits.maxFileBytes) {
      changes.push({ ...base, change: before ? "modified" : "added", afterSize: stat.size, problem: readOnly ? "read_only" : "too_large" });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await files.readFile(item.path);
    } catch {
      changes.push({ ...base, change: before ? "modified" : "added", problem: readOnly ? "read_only" : "unreadable" });
      continue;
    }
    const hash = sha256Hex(bytes);
    if (before && hash === before.hash) continue;
    if (readOnly) {
      changes.push({ ...base, change: before ? "modified" : "added", afterSize: bytes.length, problem: "read_only" });
      continue;
    }
    const change: ProposedChange = { ...base, change: before ? "modified" : "added", afterHash: hash, afterSize: bytes.length };
    if (change.page) {
      const decoded = decodeText(bytes);
      if (!decoded.editable) change.problem = "not_utf8";
      else change.after = decoded.text;
    }
    changes.push(change);
  }
  for (const entry of context) {
    if (present.has(entry.path)) continue;
    if (entry.readOnly) {
      changes.push({ path: entry.path, change: "deleted", page: entry.kind === "page", beforeHash: entry.hash, afterHash: null, afterSize: null, stale: false, problem: "read_only" });
      continue;
    }
    changes.push({ path: entry.path, change: "deleted", page: entry.kind === "page", beforeHash: entry.hash, afterHash: null, afterSize: null, stale: false, ...(entry.kind === "page" ? { after: null } : {}) });
  }
  if (overflow) changes.push({ path: "…", change: "added", page: false, beforeHash: null, afterHash: null, afterSize: null, stale: false, problem: "too_many" });

  await refreshAgainstVault(vault, changes);
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * What the vault holds now: the diff's left side, and whether applying would conflict. A change that cannot be
 * applied gets no vault read (it may name `.thoth/` or an unsafe path).
 */
export async function refreshAgainstVault(vault: Vault, changes: ProposedChange[]): Promise<void> {
  for (const change of changes) {
    if (change.problem !== undefined) continue;
    const now = await vaultText(vault, change.path).catch(() => ({ hash: null, text: null }));
    change.stale = now.hash !== change.beforeHash;
    if (change.page) change.before = now.text;
  }
}

/** True when a change may be offered for approval. */
export const canApply = (change: ProposedChange): boolean => change.problem === undefined;
