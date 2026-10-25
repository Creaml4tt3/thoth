import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDriver, SqlRow, SqlValue } from "../ports.ts";

/** SqlDriver over Node's built-in SQLite (Node >= 24, FTS5 enabled). */
export class NodeSqlDriver implements SqlDriver {
  private readonly db: DatabaseSync;

  /** `busyTimeoutMs`: how long a statement waits for another connection's write lock (5 s, as the Rust host). */
  constructor(location: string, options: { busyTimeoutMs?: number } = {}) {
    const busy = options.busyTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(busy) || busy < 0) throw new Error("busyTimeoutMs must be a whole number of milliseconds");
    this.db = new DatabaseSync(location);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busy};`);
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    const result = this.db.prepare(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(result.changes) };
  }

  async all<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  async get<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }

  async close(): Promise<void> {
    if (this.db.isOpen) this.db.close();
  }
}
