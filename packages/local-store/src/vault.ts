import { decodeText, encodeText, LinkResolver, NotEditableError, parsePage, rewriteTargets, updateFrontmatter, type PageDocument, type ParsedReference, type TargetEdit } from "@thoth/content";
import {
  collisionKey,
  isMarkdownPath,
  isReservedPath,
  isStableId,
  newStableId,
  normalizeVaultPath,
  provisionalPageId,
  relativeLink,
  sha256Hex,
  basename,
  dirname,
  stripExtension,
  type PageSummary,
} from "@thoth/domain";
import { ConflictError, IndexBusyError, NotFoundError, isIndexBusy } from "./errors.ts";
import {
  clearJournalEntry,
  JOURNAL_DIR,
  journalTempPath,
  readPendingJournal,
  recordPath,
  TEMP_DIR,
  writeJournalEntry,
  writeRecordAtomic,
  type JournalEntry,
} from "./journal.ts";
import { mimeTypeFor } from "./mime.ts";
import type { SqlDriver, VaultFs } from "./ports.ts";
import { INDEX_DDL, INDEX_SCHEMA_VERSION } from "./schema.ts";
import { tokenize, trigramMatch, wordMatch } from "./search-query.ts";

export const THOTH_DIR = ".thoth";
const CONFIG_PATH = ".thoth/config.json";
const CONFIG_VERSION = 1;

/**
 * Opening waits this long between tries while another window holds the index (each try already waits SQLite's busy
 * timeout, 5 s), then gives up with `IndexBusyError` (ADR-0019).
 */
const OPEN_BUSY_BACKOFF_MS = [250, 1000];

/** Runs `step` again, after a pause, while it fails only because the index is busy; then `IndexBusyError`. */
async function whileBusy<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (!isIndexBusy(error)) throw error;
      const pause = OPEN_BUSY_BACKOFF_MS[attempt];
      if (pause === undefined) throw new IndexBusyError({ cause: error });
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}

/** Directories never indexed: Thoth metadata, other tools' metadata, VCS. */
const IGNORED_DIRS = new Set([".thoth", ".obsidian", ".git", ".trash", "node_modules"]);


/** Deterministic duplicate-ID owner: shortest path, then lexicographic. Stable across rebuilds. */
export function claimOwner(paths: readonly string[]): string {
  return [...paths].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0]!;
}

export interface VaultOptions {
  fs: VaultFs;
  sql: SqlDriver;
  now?: () => number;
  /**
   * Run journal recovery at open (the default). False when another window of the app has this folder open already
   * (ADR-0019): its temp files and journal entries are work in flight, not what a crash left.
   */
  recover?: boolean;
}

export interface ReconcileReport {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
  warnings: { path: string; code: string; message: string }[];
  recoveredJournalEntries: number;
}

export interface SearchHit {
  id: string;
  path: string;
  title: string;
  snippet: string;
}

export interface Backlink {
  sourceId: string;
  sourcePath: string;
  sourceTitle: string;
  line: number;
  syntax: string;
}

export interface ReadResult {
  path: string;
  source: string;
  hash: string;
  document: PageDocument;
  /** False for non-UTF-8 files: `source` is display-only and writes are refused. */
  editable: boolean;
}

export interface WriteOptions {
  /**
   * Hash of the content the caller expects to replace (compare-and-swap).
   * `null` means the file must not exist yet. Required: there is no blind write.
   */
  expectedHash: string | null;
}

/** What `Vault.move` did. */
export interface MoveReport {
  /** The page, attachment or folder that moved (one entry). */
  moved: { from: string; to: string }[];
  /** Pages whose links were rewritten to follow the move. */
  rewritten: string[];
  /** Pages whose links could not be updated, and why. They are left as they were. */
  skipped: { path: string; reason: string }[];
}

interface PageRow {
  id: string;
  path: string;
  title: string;
  content_hash: string;
  size: number;
  mtime_ms: number;
  [key: string]: string | number;
}

/**
 * A Private Space vault: Markdown files are the source of truth, SQLite is a
 * rebuildable index (ADR-001). No method performs network access.
 */
export class Vault {
  readonly fs: VaultFs;
  readonly sql: SqlDriver;
  private readonly now: () => number;
  /** Serializes index mutations: the SQL port is one connection, and BEGIN/COMMIT must not interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(options: VaultOptions) {
    this.fs = options.fs;
    this.sql = options.sql;
    this.now = options.now ?? Date.now;
  }

  /** Opens (or initializes) a vault, recovers the journal, and reconciles the index. */
  static async open(options: VaultOptions): Promise<{ vault: Vault; report: ReconcileReport }> {
    const vault = new Vault(options);
    await vault.ensureLayout();
    // Another window may be writing the index right now (ADR-0019): wait for it a little, then say so.
    await whileBusy(() => vault.ensureIndexSchema());
    const { recovered, invalid } = options.recover === false ? { recovered: 0, invalid: [] } : await vault.recoverJournal();
    const report = await whileBusy(() => vault.reconcile());
    report.recoveredJournalEntries = recovered;
    for (const path of invalid) report.warnings.push({ path, code: "invalid_journal_entry", message: "Journal file ignored: it is malformed or names a path outside Thoth's temp directory" });
    return { vault, report };
  }

  /**
   * Journal recovery, as `open` runs it, for a window that opened with `recover: false` and is now the only one on the
   * folder (ADR-0019): what is left in the journal and `.thoth/tmp` is what a closed window left, not work in flight.
   * Reconciles afterwards (a delete it undid puts a page back).
   */
  async recover(): Promise<ReconcileReport> {
    return this.exclusive(async () => {
      const { recovered, invalid } = await this.recoverJournal();
      const report = await this.reconcileNow();
      report.recoveredJournalEntries = recovered;
      for (const path of invalid) report.warnings.push({ path, code: "invalid_journal_entry", message: "Journal file ignored: it is malformed or names a path outside Thoth's temp directory" });
      return report;
    });
  }

  /** Waits for in-flight writes and reconciles, then closes the index. Later mutations reject. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.sql.close();
  }

  private async ensureLayout(): Promise<void> {
    for (const dir of [THOTH_DIR, `${THOTH_DIR}/operations`, JOURNAL_DIR, `${THOTH_DIR}/manifests`, `${THOTH_DIR}/sync`, TEMP_DIR]) await this.fs.mkdirp(dir);
    if (!(await this.fs.stat(CONFIG_PATH))) {
      const config = { configVersion: CONFIG_VERSION, vaultId: newStableId(this.now()), createdAt: new Date(this.now()).toISOString() };
      await this.fs.writeFile(CONFIG_PATH, encodeText(JSON.stringify(config, null, 2) + "\n"), { exclusive: true });
    }
  }

  private async ensureIndexSchema(): Promise<void> {
    await this.sql.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = await this.sql.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'version'");
    if (row && Number(row.value) !== INDEX_SCHEMA_VERSION) {
      // The index is a cache: drop everything and rebuild from files.
      // Drop every user table; dropping an FTS5 virtual table drops its shadow tables too.
      const tables = await this.sql.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
      for (const t of tables) await this.sql.exec(`DROP TABLE IF EXISTS "${t.name.replace(/"/g, '""')}"`);
    }
    await this.sql.exec(INDEX_DDL);
    await this.sql.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)", [String(INDEX_SCHEMA_VERSION)]);
  }

  /**
   * Discards orphaned temp files after a crash. Only ever deletes files inside
   * `.thoth/tmp/`; journal entries are validated so they cannot name anything
   * else, and invalid journal files are left in place for inspection.
   */
  private async recoverJournal(): Promise<{ recovered: number; invalid: string[] }> {
    const { entries, invalid } = await readPendingJournal(this.fs);
    for (const entry of entries) {
      // An interrupted delete: put the file back where it was (never over something new); the caller retries.
      if (entry.kind === "delete-file" && (await this.fs.stat(journalTempPath(entry.id)))?.kind === "file") {
        await this.fs.mkdirp(dirname(entry.path));
        try {
          await this.fs.rename(journalTempPath(entry.id), entry.path, { noReplace: true });
        } catch (error) {
          if ((error as { code?: unknown }).code !== "EEXIST") throw error;
          // Something new took the path meanwhile: keep the old bytes next to it rather than lose either.
          await this.fs.rename(journalTempPath(entry.id), await this.freeSiblingPath(entry.path, "recovered"), { noReplace: true });
        }
      }
      await this.fs.remove(journalTempPath(entry.id));
      await clearJournalEntry(this.fs, entry.id);
    }
    if (await this.fs.stat(TEMP_DIR)) {
      for (const item of await this.fs.list(TEMP_DIR)) {
        if (item.kind === "file" && item.name.endsWith(".tmp")) await this.fs.remove(`${TEMP_DIR}/${item.name}`);
      }
    }
    return { recovered: entries.length, invalid };
  }

  // ---------------------------------------------------------------- scanning

  /** Lists vault files, skipping ignored directories and never following symlinks. */
  async scanFiles(): Promise<{ files: string[]; skipped: { path: string; reason: string }[] }> {
    const files: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await this.fs.list(dir)) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.kind === "directory") {
          if (!IGNORED_DIRS.has(entry.name) && !isReservedPath(entry.name)) await walk(path);
        } else if (entry.kind === "file") {
          if (entry.name !== ".DS_Store") files.push(path);
        } else {
          skipped.push({ path, reason: entry.kind === "symlink" ? "symlink not followed" : "not a regular file" });
        }
      }
    };
    await walk("");
    files.sort();
    return { files, skipped };
  }

  // ----------------------------------------------------------- reconciliation

  /**
   * Brings the index in line with the filesystem. Uses (size, mtime) as a fast
   * path and the content hash as the authority. Safe to call at any time; the
   * filesystem watcher only needs to trigger it.
   */
  async reconcile(options: { full?: boolean } = {}): Promise<ReconcileReport> {
    return this.exclusive(() => this.reconcileNow(options));
  }

  /** Runs `task` after every earlier mutation has settled, so the watcher, saves and imports never overlap. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Vault is closed"));
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async reconcileNow(options: { full?: boolean } = {}): Promise<ReconcileReport> {
    const scanned = await this.scanFiles();
    return this.inIndexTransaction(() => this.reconcileFiles(scanned, options));
  }

  /**
   * `task` in one index transaction that takes the write lock up front (`BEGIN IMMEDIATE`, ADR-0019), so another window's
   * transaction waits for it rather than interleaving, and other connections see all of it or none of it. Rolls back
   * when `task` fails. Then the report's frontmatter warnings, read from what was committed.
   */
  private async inIndexTransaction(task: () => Promise<ReconcileReport>): Promise<ReconcileReport> {
    await this.sql.exec("BEGIN IMMEDIATE");
    let report: ReconcileReport;
    try {
      report = await task();
      await this.sql.exec("COMMIT");
    } catch (error) {
      // The failure that matters is the task's; a rollback that fails too (SQLite already rolled back) adds nothing.
      await this.sql.exec("ROLLBACK").catch(() => undefined);
      throw error;
    }
    const fmErrors = await this.sql.all<{ path: string; frontmatter_error: string }>(
      "SELECT path, frontmatter_error FROM pages WHERE frontmatter_error IS NOT NULL",
    );
    for (const row of fmErrors) report.warnings.push({ path: row.path, code: "malformed_frontmatter", message: row.frontmatter_error });
    return report;
  }

  /**
   * The body of a reconcile, inside the caller's transaction. What the index knows is read here, under the write lock:
   * another window's reconcile that committed just before cannot leave this one working from rows that changed.
   */
  private async reconcileFiles({ files, skipped }: { files: string[]; skipped: { path: string; reason: string }[] }, options: { full?: boolean }): Promise<ReconcileReport> {
    const report: ReconcileReport = { added: [], updated: [], removed: [], unchanged: 0, warnings: [], recoveredJournalEntries: 0 };
    for (const s of skipped) report.warnings.push({ path: s.path, code: "skipped_entry", message: s.reason });

    const known = new Map<string, PageRow>();
    for (const row of await this.sql.all<PageRow>("SELECT id, path, title, content_hash, size, mtime_ms FROM pages")) known.set(row.path, row);
    const knownAttachments = new Map<string, { hash: string; size: number; mtime_ms: number }>();
    for (const row of await this.sql.all<{ path: string; hash: string; size: number; mtime_ms: number }>("SELECT path, hash, size, mtime_ms FROM attachments"))
      knownAttachments.set(row.path, row);

    const markdown = files.filter(isMarkdownPath);
    const others = files.filter((f) => !isMarkdownPath(f));
    const parsed: { path: string; doc: PageDocument; hash: string; size: number; mtimeMs: number; isNew: boolean }[] = [];
    let structureChanged = false;

    for (const path of markdown) {
      const prev = known.get(path);
      known.delete(path);
      // One unreadable or pathological file must never make the vault unusable.
      try {
        const stat = await this.fs.stat(path);
        if (!stat) continue;
        if (!options.full && prev && prev.size === stat.size && prev.mtime_ms === stat.mtimeMs) {
          report.unchanged++;
          continue;
        }
        const bytes = await this.fs.readFile(path);
        const hash = sha256Hex(bytes);
        if (!options.full && prev && prev.content_hash === hash) {
          await this.sql.run("UPDATE pages SET mtime_ms = ?, size = ? WHERE path = ?", [stat.mtimeMs, stat.size, path]);
          report.unchanged++;
          continue;
        }
        parsed.push({ path, doc: parsePage(path, decodeText(bytes).text), hash, size: stat.size, mtimeMs: stat.mtimeMs, isNew: !prev });
        structureChanged = true;
      } catch (error) {
        // Keep the previous index row (if any) rather than dropping the page.
        if (prev) known.delete(path);
        report.warnings.push({ path, code: "unreadable_file", message: `Not indexed: ${(error as Error).message}` });
      }
    }

    for (const [path, row] of known) {
      await this.deletePageRows(row.id);
      await this.sql.run("DELETE FROM index_warnings WHERE path = ?", [path]);
      report.removed.push(path);
      structureChanged = true;
    }
    for (const p of parsed) {
      await this.upsertPage(p.path, p.doc, p.hash, p.size, p.mtimeMs);
      (p.isNew ? report.added : report.updated).push(p.path);
    }

    for (const path of others) {
      const prev = knownAttachments.get(path);
      knownAttachments.delete(path);
      let stat;
      let hash: string;
      try {
        stat = await this.fs.stat(path);
        if (!stat) continue;
        if (!options.full && prev && prev.size === stat.size && prev.mtime_ms === stat.mtimeMs) continue;
        hash = sha256Hex(await this.fs.readFile(path));
      } catch (error) {
        report.warnings.push({ path, code: "unreadable_file", message: `Not indexed: ${(error as Error).message}` });
        continue;
      }
      await this.sql.run("INSERT OR REPLACE INTO attachments (path, hash, size, mtime_ms, mime_type) VALUES (?, ?, ?, ?, ?)", [
        path,
        hash,
        stat.size,
        stat.mtimeMs,
        mimeTypeFor(path),
      ]);
      if (!prev) structureChanged = true;
    }
    for (const path of knownAttachments.keys()) {
      await this.sql.run("DELETE FROM attachments WHERE path = ?", [path]);
      structureChanged = true;
    }

    if (structureChanged || options.full) await this.settleClaims();
    // Link targets depend on the whole file set, so re-resolve when it changes.
    if (structureChanged || options.full) await this.resolveAllReferences();
    await this.flagDuplicateIds(report);
    return report;
  }

  /**
   * Drops the whole index and rebuilds it from files (index loss is never content loss), in one transaction: other
   * windows go on reading the old index until the new one is committed, and a rebuild that fails leaves the old one.
   */
  async rebuildIndex(): Promise<ReconcileReport> {
    return this.exclusive(() =>
      this.inIndexTransaction(async () => {
        for (const table of ["pages", "page_aliases", "page_tags", "blocks", "refs", "attachments", "search_content", "search_trigram", "index_warnings"])
          await this.sql.exec(`DELETE FROM ${table}`);
        return this.reconcileFiles(await this.scanFiles(), { full: true });
      }),
    );
  }

  private pageIdFor(doc: PageDocument): string {
    return doc.thothId ?? provisionalPageId(doc.path);
  }

  /**
   * Duplicate thoth_id handling (ADR-0003): among all files claiming the same
   * ID, `claimOwner` picks the owner from their paths alone — never from scan
   * order — so ownership is identical after any reconcile or rebuild. Every
   * other claimant is indexed under its provisional ID and warned about.
   */
  private async settleClaims(): Promise<void> {
    await this.sql.run("DELETE FROM index_warnings WHERE code = 'duplicate_id'");
    const rows = await this.sql.all<{ path: string; claimed_id: string; id: string }>("SELECT path, claimed_id, id FROM pages ORDER BY claimed_id");
    const groups = new Map<string, string[]>();
    for (const row of rows) groups.set(row.claimed_id, [...(groups.get(row.claimed_id) ?? []), row.path]);
    const current = new Map(rows.map((r) => [r.path, r.id]));
    // Demote first so the claimed ID is free before the owner takes it.
    const owners: [string, string][] = [];
    for (const [claimed, paths] of groups) {
      const owner = claimOwner(paths);
      for (const path of paths) {
        if (path === owner) continue;
        if (current.get(path) !== provisionalPageId(path)) await this.reassignPageId(path, provisionalPageId(path));
        await this.sql.run("INSERT INTO index_warnings (path, code, message) VALUES (?, 'duplicate_id', ?)", [path, `thoth_id ${claimed} is also used by ${owner}`]);
      }
      owners.push([owner, claimed]);
    }
    for (const [owner, claimed] of owners) if (current.get(owner) !== claimed) await this.reassignPageId(owner, claimed);
  }

  /** Moves every index row of a page to a new ID (used when a duplicate thoth_id changes owner). */
  private async reassignPageId(path: string, newId: string): Promise<void> {
    const row = await this.sql.get<{ id: string }>("SELECT id FROM pages WHERE path = ?", [path]);
    if (!row || row.id === newId) return;
    for (const table of ["page_aliases", "page_tags", "blocks", "search_content", "search_trigram"])
      await this.sql.run(`UPDATE ${table} SET page_id = ? WHERE page_id = ?`, [newId, row.id]);
    await this.sql.run("UPDATE refs SET source_page_id = ? WHERE source_page_id = ?", [newId, row.id]);
    await this.sql.run("UPDATE pages SET id = ?, stable_id = ? WHERE path = ?", [newId, isStableId(newId) ? 1 : 0, path]);
  }

  private async deletePageRows(id: string): Promise<void> {
    for (const table of ["page_aliases", "page_tags", "blocks"]) await this.sql.run(`DELETE FROM ${table} WHERE page_id = ?`, [id]);
    await this.sql.run("DELETE FROM refs WHERE source_page_id = ?", [id]);
    await this.sql.run("DELETE FROM search_content WHERE page_id = ?", [id]);
    await this.sql.run("DELETE FROM search_trigram WHERE page_id = ?", [id]);
    await this.sql.run("DELETE FROM pages WHERE id = ?", [id]);
  }

  private async upsertPage(path: string, doc: PageDocument, hash: string, size: number, mtimeMs: number): Promise<void> {
    const existing = await this.sql.get<{ id: string }>("SELECT id FROM pages WHERE path = ?", [path]);
    if (existing) await this.deletePageRows(existing.id);
    await this.sql.run("DELETE FROM index_warnings WHERE path = ?", [path]);
    const claimed = this.pageIdFor(doc);
    // Insert under a provisional ID; `settleClaims` assigns the claimed ID afterwards.
    const id = provisionalPageId(path);
    await this.sql.run(
      "INSERT INTO pages (id, claimed_id, path, path_key, title, content_hash, size, mtime_ms, stable_id, frontmatter_error, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, claimed, path, collisionKey(path), doc.title, hash, size, mtimeMs, isStableId(id) ? 1 : 0, doc.frontmatterError ?? null, this.now()],
    );
    for (const alias of doc.aliases) await this.sql.run("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)", [id, alias]);
    for (const tag of doc.tags) await this.sql.run("INSERT INTO page_tags (page_id, tag) VALUES (?, ?)", [id, tag]);
    let ord = 0;
    for (const block of doc.blocks) {
      await this.sql.run("INSERT INTO blocks (page_id, ord, type, anchor, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)", [
        id,
        ord++,
        block.type,
        block.anchor ?? null,
        block.range.startLine,
        block.range.endLine,
      ]);
    }
    ord = 0;
    for (const ref of doc.references) {
      await this.sql.run(
        "INSERT INTO refs (source_page_id, ord, syntax, target, fragment, external, resolution, target_path, line) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        [id, ord++, ref.syntax, ref.target, ref.fragment ?? null, ref.external ? 1 : 0, ref.external ? "external" : "unresolved", ref.range.startLine],
      );
    }
    const searchable = [doc.title, doc.aliases.join(" "), doc.plainText].join("\n");
    await this.sql.run("INSERT INTO search_content (page_id, title, body) VALUES (?, ?, ?)", [id, doc.title, searchable]);
    await this.sql.run("INSERT INTO search_trigram (page_id, title, body) VALUES (?, ?, ?)", [id, doc.title, searchable]);
  }

  private async resolveAllReferences(): Promise<void> {
    const pages = await this.sql.all<{ id: string; path: string }>("SELECT id, path FROM pages");
    const attachments = await this.sql.all<{ path: string }>("SELECT path FROM attachments");
    const aliasRows = await this.sql.all<{ page_id: string; alias: string }>("SELECT page_id, alias FROM page_aliases");
    const pathById = new Map(pages.map((p) => [p.id, p.path]));
    const aliases = new Map<string, string[]>();
    for (const row of aliasRows) {
      const path = pathById.get(row.page_id);
      if (path) aliases.set(path, [...(aliases.get(path) ?? []), row.alias]);
    }
    const resolver = new LinkResolver(
      [...pages.map((p) => p.path), ...attachments.map((a) => a.path)],
      pages.map((p) => ({ path: p.path, aliases: aliases.get(p.path) ?? [] })),
    );
    const refs = await this.sql.all<{ source_page_id: string; ord: number; syntax: string; target: string; external: number }>(
      "SELECT source_page_id, ord, syntax, target, external FROM refs",
    );
    for (const ref of refs) {
      const from = pathById.get(ref.source_page_id);
      if (!from) continue;
      const result = resolver.resolve(from, {
        syntax: ref.syntax as "wikilink",
        target: ref.target,
        external: ref.external === 1,
      });
      await this.sql.run("UPDATE refs SET resolution = ?, target_path = ? WHERE source_page_id = ? AND ord = ?", [
        result.state,
        result.state === "resolved" ? result.path : null,
        ref.source_page_id,
        ref.ord,
      ]);
    }
  }

  private async flagDuplicateIds(report: ReconcileReport): Promise<void> {
    for (const row of await this.sql.all<{ path: string; code: string; message: string }>("SELECT path, code, message FROM index_warnings"))
      report.warnings.push(row);
  }

  // ------------------------------------------------------------------ reads

  async listPages(): Promise<PageSummary[]> {
    const rows = await this.sql.all<PageRow>("SELECT id, path, title, content_hash, size, mtime_ms FROM pages ORDER BY path");
    const aliases = await this.sql.all<{ page_id: string; alias: string }>("SELECT page_id, alias FROM page_aliases");
    const tags = await this.sql.all<{ page_id: string; tag: string }>("SELECT page_id, tag FROM page_tags");
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      title: r.title,
      contentHash: r.content_hash,
      size: r.size,
      mtimeMs: r.mtime_ms,
      aliases: aliases.filter((a) => a.page_id === r.id).map((a) => a.alias),
      tags: tags.filter((t) => t.page_id === r.id).map((t) => t.tag),
    }));
  }

  async pageByPath(path: string): Promise<PageSummary | undefined> {
    return (await this.listPages()).find((p) => p.path === normalizeVaultPath(path));
  }

  async readPage(path: string): Promise<ReadResult> {
    const normalized = normalizeVaultPath(path);
    const stat = await this.fs.stat(normalized);
    if (!stat || stat.kind !== "file") throw new NotFoundError(`Page ${normalized}`);
    const bytes = await this.fs.readFile(normalized);
    const { text: source, editable } = decodeText(bytes);
    return { path: normalized, source, hash: sha256Hex(bytes), document: parsePage(normalized, source), editable };
  }

  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const tokens = tokenize(query);
    const hits = new Map<string, SearchHit>();
    const word = wordMatch(tokens);
    if (word) {
      for (const row of await this.sql.all<{ page_id: string; snippet: string }>(
        "SELECT page_id, snippet(search_content, 2, '[', ']', '…', 12) AS snippet FROM search_content WHERE search_content MATCH ? ORDER BY bm25(search_content, 0, 5, 1) LIMIT ?",
        [word, limit],
      ))
        hits.set(row.page_id, { id: row.page_id, path: "", title: "", snippet: row.snippet });
    }
    const tri = trigramMatch(tokens);
    if (tri && hits.size < limit) {
      for (const row of await this.sql.all<{ page_id: string; snippet: string }>(
        "SELECT page_id, snippet(search_trigram, 2, '[', ']', '…', 12) AS snippet FROM search_trigram WHERE search_trigram MATCH ? ORDER BY bm25(search_trigram, 0, 5, 1) LIMIT ?",
        [tri, limit],
      ))
        if (!hits.has(row.page_id)) hits.set(row.page_id, { id: row.page_id, path: "", title: "", snippet: row.snippet });
    }
    const results: SearchHit[] = [];
    for (const hit of [...hits.values()].slice(0, limit)) {
      const page = await this.sql.get<{ path: string; title: string }>("SELECT path, title FROM pages WHERE id = ?", [hit.id]);
      if (page) results.push({ ...hit, path: page.path, title: page.title });
    }
    return results;
  }

  async backlinks(path: string): Promise<Backlink[]> {
    return (
      await this.sql.all<{ id: string; path: string; title: string; line: number; syntax: string }>(
        "SELECT p.id, p.path, p.title, r.line, r.syntax FROM refs r JOIN pages p ON p.id = r.source_page_id WHERE r.target_path = ? AND r.resolution = 'resolved' AND p.path <> ? ORDER BY p.path, r.line",
        [normalizeVaultPath(path), normalizeVaultPath(path)],
      )
    ).map((r) => ({ sourceId: r.id, sourcePath: r.path, sourceTitle: r.title, line: r.line, syntax: r.syntax }));
  }

  async outgoingLinks(path: string): Promise<{ target: string; fragment: string | null; resolution: string; targetPath: string | null; line: number }[]> {
    const page = await this.sql.get<{ id: string }>("SELECT id FROM pages WHERE path = ?", [normalizeVaultPath(path)]);
    if (!page) throw new NotFoundError(`Page ${path}`);
    return (
      await this.sql.all<{ target: string; fragment: string | null; resolution: string; target_path: string | null; line: number }>(
        "SELECT target, fragment, resolution, target_path, line FROM refs WHERE source_page_id = ? ORDER BY ord",
        [page.id],
      )
    ).map((r) => ({ target: r.target, fragment: r.fragment, resolution: r.resolution, targetPath: r.target_path, line: r.line }));
  }

  async unresolvedLinks(): Promise<{ sourcePath: string; target: string; resolution: string; line: number }[]> {
    return (
      await this.sql.all<{ path: string; target: string; resolution: string; line: number }>(
        "SELECT p.path, r.target, r.resolution, r.line FROM refs r JOIN pages p ON p.id = r.source_page_id WHERE r.resolution IN ('unresolved', 'ambiguous') ORDER BY p.path, r.line",
      )
    ).map((r) => ({ sourcePath: r.path, target: r.target, resolution: r.resolution, line: r.line }));
  }

  /** Nodes and resolved edges between pages for the basic graph view. */
  async graph(): Promise<{ nodes: { id: string; path: string; title: string }[]; edges: { from: string; to: string }[] }> {
    const nodes = await this.sql.all<{ id: string; path: string; title: string }>("SELECT id, path, title FROM pages ORDER BY path");
    const edges = await this.sql.all<{ from: string; to: string }>(
      'SELECT DISTINCT r.source_page_id AS "from", p.id AS "to" FROM refs r JOIN pages p ON p.path = r.target_path WHERE r.resolution = \'resolved\' AND r.source_page_id <> p.id',
    );
    return { nodes, edges };
  }

  async listAttachments(): Promise<{ path: string; hash: string; size: number; mimeType: string }[]> {
    return (await this.sql.all<{ path: string; hash: string; size: number; mime_type: string }>("SELECT path, hash, size, mime_type FROM attachments ORDER BY path")).map(
      (r) => ({ path: r.path, hash: r.hash, size: r.size, mimeType: r.mime_type }),
    );
  }

  // ----------------------------------------------------------------- writes

  /**
   * Atomically writes a file with compare-and-swap on its content hash
   * (ADR-001 §5–7). Never overwrites a file changed since the caller read it.
   */
  async writeFileAtomic(path: string, data: Uint8Array, options: WriteOptions): Promise<string> {
    return this.exclusive(() => this.writeFileAtomicNow(path, data, options));
  }

  private async writeFileAtomicNow(path: string, data: Uint8Array, options: WriteOptions, reconcile = true): Promise<string> {
    const normalized = normalizeVaultPath(path);
    if (isReservedPath(normalized)) throw new Error("Refusing to write vault content into .thoth/");
    const currentHash = await this.currentHash(normalized);
    if (currentHash !== options.expectedHash) throw new ConflictError(normalized, options.expectedHash, currentHash);

    const id = newStableId(this.now());
    const tempPath = journalTempPath(id);
    const newHash = sha256Hex(data);
    const entry: JournalEntry = { id, kind: "write-file", path: normalized, tempPath, expectedHash: options.expectedHash, newHash, createdAt: this.now() };
    await writeJournalEntry(this.fs, entry);
    try {
      await this.fs.writeFile(tempPath, data, { exclusive: true });
      await this.fs.mkdirp(dirname(normalized));
      // Re-check immediately before the rename to narrow the race with external editors.
      const latest = await this.currentHash(normalized);
      if (latest !== options.expectedHash) throw new ConflictError(normalized, options.expectedHash, latest);
      // The host compares and renames as one step, so another window's save that lands after the check above is a
      // conflict here rather than a write lost under this one (ADR-0019).
      await this.fs.rename(tempPath, normalized, options.expectedHash === null ? { noReplace: true } : { replaceHash: options.expectedHash });
    } catch (error) {
      await this.fs.remove(tempPath);
      await clearJournalEntry(this.fs, id);
      const code = (error as { code?: unknown }).code;
      if ((options.expectedHash === null && code === "EEXIST") || code === "CONFLICT") {
        throw new ConflictError(normalized, options.expectedHash, await this.currentHash(normalized));
      }
      throw error;
    }
    await clearJournalEntry(this.fs, id);
    if (reconcile) await this.reindexAfterChange();
    return newHash;
  }

  /**
   * Brings the index up to date after a change to the files has landed. The change stands even if this fails (for
   * example the index stayed busy in another window past SQLite's wait, ADR-0019): the index is a cache, so the failure
   * is not the caller's, and a reconcile is queued to catch up (the watcher triggers more).
   */
  private async reindexAfterChange(): Promise<void> {
    try {
      await this.reconcileNow();
    } catch {
      void this.reconcile().catch(() => undefined);
    }
  }

  /**
   * Deletes a file only if it still has `expectedHash` (compare-and-swap, ADR-0001 §5). The file is first
   * renamed to Thoth's own temp path under a `delete-file` journal entry and hashed there, so an edit that
   * lands before the rename is caught by the hash and one that lands after it creates a new file that is
   * left alone. A mismatch puts the bytes back and throws `ConflictError`; a crash at any point is undone
   * by recovery, which restores the file. Used by transfers to finalize a move (ADR-0006 §6).
   */
  async deleteFileAtomic(path: string, options: { expectedHash: string }): Promise<void> {
    return this.exclusive(async () => {
      const normalized = normalizeVaultPath(path);
      if (isReservedPath(normalized)) throw new Error("Refusing to delete Thoth metadata through the content API");
      const before = await this.currentHash(normalized);
      if (before !== options.expectedHash) throw new ConflictError(normalized, options.expectedHash, before);
      const id = newStableId(this.now());
      const tempPath = journalTempPath(id);
      await writeJournalEntry(this.fs, { id, kind: "delete-file", path: normalized, tempPath, expectedHash: options.expectedHash, newHash: null, createdAt: this.now() });
      await this.fs.rename(normalized, tempPath);
      const moved = sha256Hex(await this.fs.readFile(tempPath));
      if (moved !== options.expectedHash) {
        try {
          await this.fs.rename(tempPath, normalized, { noReplace: true });
        } catch (error) {
          if ((error as { code?: unknown }).code !== "EEXIST") throw error;
          await this.fs.rename(tempPath, await this.freeSiblingPath(normalized, "recovered"), { noReplace: true });
        }
        await clearJournalEntry(this.fs, id);
        await this.reindexAfterChange();
        throw new ConflictError(normalized, options.expectedHash, moved);
      }
      await this.fs.remove(tempPath);
      await clearJournalEntry(this.fs, id);
      await this.reindexAfterChange();
    });
  }

  /** `Name (label).md`, then `Name (label 2).md`… next to `path`, the first that does not exist. */
  private async freeSiblingPath(path: string, label: string): Promise<string> {
    const dir = dirname(path);
    const base = path.slice(dir === "" ? 0 : dir.length + 1);
    const dot = base.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
    for (let n = 1; n < 1000; n++) {
      const name = `${stem} (${label}${n === 1 ? "" : ` ${n}`})${ext}`;
      const candidate = dir === "" ? name : `${dir}/${name}`;
      if (!(await this.fs.stat(candidate))) return candidate;
    }
    throw new Error(`No free name next to ${path}`);
  }

  // ------------------------------------------------------------ moves, folders

  /**
   * Moves (or renames) a page, an attachment or a folder inside the vault and updates the links that pointed at
   * what moved (ADR-0016 rule 4: a move in the tree is a file move, and links follow it).
   *
   * - The target must not exist (`ConflictError`), except a rename that only changes letter case.
   * - `expectedHash` (files only) is compare-and-swap on the source bytes, like every other write (ADR-0001 §5).
   * - Links: every resolved link in the vault is resolved again against the file set after the move. A link that
   *   no longer reaches the same file is rewritten in place (`rewriteTargets`, byte for byte outside the target):
   *   a wikilink or embed to the shortest form that resolves, a Markdown link to a relative path. That includes
   *   relative links inside moved pages. Each rewrite is its own compare-and-swap write on the bytes just read; a
   *   page that changed meanwhile, is not UTF-8 or cannot carry the new target is left alone and reported.
   *
   * Crash safety: the rename is one atomic filesystem operation, so a page is always at its old path or its new
   * one, never lost or doubled. A crash after the rename and before every link is rewritten leaves some links
   * unresolved (they show as such and can be fixed), never lost content. Frontmatter (`title:`) is not touched.
   */
  async move(from: string, to: string, options: { expectedHash?: string } = {}): Promise<MoveReport> {
    return this.exclusive(async () => {
      const src = normalizeVaultPath(from);
      const dst = normalizeVaultPath(to);
      if (isReservedPath(src) || isReservedPath(dst)) throw new Error("Refusing to move Thoth metadata (.thoth/)");
      if (src === dst) throw new Error("The source and the destination are the same");
      const stat = await this.fs.stat(src);
      if (!stat) throw new NotFoundError(`"${src}"`);
      if (stat.kind !== "file" && stat.kind !== "directory") throw new Error(`"${src}" is not a file or a folder`);
      const folder = stat.kind === "directory";
      const caseOnly = collisionKey(src) === collisionKey(dst);
      if (folder && collisionKey(dst).startsWith(`${collisionKey(src)}/`)) throw new Error("A folder cannot move into itself");
      if (caseOnly ? await this.existsExactly(dst) : await this.fs.stat(dst)) throw new ConflictError(dst, null, (await this.hashOrKind(dst)) ?? "exists");
      if (!folder && options.expectedHash !== undefined) {
        const current = await this.currentHash(src);
        if (current !== options.expectedHash) throw new ConflictError(src, options.expectedHash, current);
      }

      // The index is the "before" picture: bring it up to date, then remember every resolved link.
      await this.reconcileNow();
      const pages = await this.sql.all<{ id: string; path: string }>("SELECT id, path FROM pages");
      const attachments = await this.sql.all<{ path: string }>("SELECT path FROM attachments");
      const aliasRows = await this.sql.all<{ page_id: string; alias: string }>("SELECT page_id, alias FROM page_aliases");
      const refs = await this.sql.all<{ source_page_id: string; ord: number; syntax: string; target: string; target_path: string }>(
        "SELECT source_page_id, ord, syntax, target, target_path FROM refs WHERE resolution = 'resolved' AND external = 0 AND target_path IS NOT NULL ORDER BY source_page_id, ord",
      );
      const map = (path: string): string => (folder ? (path.startsWith(`${src}/`) ? dst + path.slice(src.length) : path) : path === src ? dst : path);

      await this.fs.mkdirp(dirname(dst));
      await this.fs.rename(src, dst, { noReplace: !folder && !caseOnly });
      const report: MoveReport = { moved: [{ from: src, to: dst }], rewritten: [], skipped: [] };

      const pathById = new Map(pages.map((p) => [p.id, p.path]));
      const aliases = new Map<string, string[]>();
      for (const row of aliasRows) {
        const path = pathById.get(row.page_id);
        if (path) aliases.set(map(path), [...(aliases.get(map(path)) ?? []), row.alias]);
      }
      const after = new LinkResolver(
        [...pages.map((p) => map(p.path)), ...attachments.map((a) => map(a.path))],
        pages.map((p) => ({ path: map(p.path), aliases: aliases.get(map(p.path)) ?? [] })),
      );
      // Pages (by their path after the move) with links that would now miss their target.
      const broken = new Map<string, { ord: number; syntax: string; target: string; want: string }[]>();
      for (const ref of refs) {
        const source = pathById.get(ref.source_page_id);
        if (!source) continue;
        const at = map(source);
        const want = map(ref.target_path);
        const now = after.resolve(at, { syntax: ref.syntax as ParsedReference["syntax"], target: ref.target, external: false });
        if (now.state === "resolved" && now.path === want) continue;
        broken.set(at, [...(broken.get(at) ?? []), { ord: ref.ord, syntax: ref.syntax, target: ref.target, want }]);
      }

      for (const [path, list] of broken) {
        try {
          const bytes = await this.fs.readFile(path);
          const { text, editable } = decodeText(bytes);
          if (!editable) {
            report.skipped.push({ path, reason: "not_utf8" });
            continue;
          }
          const doc = parsePage(path, text);
          const edits: TargetEdit[] = [];
          let unwritable = false;
          for (const item of list) {
            const reference = doc.references[item.ord];
            // The file must still say what the index saw; otherwise it changed underneath us.
            if (!reference || reference.syntax !== item.syntax || reference.target !== item.target) throw new ConflictError(path, null, sha256Hex(bytes));
            const target = newLinkTarget(after, path, reference, item.want);
            if (target === undefined) unwritable = true;
            else edits.push({ reference, newTarget: target });
          }
          if (unwritable) report.skipped.push({ path, reason: "link_not_rewritable" });
          if (edits.length === 0) continue;
          await this.writeFileAtomicNow(path, encodeText(rewriteTargets(text, edits)), { expectedHash: sha256Hex(bytes) }, false);
          report.rewritten.push(path);
        } catch (error) {
          report.skipped.push({ path, reason: error instanceof ConflictError ? "changed" : error instanceof Error ? error.message : String(error) });
        }
      }
      await this.reindexAfterChange();
      return report;
    });
  }

  /** Every folder in the vault (also empty ones), sorted; the same folders `scanFiles` walks. */
  async listFolders(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await this.fs.list(dir)) {
        if (entry.kind !== "directory" || IGNORED_DIRS.has(entry.name) || isReservedPath(entry.name)) continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        out.push(path);
        await walk(path);
      }
    };
    await walk("");
    return out.sort();
  }

  /**
   * Creates an empty folder (and the folders above it that are missing). A name that is already taken is a
   * `ConflictError`: also one that differs only in letter case or Unicode form (`collisionKey`), because the vault
   * may sit on a case-insensitive volume or move to one, and a file where a folder is needed counts as taken.
   */
  async createFolder(path: string): Promise<void> {
    return this.exclusive(async () => void (await this.createFolderNow(path)));
  }

  /**
   * Creates an empty folder named `name` in `parent` ("" is the top level), or `name 2`, `name 3`… when that is
   * taken, and returns its vault path. The check and the creation happen under the same lock, so two calls never
   * get the same name.
   */
  async createUniqueFolder(parent: string, name: string): Promise<string> {
    return this.exclusive(async () => {
      const dir = parent === "" ? "" : normalizeVaultPath(parent);
      const parentStat = dir === "" ? undefined : await this.fs.stat(dir);
      if (parentStat && parentStat.kind !== "directory") throw new ConflictError(dir, null, parentStat.kind);
      for (let n = 1; n < 1000; n++) {
        const candidate = n === 1 ? name : `${name} ${n}`;
        try {
          return await this.createFolderNow(dir === "" ? candidate : `${dir}/${candidate}`);
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
        }
      }
      throw new Error(`No free folder name like "${name}" in "${dir}"`);
    });
  }

  private async createFolderNow(path: string): Promise<string> {
    const normalized = normalizeVaultPath(path);
    if (isReservedPath(normalized)) throw new Error("The .thoth folder is reserved for Thoth");
    // Every segment is compared the way the vault compares names (case and Unicode form), not the way the disk does:
    // on a case-sensitive disk (Linux) "Inbox/welcome.MD/x" would otherwise make a folder beside the page welcome.md.
    // A folder on the way that exists under another case is reused, as macOS and Windows do.
    const segments = normalized.split("/");
    let made = "";
    for (const [i, segment] of segments.entries()) {
      const key = collisionKey(segment);
      const clash = (await this.fs.list(made)).find((entry) => collisionKey(entry.name) === key);
      const here = made === "" ? (clash?.name ?? segment) : `${made}/${clash?.name ?? segment}`;
      if (!clash) {
        made = [here, ...segments.slice(i + 1)].join("/");
        break;
      }
      if (i === segments.length - 1 || clash.kind !== "directory") throw new ConflictError(here, null, clash.kind);
      made = here;
    }
    await this.fs.mkdirp(made);
    return made;
  }

  /** Removes a folder that holds nothing but empty folders (and `.DS_Store`); anything else throws. */
  async removeEmptyFolder(path: string): Promise<void> {
    return this.exclusive(async () => {
      const normalized = normalizeVaultPath(path);
      if (isReservedPath(normalized)) throw new Error("The .thoth folder is reserved for Thoth");
      const stat = await this.fs.stat(normalized);
      if (!stat) return;
      if (stat.kind !== "directory") throw new Error(`"${normalized}" is not a folder`);
      const empty = async (dir: string): Promise<boolean> => {
        for (const entry of await this.fs.list(dir)) {
          if (entry.kind === "directory") {
            if (!(await empty(`${dir}/${entry.name}`))) return false;
          } else if (!(entry.kind === "file" && entry.name === ".DS_Store")) return false;
        }
        return true;
      };
      if (!(await empty(normalized))) throw new Error("Folder is not empty");
      await this.fs.remove(normalized);
      await this.reindexAfterChange();
    });
  }

  /** True when the parent folder lists exactly this name (case-sensitive), whatever the volume's case rules. */
  private async existsExactly(path: string): Promise<boolean> {
    const dir = dirname(path);
    if (dir !== "" && !(await this.fs.stat(dir))) return false;
    return (await this.fs.list(dir)).some((e) => e.name === basename(path));
  }

  private async hashOrKind(path: string): Promise<string | null> {
    const stat = await this.fs.stat(path);
    if (!stat) return null;
    return stat.kind === "file" ? sha256Hex(await this.fs.readFile(path)) : stat.kind;
  }

  // --------------------------------------------------------------- records

  /** Writes a durable `.thoth/` JSON record (see `writeRecordAtomic`). Never page content or secrets. */
  async writeRecord(path: string, value: unknown): Promise<void> {
    await writeRecordAtomic(this.fs, path, encodeText(JSON.stringify(value, null, 2) + "\n"), newStableId(this.now()));
  }

  /** The parsed record, or undefined when it does not exist. Malformed JSON throws. */
  async readRecord(path: string): Promise<unknown> {
    const normalized = recordPath(path);
    const stat = await this.fs.stat(normalized);
    if (!stat) return undefined;
    if (stat.kind !== "file") throw new Error(`${normalized} is not a file`);
    return JSON.parse(decodeText(await this.fs.readFile(normalized)).text) as unknown;
  }

  /**
   * A record's bytes as text with their SHA-256, for a compare-and-swap write (`writeRecordIfUnchanged`); undefined
   * when it does not exist. Unlike `readRecord`, nothing is parsed, so a broken record can still be replaced.
   */
  async readRecordText(path: string): Promise<{ text: string; hash: string } | undefined> {
    const normalized = recordPath(path);
    const stat = await this.fs.stat(normalized);
    if (!stat) return undefined;
    if (stat.kind !== "file") throw new Error(`${normalized} is not a file`);
    const bytes = await this.fs.readFile(normalized);
    return { text: decodeText(bytes).text, hash: sha256Hex(bytes) };
  }

  /**
   * Writes a record only while it still has `expectedHash` (null: only while it does not exist), as one step with the
   * check for every writer through the same host (two windows, ADR-0019). Otherwise throws `ConflictError` and writes
   * nothing. Returns the new hash.
   */
  async writeRecordIfUnchanged(path: string, value: unknown, expectedHash: string | null): Promise<string> {
    const normalized = recordPath(path);
    const data = encodeText(JSON.stringify(value, null, 2) + "\n");
    try {
      await writeRecordAtomic(this.fs, normalized, data, newStableId(this.now()), expectedHash === null ? { noReplace: true } : { replaceHash: expectedHash });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "EEXIST" || code === "CONFLICT") {
        const now = await this.fs.stat(normalized).then((st) => (st?.kind === "file" ? this.fs.readFile(normalized).then(sha256Hex) : null));
        throw new ConflictError(normalized, expectedHash, now);
      }
      throw error;
    }
    return sha256Hex(data);
  }

  /** Record file names (`*.json`) directly inside a `.thoth/` directory; empty when it does not exist. */
  async listRecords(dir: string): Promise<string[]> {
    const normalized = normalizeVaultPath(dir);
    if (!isReservedPath(normalized)) throw new Error("Records live under .thoth/");
    if (!(await this.fs.stat(normalized))) return [];
    return (await this.fs.list(normalized)).filter((e) => e.kind === "file" && e.name.endsWith(".json")).map((e) => e.name).sort();
  }

  async removeRecord(path: string): Promise<void> {
    await this.fs.remove(recordPath(path));
  }

  // ----------------------------------------------------------- projections

  /**
   * Index projections of durable records (ADR-0001 §2): `operation_journal`, `external_locations` and
   * `sync_state`. The records are the truth; these rows only make them queryable and are rebuilt from the
   * records by their owner (the transfer engine on open).
   */
  async projectOperation(row: { id: string; kind: string; state: string; updatedAt: number }): Promise<void> {
    await this.exclusive(() => this.sql.run("INSERT OR REPLACE INTO operation_journal (id, kind, state, updated_at) VALUES (?, ?, ?, ?)", [row.id, row.kind, row.state, row.updatedAt]));
  }

  async listOperationJournal(): Promise<{ id: string; kind: string; state: string; updatedAt: number }[]> {
    const rows = await this.sql.all<{ id: string; kind: string; state: string; updated_at: number }>("SELECT id, kind, state, updated_at FROM operation_journal ORDER BY id");
    return rows.map((r) => ({ id: r.id, kind: r.kind, state: r.state, updatedAt: r.updated_at }));
  }

  /** Replaces every projection row of one workspace (`workspaceUrl`) with `rows`. */
  async projectSyncRecords(workspaceUrl: string, rows: { pageId: string; remoteId: string; remoteRevision: string | null; baseHash: string | null }[]): Promise<void> {
    await this.exclusive(async () => {
      await this.sql.exec("BEGIN IMMEDIATE");
      try {
        await this.sql.run("DELETE FROM external_locations WHERE workspace_url = ?", [workspaceUrl]);
        await this.sql.run("DELETE FROM sync_state WHERE workspace_url = ?", [workspaceUrl]);
        for (const r of rows) {
          await this.sql.run("INSERT OR REPLACE INTO external_locations (page_id, workspace_url, remote_id) VALUES (?, ?, ?)", [r.pageId, workspaceUrl, r.remoteId]);
          await this.sql.run("INSERT OR REPLACE INTO sync_state (page_id, workspace_url, remote_revision, base_hash, pending) VALUES (?, ?, ?, ?, 0)", [r.pageId, workspaceUrl, r.remoteRevision, r.baseHash]);
        }
        await this.sql.exec("COMMIT");
      } catch (error) {
        await this.sql.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async listExternalLocations(): Promise<{ pageId: string; workspaceUrl: string; remoteId: string }[]> {
    const rows = await this.sql.all<{ page_id: string; workspace_url: string; remote_id: string }>("SELECT page_id, workspace_url, remote_id FROM external_locations ORDER BY workspace_url, page_id");
    return rows.map((r) => ({ pageId: r.page_id, workspaceUrl: r.workspace_url, remoteId: r.remote_id }));
  }

  private async currentHash(path: string): Promise<string | null> {
    const stat = await this.fs.stat(path);
    if (!stat) return null;
    if (stat.kind !== "file") throw new Error(`"${path}" is not a regular file`);
    return sha256Hex(await this.fs.readFile(path));
  }

  async writePage(path: string, source: string, options: WriteOptions): Promise<string> {
    const normalized = normalizeVaultPath(path);
    if (!/\.(md|markdown)$/i.test(normalized)) throw new Error("Pages must use a .md extension");
    return this.writeFileAtomic(normalized, encodeText(source), options);
  }

  /** Creates a new page with a stable `thoth_id`. Refuses to replace an existing file. */
  async createPage(path: string, body: string, frontmatter: Record<string, unknown> = {}): Promise<{ id: string; hash: string }> {
    const id = newStableId(this.now());
    const source = updateFrontmatter(body, { thoth_id: id, ...frontmatter });
    const hash = await this.writePage(path, source, { expectedHash: null });
    return { id, hash };
  }

  /**
   * Adopts a page by writing a stable `thoth_id` into its frontmatter (ADR-003).
   * Only called explicitly (e.g. before a transfer), never as a side effect of indexing.
   */
  async adoptPage(path: string): Promise<string> {
    const current = await this.readPage(path);
    if (current.document.thothId) return current.document.thothId;
    if (!current.editable) throw new NotEditableError(current.path);
    const id = newStableId(this.now());
    await this.writePage(current.path, updateFrontmatter(current.source, { thoth_id: id }), { expectedHash: current.hash });
    return id;
  }
}

/**
 * The target a link should carry to reach `want` from `from` after a move, or undefined when none resolves or
 * can be written. Wikilinks and embeds get the shortest form (`Name`, then the vault path, without `.md` for
 * pages); Markdown links get a relative path.
 */
function newLinkTarget(resolver: LinkResolver, from: string, reference: ParsedReference, want: string): string | undefined {
  const reaches = (target: string) => {
    const r = resolver.resolve(from, { syntax: reference.syntax, target, external: false });
    return r.state === "resolved" && r.path === want;
  };
  if (reference.syntax === "wikilink" || reference.syntax === "embed") {
    const candidates = isMarkdownPath(want) ? [stripExtension(basename(want)), stripExtension(want)] : [basename(want), want];
    return candidates.find((c) => !/[[\]|#\n]/.test(c) && reaches(c));
  }
  const relative = relativeLink(from, want);
  return reaches(relative) ? relative : undefined;
}
