import { decodeText, encodeText, LinkResolver, NotEditableError, parsePage, updateFrontmatter, type PageDocument } from "@thoth/content";
import {
  collisionKey,
  isMarkdownPath,
  isReservedPath,
  isStableId,
  newStableId,
  normalizeVaultPath,
  provisionalPageId,
  sha256Hex,
  dirname,
  type PageSummary,
} from "@thoth/domain";
import { ConflictError, NotFoundError } from "./errors.ts";
import {
  clearJournalEntry,
  JOURNAL_DIR,
  journalTempPath,
  readPendingJournal,
  TEMP_DIR,
  writeJournalEntry,
  type JournalEntry,
} from "./journal.ts";
import { mimeTypeFor } from "./mime.ts";
import type { SqlDriver, VaultFs } from "./ports.ts";
import { INDEX_DDL, INDEX_SCHEMA_VERSION } from "./schema.ts";
import { tokenize, trigramMatch, wordMatch } from "./search-query.ts";

export const THOTH_DIR = ".thoth";
const CONFIG_PATH = ".thoth/config.json";
const CONFIG_VERSION = 1;

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
    await vault.ensureIndexSchema();
    const { recovered, invalid } = await vault.recoverJournal();
    const report = await vault.reconcile();
    report.recoveredJournalEntries = recovered;
    for (const path of invalid) report.warnings.push({ path, code: "invalid_journal_entry", message: "Journal file ignored: it is malformed or names a path outside Thoth's temp directory" });
    return { vault, report };
  }

  /** Waits for in-flight writes and reconciles, then closes the index. Later mutations reject. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.sql.close();
  }

  private async ensureLayout(): Promise<void> {
    for (const dir of [THOTH_DIR, `${THOTH_DIR}/operations`, JOURNAL_DIR, `${THOTH_DIR}/manifests`, TEMP_DIR]) await this.fs.mkdirp(dir);
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
    const report: ReconcileReport = { added: [], updated: [], removed: [], unchanged: 0, warnings: [], recoveredJournalEntries: 0 };
    const { files, skipped } = await this.scanFiles();
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

    await this.sql.exec("BEGIN");
    try {
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
      await this.sql.exec("COMMIT");
    } catch (error) {
      await this.sql.exec("ROLLBACK");
      throw error;
    }

    const fmErrors = await this.sql.all<{ path: string; frontmatter_error: string }>(
      "SELECT path, frontmatter_error FROM pages WHERE frontmatter_error IS NOT NULL",
    );
    for (const row of fmErrors) report.warnings.push({ path: row.path, code: "malformed_frontmatter", message: row.frontmatter_error });
    return report;
  }

  /** Drops the whole index and rebuilds it from files (index loss is never content loss). */
  async rebuildIndex(): Promise<ReconcileReport> {
    return this.exclusive(async () => {
      await this.sql.exec("BEGIN");
      for (const table of ["pages", "page_aliases", "page_tags", "blocks", "refs", "attachments", "search_content", "search_trigram", "index_warnings"])
        await this.sql.exec(`DELETE FROM ${table}`);
      await this.sql.exec("COMMIT");
      return this.reconcileNow({ full: true });
    });
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

  private async writeFileAtomicNow(path: string, data: Uint8Array, options: WriteOptions): Promise<string> {
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
      await this.fs.rename(tempPath, normalized, { noReplace: options.expectedHash === null });
    } catch (error) {
      await this.fs.remove(tempPath);
      await clearJournalEntry(this.fs, id);
      if (options.expectedHash === null && (error as { code?: unknown }).code === "EEXIST") {
        throw new ConflictError(normalized, null, await this.currentHash(normalized));
      }
      throw error;
    }
    await clearJournalEntry(this.fs, id);
    await this.reconcileNow();
    return newHash;
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
