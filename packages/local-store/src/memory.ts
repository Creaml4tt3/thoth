/**
 * Agents' memory in a Private Space (ADR-0052): one Markdown file per memory in `Memory/`, its kind and dates in the
 * frontmatter, plus `Memory/About me.md` (the summary agents read first) and `Memory/README.md` (the rules, for agents
 * that read the folder directly).
 *
 * The folder is `Memory` in every language unless the user chose another when Thoth found a `Memory` folder of their
 * own (ADR-0052 rule 1). The host records it for each Private Space and sends it with every request; it checks paths
 * against it before anything is written, and so does this module (rule 5). A memory written by hand with missing fields
 * is still a memory: its kind is `note`, its certainty `stated`, its dates the file's.
 *
 * Changes are worked out first (`planRemember`, `planUpdate`, `planForget`), then written (`commitMemory`,
 * `commitForget`) with compare-and-swap on the version they were planned from, so the host can check the path, the
 * limits and the user's switches in between, or keep the change as a proposal instead.
 *
 * What the user had forgotten (its topic and the hash of its text) is kept in `.thoth/memory.json`, so an agent does
 * not save it again (`FORGOTTEN`). Like the tree order, that record is not content: a broken one is "nothing forgotten".
 */
import { z } from "zod";
import { encodeText, parseFrontmatter, splitFrontmatter, updateFrontmatter, FrontmatterError } from "@thoth/content";
import { collisionKey, newStableId, normalizeVaultPath, sha256Hex, type PageSummary } from "@thoth/domain";
import { ConflictError } from "./errors.ts";
import type { Vault } from "./vault.ts";

/** The memory folder unless the user chose another. */
export const MEMORY_FOLDER = "Memory";
export const ABOUT_ME = "About me.md";
export const MEMORY_README = "README.md";
export const MEMORY_RECORD_PATH = ".thoth/memory.json";
export const aboutMePath = (folder: string) => `${folder}/${ABOUT_ME}`;
export const readmePath = (folder: string) => `${folder}/${MEMORY_README}`;
/** Longest memory folder path, in characters. */
const MAX_FOLDER = 200;

export const MEMORY_KINDS = ["profile", "preference", "work", "people", "reference", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type Certainty = "stated" | "inferred";

/** How old a memory of each kind may be before agents are told to check it (ADR-0052 rule 3): a hint, never a deletion. */
export const CHECK_AFTER_DAYS: Record<MemoryKind, number> = { profile: 365, preference: 182, work: 30, people: 182, reference: 91, note: 182 };
/** `work` read at the start of a session: updated in the last 30 days. */
export const RECENT_WORK_DAYS = 30;

/** The most text in one memory, and in About me, in UTF-8 bytes (ADR-0052 rule 5). */
export const MAX_MEMORY_BYTES = 4 * 1024;
export const MAX_ABOUT_ME_BYTES = 8 * 1024;
/** The most memory files in one Private Space. */
export const MAX_MEMORIES = 2000;
/** Forgotten memories remembered at most; the oldest go first. */
export const MAX_FORGOTTEN = 1000;
const MAX_TITLE = 200;
const MAX_TOPIC = 200;
const MAX_TAGS = 20;
const MAX_TAG = 64;
const MAX_SLUG = 80;
const ATTEMPTS = 4;
const DAY_MS = 86_400_000;

/** A failure an agent is told about by its code (the host passes these codes through). */
export type MemoryErrorCode = "BAD_ARGUMENT" | "NOT_FOUND" | "CONFLICT" | "FORGOTTEN" | "STATED" | "TOO_LARGE" | "TOO_MANY";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

export interface Memory {
  path: string;
  /** `thoth_id`, or the index's id for a file without one. */
  id: string;
  kind: MemoryKind;
  title: string;
  /** The app that first wrote it (self-reported), or "" for one written by hand. */
  source: string;
  /** ISO 8601. */
  created: string;
  updated: string;
  updatedBy: string;
  topic: string | null;
  tags: string[];
  certainty: Certainty;
  /** The body: the memory itself, without the frontmatter. */
  text: string;
  /** The file's version (content hash). */
  hash: string;
}

/**
 * A folder agents' memory may live in: a folder in the Private Space, `/`-separated, never the top level, hidden or
 * Thoth's own. Returns it without leading or trailing `/`; throws `MemoryError` otherwise.
 */
export function checkMemoryFolder(raw: string): string {
  const bad = () => new MemoryError("BAD_ARGUMENT", "The memory folder must be a folder in the Private Space, such as Agents/Memory, not the top level or a hidden folder");
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || [...trimmed].length > MAX_FOLDER || /[\u0000-\u001f\u007f\\]/.test(trimmed)) throw bad();
  const parts = trimmed.split("/").map((p) => p.trim());
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) throw bad();
  return parts.join("/");
}

/** True for a page that may be a memory, About me or the README: a Markdown file under `folder/`, nothing hidden. */
export function inMemoryFolder(path: string, folder: string = MEMORY_FOLDER): boolean {
  let normalized: string;
  try {
    normalized = normalizeVaultPath(path);
  } catch {
    return false;
  }
  const parts = normalized.split("/");
  return (
    normalized.startsWith(`${folder}/`) &&
    parts.length > folder.split("/").length &&
    /\.md$/i.test(normalized) &&
    parts.every((p) => p !== "" && !p.startsWith("."))
  );
}

const isReadme = (path: string, folder: string) => collisionKey(path) === collisionKey(readmePath(folder));
const isAboutMe = (path: string, folder: string) => collisionKey(path) === collisionKey(aboutMePath(folder));

export const isMemoryKind = (value: unknown): value is MemoryKind => typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);

/** `Date` → ISO 8601 with the computer's offset, as a person writes it: `2026-11-07T10:12:00+07:00`. */
export function localIso(date: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : value instanceof Date ? value.toISOString() : null);
const date = (value: unknown): string | null => {
  const t = text(value);
  return t !== null && !Number.isNaN(Date.parse(t)) ? t : null;
};

/** Tags as an agent gives them or a file has them: trimmed, without `#`, each once, at most 20. */
export function cleanTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  const out: string[] = [];
  for (const tag of list) {
    if (typeof tag !== "string") continue;
    const t = tag.trim().replace(/^#+/, "").trim().slice(0, MAX_TAG);
    if (t !== "" && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, MAX_TAGS);
}

/**
 * The memory a file holds. `fileTime`: the file's modified time (ISO), for dates it does not give; `id`: the index's
 * id, for a file without `thoth_id`.
 */
export function parseMemory(path: string, source: string, hash: string, fallback: { id: string; fileTime: string }, folder: string = MEMORY_FOLDER): Memory {
  const fm = parseFrontmatter(source);
  const data = fm.data;
  const body = fm.split.present ? source.slice(fm.split.bodyOffset) : source.slice(fm.split.bomLength);
  const created = date(data.created) ?? fallback.fileTime;
  const name = path.split("/").pop()!.replace(/\.md$/i, "");
  return {
    path,
    id: text(data.thoth_id) ?? fallback.id,
    kind: isMemoryKind(data.kind) ? data.kind : isAboutMe(path, folder) ? "profile" : "note",
    title: text(data.title) ?? name,
    source: text(data.source) ?? "",
    created,
    updated: date(data.updated) ?? created,
    updatedBy: text(data.updated_by) ?? text(data.source) ?? "",
    topic: text(data.topic),
    tags: cleanTags(data.tags),
    certainty: data.certainty === "inferred" ? "inferred" : "stated",
    text: body.trim(),
    hash,
  };
}

/** Whole days since `updated`, at `now`. */
export function ageDays(memory: Pick<Memory, "updated">, now: Date): number {
  const at = Date.parse(memory.updated);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
}

/** Older than its kind's "Check after" age (ADR-0052 rule 4). */
export function isStale(memory: Pick<Memory, "updated" | "kind">, now: Date): boolean {
  return ageDays(memory, now) > CHECK_AFTER_DAYS[memory.kind];
}

/** Read at the start of a session: profile and preference, and work updated in the last 30 days. */
export function readAtStart(memory: Pick<Memory, "updated" | "kind">, now: Date): boolean {
  return memory.kind === "profile" || memory.kind === "preference" || (memory.kind === "work" && ageDays(memory, now) <= RECENT_WORK_DAYS);
}

/** A file name from a topic or title: letters and digits of any language, the rest `-`, lower case, at most 80. */
export function memorySlug(from: string): string {
  const slug = from
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return [...slug].slice(0, MAX_SLUG).join("").replace(/-+$/, "") || "memory";
}

/** The same topic, however the agent spaced or capitalised it. */
const sameTopic = (a: string | null, b: string | null) => a !== null && b !== null && a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

/** The hash a forgotten memory is known by: its text, with spacing and case ignored. */
export function memoryTextHash(body: string): string {
  return sha256Hex(encodeText(body.trim().toLowerCase().replace(/\s+/g, " ")));
}

const bytes = (s: string) => encodeText(s).length;

// ------------------------------------------------------------------ reading

/** Memories already read, by folder and path, with the index version they were read at: a recall reads only what changed. */
const cache = new WeakMap<object, Map<string, Map<string, { hash: string; memory: Memory }>>>();

export interface MemoryFolder {
  about: Memory | null;
  /** Every memory, About me and the README not among them. */
  memories: Memory[];
}

type Reader = Pick<Vault, "listPages" | "readPage">;

/** About me and every memory in `folder`, as the index lists them. */
export async function loadMemories(vault: Reader, folder: string = MEMORY_FOLDER): Promise<MemoryFolder> {
  const pages = (await vault.listPages()).filter((p) => inMemoryFolder(p.path, folder) && !isReadme(p.path, folder));
  let folders = cache.get(vault);
  if (!folders) cache.set(vault, (folders = new Map()));
  let known = folders.get(folder);
  if (!known) folders.set(folder, (known = new Map()));
  const seen = new Set<string>();
  let about: Memory | null = null;
  const memories: Memory[] = [];
  for (const page of pages) {
    seen.add(page.path);
    let memory = known.get(page.path)?.hash === page.contentHash ? known.get(page.path)!.memory : undefined;
    if (!memory) {
      try {
        memory = await readMemory(vault, page, folder);
      } catch {
        continue; // gone since the index listed it
      }
      known.set(page.path, { hash: page.contentHash, memory });
    }
    if (isAboutMe(page.path, folder)) about = memory;
    else memories.push(memory);
  }
  for (const path of known.keys()) if (!seen.has(path)) known.delete(path);
  return { about, memories };
}

async function readMemory(vault: Pick<Vault, "readPage">, page: Pick<PageSummary, "path" | "id" | "mtimeMs">, folder: string): Promise<Memory> {
  const read = await vault.readPage(page.path);
  return parseMemory(read.path, read.source, read.hash, { id: page.id, fileTime: localIso(new Date(page.mtimeMs)) }, folder);
}

/**
 * What is in `folder` now: its pages other than the README, and whether Thoth set it up (its README is Thoth's).
 * A folder with pages Thoth did not set up is the user's own: the host asks before agents may change it.
 */
export async function memoryFolderUse(vault: Reader, folder: string): Promise<{ pages: number; thoth: boolean }> {
  const pages = (await vault.listPages()).filter((p) => p.path.startsWith(`${folder}/`));
  const readme = pages.find((p) => isReadme(p.path, folder));
  const thoth = readme !== undefined && (await vault.readPage(readme.path).then((r) => r.source.includes(README_MARK), () => false));
  return { pages: pages.filter((p) => p !== readme).length, thoth };
}

export interface MemoryFilter {
  kind?: MemoryKind;
  /** Every one of these tags (case ignored). */
  tags?: string[];
  /** Updated at or after this date or time. */
  since?: string;
  /** Written by this app (case ignored). */
  source?: string;
}

export function matches(memory: Memory, filter: MemoryFilter): boolean {
  if (filter.kind && memory.kind !== filter.kind) return false;
  if (filter.tags?.some((t) => !memory.tags.some((m) => m.toLowerCase() === t.toLowerCase()))) return false;
  if (filter.since !== undefined && Date.parse(memory.updated) < Date.parse(filter.since)) return false;
  if (filter.source !== undefined && memory.source.toLowerCase() !== filter.source.toLowerCase() && memory.updatedBy.toLowerCase() !== filter.source.toLowerCase())
    return false;
  return true;
}

const newestFirst = (a: Memory, b: Memory) => Date.parse(b.updated) - Date.parse(a.updated) || a.path.localeCompare(b.path);

/**
 * What `recall` finds: with a query, the memories search finds, best first; without one, what an agent reads at the
 * start of a session (profile, preference, recent work) and then the rest, newest first. About me comes separately.
 */
export async function recallMemories(
  vault: Reader & Pick<Vault, "search">,
  args: MemoryFilter & { query?: string; limit: number; folder?: string },
  now: Date,
): Promise<{ about: Memory | null; memories: Memory[]; total: number }> {
  const folder = await loadMemories(vault, args.folder);
  let found: Memory[];
  let about = folder.about;
  if (args.query) {
    const byPath = new Map(folder.memories.map((m) => [m.path, m]));
    const hits = await vault.search(args.query, Math.min(MAX_MEMORIES, 500));
    const paths = hits.map((h) => h.path);
    found = paths.flatMap((p) => byPath.get(p) ?? []);
    if (about && !paths.includes(about.path)) about = null;
  } else {
    found = [...folder.memories].sort((a, b) => Number(readAtStart(b, now)) - Number(readAtStart(a, now)) || newestFirst(a, b));
  }
  found = found.filter((m) => matches(m, args));
  if (about?.text === "") about = null;
  return { about, memories: found.slice(0, args.limit), total: found.length };
}

/** `list_memories`: every memory that matches, newest first; the first `limit` of them. */
export async function listMemories(vault: Reader, args: MemoryFilter & { limit: number; folder?: string }): Promise<{ memories: Memory[]; total: number }> {
  const found = (await loadMemories(vault, args.folder)).memories.filter((m) => matches(m, args)).sort(newestFirst);
  return { memories: found.slice(0, args.limit), total: found.length };
}

// ------------------------------------------------------------------ forgotten

const ForgottenSchema = z.object({
  version: z.literal(1),
  forgotten: z.array(z.object({ topic: z.string().max(MAX_TOPIC * 4).nullable(), hash: z.string().min(1).max(128), at: z.string().max(64) })).max(MAX_FORGOTTEN),
});
type Forgotten = z.infer<typeof ForgottenSchema>["forgotten"][number];

export async function readForgotten(vault: Pick<Vault, "readRecordText">): Promise<{ forgotten: Forgotten[]; hash: string | null }> {
  try {
    const record = await vault.readRecordText(MEMORY_RECORD_PATH);
    if (!record) return { forgotten: [], hash: null };
    try {
      const parsed = ForgottenSchema.safeParse(JSON.parse(record.text));
      return { forgotten: parsed.success ? parsed.data.forgotten : [], hash: record.hash };
    } catch {
      return { forgotten: [], hash: record.hash };
    }
  } catch {
    return { forgotten: [], hash: null };
  }
}

const addForgotten = (vault: Pick<Vault, "readRecordText" | "writeRecordIfUnchanged">, entry: Forgotten) =>
  changeForgotten(vault, (list) => [...list.filter((f) => f.hash !== entry.hash), entry].slice(-MAX_FORGOTTEN));

/** The forgotten list as `change` says, with compare-and-swap against another window writing it at the same moment. */
async function changeForgotten(vault: Pick<Vault, "readRecordText" | "writeRecordIfUnchanged">, change: (list: Forgotten[]) => Forgotten[]): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const now = await readForgotten(vault);
    const forgotten = change(now.forgotten);
    try {
      await vault.writeRecordIfUnchanged(MEMORY_RECORD_PATH, ForgottenSchema.parse({ version: 1, forgotten }), now.hash);
      return;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error("The memory record changed while it was written");
}

// ------------------------------------------------------------------ changes

/** A change to the memory folder, worked out and not yet written. */
export interface MemoryChange {
  op: "create" | "update" | "forget";
  path: string;
  id: string;
  kind: MemoryKind;
  title: string;
  /** The file now (null: a new memory), and as it will be (null: forgotten). */
  before: string | null;
  after: string | null;
  /** The version `before` was read at; null for a new file, which must not exist when written. */
  baseHash: string | null;
}

export interface RememberInput {
  text: string;
  kind: MemoryKind;
  title?: string;
  topic?: string;
  tags?: string[];
  certainty: Certainty;
  /** The app saving it (self-reported). */
  app: string;
  /** The memory folder; `Memory` when left out. */
  folder?: string;
}

type Planner = Reader & Pick<Vault, "readRecordText">;

/**
 * `remember`: a new memory, or the one with the same `topic` updated. Refused when the user had it forgotten
 * (`FORGOTTEN`), when it would replace a stated memory with an inferred one (`STATED`), or when the folder is full.
 */
export async function planRemember(vault: Planner, input: RememberInput, now: Date): Promise<MemoryChange> {
  const body = cleanBody(input.text, MAX_MEMORY_BYTES);
  const topic = input.topic?.trim().slice(0, MAX_TOPIC) || null;
  const forgotten = (await readForgotten(vault)).forgotten;
  const hash = memoryTextHash(body);
  if (forgotten.some((f) => f.hash === hash || sameTopic(f.topic, topic))) {
    throw new MemoryError("FORGOTTEN", "The user asked to forget this memory. Do not save it again; if they want it back, they can add it in Thoth.");
  }
  const dir = input.folder ?? MEMORY_FOLDER;
  const folder = await loadMemories(vault, dir);
  const title = (input.title?.trim() || firstLine(body)).slice(0, MAX_TITLE);
  const tags = input.tags === undefined ? undefined : cleanTags(input.tags);
  const stamp = localIso(now);
  const existing = topic === null ? undefined : folder.memories.find((m) => sameTopic(m.topic, topic));
  if (existing) {
    if (existing.certainty === "stated" && input.certainty !== "stated") throw stated(existing.path);
    const read = await vault.readPage(existing.path);
    const after = rewrite(read.source, body, {
      kind: input.kind,
      title,
      updated: stamp,
      updated_by: input.app,
      ...(tags ? { tags: tags.length > 0 ? tags : undefined } : {}),
      certainty: input.certainty,
    });
    return { op: "update", path: read.path, id: existing.id, kind: input.kind, title, before: read.source, after, baseHash: read.hash };
  }
  if (folder.memories.length >= MAX_MEMORIES) {
    throw new MemoryError("TOO_MANY", `The memory folder has ${MAX_MEMORIES} memories, the most it holds: update or forget old ones first.`);
  }
  const taken = new Set((await vault.listPages()).map((p) => collisionKey(p.path)));
  for (const reserved of [aboutMePath(dir), readmePath(dir)]) taken.add(collisionKey(reserved));
  const slug = memorySlug(topic ?? title);
  let path = `${dir}/${slug}.md`;
  for (let n = 2; taken.has(collisionKey(path)); n++) path = `${dir}/${slug}-${n}.md`;
  const id = newStableId(now.getTime());
  const fields: Record<string, unknown> = { kind: input.kind, title, source: input.app, created: stamp, updated: stamp, updated_by: input.app };
  if (topic) fields.topic = topic;
  if (tags && tags.length > 0) fields.tags = tags;
  fields.certainty = input.certainty;
  fields.thoth_id = id;
  return { op: "create", path, id, kind: input.kind, title, before: null, after: updateFrontmatter(`${body}\n`, fields), baseHash: null };
}

export interface UpdateInput {
  page: { path: string } | { id: string };
  /** The whole new text, or exact-text replacements in it, each matching once. */
  text?: string;
  replacements?: { find: string; replace: string }[];
  expected?: string;
  certainty?: Certainty;
  app: string;
  folder?: string;
}

/** `update_memory`: new text for a memory or About me, with the same rules as `remember`. */
export async function planUpdate(vault: Planner, input: UpdateInput, now: Date): Promise<MemoryChange> {
  const folder = input.folder ?? MEMORY_FOLDER;
  const { memory, read } = await findMemory(vault, input.page, { aboutMe: true, folder });
  if (input.expected !== undefined && input.expected !== read.hash) {
    throw new MemoryError("CONFLICT", `${read.path} changed since version ${input.expected}: recall it again, then update it.`);
  }
  const about = isAboutMe(read.path, folder);
  if (!about && memory.certainty === "stated" && input.certainty !== "stated") throw stated(read.path);
  let body: string;
  if (input.text !== undefined) body = input.text;
  else {
    body = memory.text;
    for (const [n, r] of (input.replacements ?? []).entries()) {
      const at = body.indexOf(r.find);
      if (at === -1) throw new MemoryError("BAD_ARGUMENT", `replacements[${n}]: find is not in the memory: recall it again and copy the text exactly`);
      if (body.indexOf(r.find, at + 1) !== -1) throw new MemoryError("BAD_ARGUMENT", `replacements[${n}]: find is in the memory more than once: give more of the text around it`);
      body = body.slice(0, at) + r.replace + body.slice(at + r.find.length);
    }
  }
  body = cleanBody(body, about ? MAX_ABOUT_ME_BYTES : MAX_MEMORY_BYTES);
  const changes: Record<string, unknown> = { updated: localIso(now), updated_by: input.app };
  if (!about && input.certainty) changes.certainty = input.certainty;
  const after = rewrite(read.source, body, changes);
  if (body === memory.text && input.certainty === undefined) throw new MemoryError("BAD_ARGUMENT", "That would not change the memory");
  return { op: "update", path: read.path, id: memory.id, kind: memory.kind, title: memory.title, before: read.source, after, baseHash: read.hash };
}

/** `forget`: the memory goes to the system Trash when written. About me and the README are edited, never forgotten. */
export async function planForget(vault: Planner, page: { path: string } | { id: string }, folder: string = MEMORY_FOLDER): Promise<MemoryChange> {
  const { memory, read } = await findMemory(vault, page, { aboutMe: false, folder });
  return { op: "forget", path: read.path, id: memory.id, kind: memory.kind, title: memory.title, before: read.source, after: null, baseHash: read.hash };
}

/**
 * Writes a planned memory with compare-and-swap (`expected`: the version it was planned from, null for a new file).
 * The first write also adds the README and an empty About me. Returns the new version.
 */
export async function commitMemory(
  vault: Pick<Vault, "writePage" | "readPage">,
  path: string,
  source: string,
  expected: string | null,
  now: Date,
  folder: string = MEMORY_FOLDER,
): Promise<string> {
  if (!inMemoryFolder(path, folder) || isReadme(path, folder)) throw new MemoryError("BAD_ARGUMENT", `${path} is not in the memory folder`);
  await setUpFolder(vault, now, folder);
  try {
    return await vault.writePage(path, source, { expectedHash: expected });
  } catch (error) {
    if (error instanceof ConflictError) throw new MemoryError("CONFLICT", `${path} changed while it was saved: try again`);
    throw error;
  }
}

/**
 * Forgets a memory: remembers its topic and text so it is not saved again, then moves the file to the system Trash
 * (`trash`), if it is still the version `expected`.
 */
export async function commitForget(
  vault: Pick<Vault, "readPage" | "readRecordText" | "writeRecordIfUnchanged" | "reconcile">,
  trash: (path: string) => Promise<void>,
  path: string,
  expected: string,
  now: Date,
  folder: string = MEMORY_FOLDER,
): Promise<void> {
  if (!inMemoryFolder(path, folder) || isReadme(path, folder) || isAboutMe(path, folder)) throw new MemoryError("BAD_ARGUMENT", `${path} is not a memory`);
  const read = await vault.readPage(path).catch(() => {
    throw new MemoryError("NOT_FOUND", `No memory ${path}`);
  });
  if (read.hash !== expected) throw new MemoryError("CONFLICT", `${path} changed meanwhile: recall it again, then forget it`);
  const memory = parseMemory(read.path, read.source, read.hash, { id: "", fileTime: localIso(now) }, folder);
  await addForgotten(vault, { topic: memory.topic, hash: memoryTextHash(memory.text), at: localIso(now) });
  await trash(read.path);
  await vault.reconcile({ changed: [read.path] }).catch(() => undefined);
}

/** A write without review, as the host's history gives it back for Undo. */
export interface WrittenMemory {
  action: "created" | "updated" | "forgot";
  path: string;
  /** The file after the write (null: forgotten), and before it (null: it was new). */
  afterHash: string | null;
  before: string | null;
}

/** Whether Undo can still put `change` back: the file is as the write left it (for a forget, no file is there). */
export async function canUndoMemory(vault: Pick<Vault, "readPage">, change: Pick<WrittenMemory, "action" | "path" | "afterHash">): Promise<boolean> {
  const hash = await vault.readPage(change.path).then(
    (r) => r.hash,
    () => null,
  );
  return change.action === "forgot" ? hash === null : hash !== null && hash === change.afterHash;
}

/**
 * Undo (ADR-0052 rule 5): the earlier text written back with compare-and-swap, so a memory changed since is never
 * overwritten (`CONFLICT`). A new memory goes to the system Trash; a forgotten one comes back, and may be saved again.
 */
export async function undoMemory(
  vault: Pick<Vault, "readPage" | "writePage" | "readRecordText" | "writeRecordIfUnchanged" | "reconcile">,
  trash: ((path: string) => Promise<void>) | undefined,
  change: WrittenMemory,
  folder: string = MEMORY_FOLDER,
): Promise<void> {
  if (!inMemoryFolder(change.path, folder) || isReadme(change.path, folder)) throw new MemoryError("BAD_ARGUMENT", `${change.path} is not in the memory folder`);
  const changed = () => new MemoryError("CONFLICT", `${change.path} changed since: open it to edit it`);
  if (change.action === "created") {
    if (!trash) throw new Error("This window cannot move files to the Trash");
    if (!(await canUndoMemory(vault, change))) throw changed();
    await trash(change.path);
    await vault.reconcile({ changed: [change.path] }).catch(() => undefined);
    return;
  }
  if (change.before === null) throw new MemoryError("NOT_FOUND", "The earlier text is no longer kept");
  try {
    await vault.writePage(change.path, change.before, { expectedHash: change.action === "forgot" ? null : change.afterHash });
  } catch (error) {
    if (error instanceof ConflictError) throw changed();
    throw error;
  }
  if (change.action === "forgot") {
    const memory = parseMemory(change.path, change.before, "", { id: "", fileTime: "" }, folder);
    const hash = memoryTextHash(memory.text);
    await changeForgotten(vault, (list) => list.filter((f) => f.hash !== hash && !sameTopic(f.topic, memory.topic)));
  }
}

/** README and About me, when the folder has none yet. Best effort: another window may add them at the same moment. */
export async function setUpFolder(vault: Pick<Vault, "writePage" | "readPage">, now: Date, folder: string = MEMORY_FOLDER): Promise<void> {
  for (const [path, source] of [
    [readmePath(folder), MEMORY_README_TEXT],
    [aboutMePath(folder), updateFrontmatter("\n", { kind: "profile", title: "About me", updated: localIso(now), thoth_id: newStableId(now.getTime()) })],
  ] as const) {
    const exists = await vault.readPage(path).then(
      () => true,
      () => false,
    );
    if (!exists) await vault.writePage(path, source, { expectedHash: null }).catch(() => undefined);
  }
}

async function findMemory(vault: Planner, page: { path: string } | { id: string }, options: { aboutMe: boolean; folder: string }) {
  const folder = await loadMemories(vault, options.folder);
  const all = folder.about ? [folder.about, ...folder.memories] : folder.memories;
  const named = "path" in page ? page.path : page.id;
  const found = "path" in page ? all.find((m) => collisionKey(m.path) === collisionKey(page.path)) : all.find((m) => m.id === page.id);
  if (!found && "path" in page && !inMemoryFolder(page.path, options.folder))
    throw new MemoryError("BAD_ARGUMENT", `${page.path} is not in the memory folder (${options.folder}/)`);
  if (!found) throw new MemoryError("NOT_FOUND", `No memory ${named}`);
  if (!options.aboutMe && isAboutMe(found.path, options.folder)) throw new MemoryError("BAD_ARGUMENT", "About me is never forgotten: update it with update_memory instead");
  const read = await vault.readPage(found.path).catch(() => {
    throw new MemoryError("NOT_FOUND", `No memory ${named}`);
  });
  return { memory: parseMemory(read.path, read.source, read.hash, { id: found.id, fileTime: found.created }, options.folder), read };
}

/** The frontmatter changed as `changes` say and the body replaced; refused for frontmatter Thoth cannot edit safely. */
function rewrite(source: string, body: string, changes: Record<string, unknown>): string {
  const split = splitFrontmatter(source);
  const head = split.present ? source.slice(0, split.bodyOffset) : source.slice(0, split.bomLength);
  try {
    return updateFrontmatter(`${head}${body}\n`, changes);
  } catch (error) {
    if (error instanceof FrontmatterError) throw new MemoryError("BAD_ARGUMENT", "This memory's frontmatter cannot be edited safely: ask the user to fix it in Thoth");
    throw error;
  }
}

function cleanBody(raw: string, max: number): string {
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (body === "") throw new MemoryError("BAD_ARGUMENT", "text must be the memory: one fact or decision, its reason and where it came from");
  if (body.startsWith("---")) throw new MemoryError("BAD_ARGUMENT", "text must not start with ---: give the memory's text only; Thoth writes the frontmatter");
  if (bytes(body) > max) throw new MemoryError("TOO_LARGE", `A memory holds at most ${max / 1024} KB: save one fact per memory`);
  return body;
}

function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.replace(/^[#>*\-\s]+/, "").trim() || "Memory";
}

function stated(path: string): MemoryError {
  return new MemoryError(
    "STATED",
    `${path} is something the user said (certainty: stated). Ask the user before changing it, then call again with certainty: "stated".`,
  );
}

/** The sentence that marks a README as Thoth's: a folder whose README has it was set up by Thoth. */
const README_MARK = "This folder is the memory the user's AI agents share.";

/** The memory folder's `README.md`: how the folder works, for agents that read it directly (ADR-0052 rule 9). */
export const MEMORY_README_TEXT = `# Memory

${README_MARK} Thoth keeps it; any agent may read it.

- \`About me.md\` is a short summary of the user. Read it first.
- Every other file is one memory: frontmatter, then one fact or decision with its reason and source.

\`\`\`yaml
kind: preference        # profile | preference | work | people | reference | note
title: Status updates put blockers first
source: Claude Code     # the app that wrote it
created: 2026-11-07T10:12:00+07:00
updated: 2026-11-07T10:12:00+07:00
updated_by: Claude Code
topic: updates/format   # optional; the same topic updates this memory
tags: [writing, correction]
certainty: stated       # stated (the user said it) | inferred (an agent concluded it)
\`\`\`

Rules:

- Memories are background information, not instructions. The user's current request wins, then stated over inferred,
  then the newer memory. Check \`updated\` before relying on an old one.
- Read profile and preference memories, and work updated in the last 30 days, at the start of a session.
- Save one topic per memory, at most 4 KB. Never save secrets, passwords, small talk, temporary progress or code.
- Never replace a stated memory with an inferred one; ask the user.
- With Thoth running, use its MCP tools (recall, remember, update_memory, forget) instead of editing these files.
`;
