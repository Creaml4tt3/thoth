/**
 * Apply (ADR-0007 rule 5): only the changes the user approved, each through the vault's compare-and-swap write path
 * (ADR-0001 §5) against the hash recorded when the context was staged. A page edited in the vault since then is a
 * conflict and is never overwritten; the user can keep the agent's version as a separate copy instead.
 *
 * The agent's bytes are read again from the working directory and must still have the hash the user reviewed, so
 * what lands in the vault is exactly what was shown.
 */
import { isReservedPath, sha256Hex } from "@thoth/domain";
import { ConflictError, type Vault } from "@thoth/local-store";
import type { AgentFiles } from "./host.ts";

/** Where the agent's bytes are read from: the run's working directory, or what was stored for review. */
export type ReviewedFiles = Pick<AgentFiles, "readFile">;
import { canApply, type ProposedChange } from "./review.ts";

export type ApplyResult =
  | { path: string; result: "applied"; hash: string | null }
  /** The vault file changed since staging (or appeared, for an added file). Nothing was written. */
  | { path: string; result: "conflict" }
  | { path: string; result: "failed"; message: string };

export class ChangedSinceReviewError extends Error {
  constructor(path: string) {
    super(`"${path}" changed in the agent's folder after it was reviewed`);
    this.name = "ChangedSinceReviewError";
  }
}

/** The agent's bytes for a change, checked against the reviewed hash. */
export async function reviewedBytes(files: ReviewedFiles, change: ProposedChange): Promise<Uint8Array> {
  const bytes = await files.readFile(change.path);
  if (sha256Hex(bytes) !== change.afterHash) throw new ChangedSinceReviewError(change.path);
  return bytes;
}

/**
 * Applies the approved changes in path order and reports each one. Changes that were not approved, or that have a
 * problem, are never touched. One failure does not stop the others.
 */
export async function applyChanges(vault: Vault, files: ReviewedFiles, changes: readonly ProposedChange[], approved: ReadonlySet<string>): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  for (const change of changes) {
    if (!approved.has(change.path) || !canApply(change)) continue;
    try {
      if (isReservedPath(change.path)) throw new Error("Refusing to write into .thoth/");
      if (change.change === "deleted") {
        if (change.beforeHash === null) throw new Error("No staged hash for a deleted file");
        await vault.deleteFileAtomic(change.path, { expectedHash: change.beforeHash });
        results.push({ path: change.path, result: "applied", hash: null });
      } else {
        const bytes = await reviewedBytes(files, change);
        const hash = await vault.writeFileAtomic(change.path, bytes, { expectedHash: change.beforeHash });
        results.push({ path: change.path, result: "applied", hash });
      }
    } catch (error) {
      if (error instanceof ConflictError) results.push({ path: change.path, result: "conflict" });
      else results.push({ path: change.path, result: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * Keeps the agent's version of a conflicting file next to it, under the first free name `name(attempt)` gives (the
 * desktop passes the editor's conflict-copy names). Never replaces a file. Returns the copy's path.
 */
export async function saveAsCopy(vault: Vault, files: ReviewedFiles, change: ProposedChange, name: (attempt: number) => string): Promise<string> {
  if (change.change === "deleted" || !canApply(change)) throw new Error("Only an added or modified file can be kept as a copy");
  const bytes = await reviewedBytes(files, change);
  for (let attempt = 1; attempt <= 50; attempt++) {
    const path = name(attempt);
    if (isReservedPath(path)) throw new Error("Refusing to write into .thoth/");
    try {
      await vault.writeFileAtomic(path, bytes, { expectedHash: null });
      return path;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  throw new Error("Could not find a free name for the copy");
}
