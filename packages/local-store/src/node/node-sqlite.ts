import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDriver, SqlRow, SqlValue } from "../ports.ts";

/** SqlDriver over Node's built-in SQLite (Node >= 24, FTS5 enabled). */
export class NodeSqlDriver implements SqlDriver {
  private readonly db: DatabaseSync;

  constructor(location: string) {
    this.db = new DatabaseSync(location);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
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
