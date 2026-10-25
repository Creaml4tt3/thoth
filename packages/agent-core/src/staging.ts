/**
 * Context staging (ADR-0007 rule 4): copies of exactly the pages and folders the user selected (or the whole Private
 * Space, `.thoth/` excluded), plus the attachments those pages link to, go into the run's empty working directory at
 * their vault paths, so relative links still resolve there. Each file is read once and hashed from the same bytes
 * that are copied; the manifest of (path, hash) is what review compares against and what apply's compare-and-swap
 * expects.
 *
 * Workspace pages are different: they are read-only reference copies, in their own folder (`workspace/<name>/…`,
 * files without write permission), and review never offers a change to them (`review.ts`).
 */
import { encodeText } from "@thoth/content";
import { collisionKey, dirname, isMarkdownPath, isReservedPath, normalizeVaultPath, sha256Hex } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";
import type { AgentFiles } from "./host.ts";
import type { WorkspaceDocument } from "./workspace.ts";

export interface ContextEntry {
  path: string;
  /** sha256 of the bytes copied into the working directory. */
  hash: string;
  size: number;
  kind: "page" | "file";
  /**
   * Why it is there: picked by the user, inside a picked folder, an attachment a picked page links to, part of the
   * whole Private Space, or a workspace page.
   */
  via: "selected" | "folder" | "linked" | "space" | "workspace";
  /** A reference copy (a workspace page): the agent may read it, and any change to it is discarded. */
  readOnly?: boolean | undefined;
  /** Where a workspace page came from. */
  workspace?: WorkspaceOrigin | undefined;
}

export interface WorkspaceOrigin {
  workspaceId: string;
  workspaceName: string;
  pageId: string;
  title: string;
  revisionId: string;
}

/** What the user asked to give the agent. */
export interface ContextOptions {
  /** The whole Private Space (every file except `.thoth/`) instead of, and including, any selection. */
  wholeSpace?: boolean;
  /** Workspace pages, already read, to be staged read-only. */
  workspace?: readonly WorkspaceDocument[];
}

/** The folder workspace pages go into, unless a Private Space folder already uses the name. */
export const WORKSPACE_FOLDER = "workspace";

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
 * without being told. With `wholeSpace` every file of the Private Space is included (`scanFiles` leaves out
 * `.thoth/` and the folders the app ignores).
 */
export async function resolveContext(vault: Vault, selection: readonly string[], options: { wholeSpace?: boolean; allowEmpty?: boolean } = {}): Promise<{ path: string; via: ContextEntry["via"] }[]> {
  if (selection.length === 0 && !options.wholeSpace && !options.allowEmpty) throw new StagingError({ code: "empty" });
  const { files } = await vault.scanFiles();
  const known = new Set(files);
  const picked = new Map<string, ContextEntry["via"]>();
  if (options.wholeSpace) {
    for (const file of files) if (!isReservedPath(file)) picked.set(file, "space");
  } else {
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
  }
  return [...picked].map(([path, via]) => ({ path, via })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What a selection comes to, before anything is read or copied: the files and their total size. */
export interface ContextPreview {
  files: number;
  bytes: number;
  /** Why this selection could not be staged as it is (a limit, or something missing); null when it can. */
  problem: StagingProblem | null;
}

/**
 * The total the user is shown before starting, with the same checks `stageContext` makes (count, per-file size,
 * total size), so "Start" can say why it will not work instead of failing afterwards. Only file sizes are read.
 */
export async function previewContext(vault: Vault, selection: readonly string[], options: { wholeSpace?: boolean } = {}, limits: StagingLimits = DEFAULT_STAGING_LIMITS): Promise<ContextPreview> {
  let planned: { path: string }[];
  try {
    planned = await resolveContext(vault, selection, { ...options, allowEmpty: true });
  } catch (error) {
    if (error instanceof StagingError) return { files: 0, bytes: 0, problem: error.problem };
    throw error;
  }
  let bytes = 0;
  let problem: StagingProblem | null = null;
  for (const item of planned) {
    const stat = await vault.fs.stat(item.path);
    if (!stat || stat.kind !== "file") {
      problem ??= { code: "not_found", path: item.path };
      continue;
    }
    bytes += stat.size;
    if (stat.size > limits.maxFileBytes) problem ??= { code: "file_too_large", path: item.path, size: stat.size, limit: limits.maxFileBytes };
  }
  if (planned.length > limits.maxFiles) problem = { code: "too_many", count: planned.length, limit: limits.maxFiles };
  else if (problem === null && bytes > limits.maxTotalBytes) problem = { code: "too_large", size: bytes, limit: limits.maxTotalBytes };
  return { files: planned.length, bytes, problem };
}

const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;

/** One path segment from a title or name: unsafe characters replaced, no leading or trailing dots, at most 80 characters. */
export function safeSegment(name: string, fallback: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(UNSAFE_NAME_CHARS, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.\-]+|[\s.\-]+$/g, "");
  const short = [...cleaned].slice(0, 80).join("").trimEnd();
  return short === "" ? fallback : short;
}

/** The first free name for `base`, comparing case-insensitively (default macOS and Windows volumes do). */
function unique(base: string, taken: Set<string>, suffix: string): string {
  let name = `${base}${suffix}`;
  for (let n = 2; taken.has(collisionKey(name)); n++) name = `${base} (${n})${suffix}`;
  taken.add(collisionKey(name));
  return name;
}

export interface WorkspaceLayout {
  /** The read-only folder, a top level folder of the working directory. */
  root: string;
  files: { doc: WorkspaceDocument; path: string }[];
}

/**
 * Where workspace pages go: `workspace/<workspace name>/<page title>.md`, names made safe and unique. If the
 * Private Space context already has something called `workspace` at its top level, the folder is called
 * `workspace (read-only)` (and so on), so the two can never mix.
 */
export function workspaceLayout(docs: readonly WorkspaceDocument[], privatePaths: readonly string[]): WorkspaceLayout {
  const topLevel = new Set(privatePaths.map((p) => collisionKey(p.split("/")[0]!)));
  let root = WORKSPACE_FOLDER;
  for (let n = 1; topLevel.has(collisionKey(root)); n++) root = n === 1 ? `${WORKSPACE_FOLDER} (read-only)` : `${WORKSPACE_FOLDER} (read-only ${n})`;
  const folders = new Map<string, { name: string; taken: Set<string> }>();
  const takenFolders = new Set<string>();
  const files: WorkspaceLayout["files"] = [];
  for (const doc of docs) {
    let folder = folders.get(doc.workspaceId);
    if (!folder) {
      folder = { name: unique(safeSegment(doc.workspaceName, "Workspace"), takenFolders, ""), taken: new Set() };
      folders.set(doc.workspaceId, folder);
    }
    files.push({ doc, path: `${root}/${folder.name}/${unique(safeSegment(doc.title, "Untitled"), folder.taken, ".md")}` });
  }
  return { root, files };
}

/**
 * The framing put in front of the user's task when workspace pages are given: they are for reading only. (The prompt
 * is a courtesy to the model; the guarantee is that review never applies a change there.)
 */
export function workspaceFraming(root: string): string {
  return [
    `Reference material: the folder "${root}/" holds read-only copies of pages from shared team workspaces.`,
    `Use them for information only. Do not edit, create, rename or delete anything inside "${root}/": any change there is discarded and never saved.`,
    `Make your changes in files outside that folder.`,
    "",
    "Task:",
    "",
    "",
  ].join("\n");
}

/** Copies the selection into an empty working directory and returns the manifest. */
export async function stageContext(vault: Vault, files: AgentFiles, selection: readonly string[], limits: StagingLimits = DEFAULT_STAGING_LIMITS, options: ContextOptions = {}): Promise<ContextEntry[]> {
  const docs = options.workspace ?? [];
  const planned = await resolveContext(vault, selection, { ...(options.wholeSpace ? { wholeSpace: true } : {}), allowEmpty: docs.length > 0 });
  const layout = workspaceLayout(docs, planned.map((p) => p.path));
  const encoded = layout.files.map((f) => ({ ...f, bytes: encodeText(f.doc.markdown) }));
  if (planned.length + encoded.length > limits.maxFiles) throw new StagingError({ code: "too_many", count: planned.length + encoded.length, limit: limits.maxFiles });
  let total = 0;
  for (const item of planned) {
    const stat = await vault.fs.stat(item.path);
    if (!stat || stat.kind !== "file") throw new StagingError({ code: "not_found", path: item.path });
    if (stat.size > limits.maxFileBytes) throw new StagingError({ code: "file_too_large", path: item.path, size: stat.size, limit: limits.maxFileBytes });
    total += stat.size;
  }
  for (const item of encoded) {
    if (item.bytes.length > limits.maxFileBytes) throw new StagingError({ code: "file_too_large", path: item.path, size: item.bytes.length, limit: limits.maxFileBytes });
    total += item.bytes.length;
  }
  if (total > limits.maxTotalBytes) throw new StagingError({ code: "too_large", size: total, limit: limits.maxTotalBytes });

  const manifest: ContextEntry[] = [];
  const made = new Set<string>();
  const ensureDir = async (dir: string) => {
    if (dir !== "" && !made.has(dir)) {
      await files.mkdirp(dir);
      made.add(dir);
    }
  };
  for (const item of planned) {
    const bytes = await vault.fs.readFile(item.path);
    if (bytes.length > limits.maxFileBytes) throw new StagingError({ code: "file_too_large", path: item.path, size: bytes.length, limit: limits.maxFileBytes });
    await ensureDir(dirname(item.path));
    await files.writeFile(item.path, bytes);
    manifest.push({ path: item.path, hash: sha256Hex(bytes), size: bytes.length, kind: isMarkdownPath(item.path) ? "page" : "file", via: item.via });
  }
  for (const item of encoded) {
    await ensureDir(dirname(item.path));
    await files.writeFile(item.path, item.bytes, { readOnly: true });
    const { doc } = item;
    manifest.push({
      path: item.path,
      hash: sha256Hex(item.bytes),
      size: item.bytes.length,
      kind: "page",
      via: "workspace",
      readOnly: true,
      workspace: { workspaceId: doc.workspaceId, workspaceName: doc.workspaceName, pageId: doc.pageId, title: doc.title, revisionId: doc.revisionId },
    });
  }
  return manifest;
}
