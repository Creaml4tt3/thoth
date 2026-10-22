import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Arbitrary constant: serializes concurrent migrators (several server instances starting together). */
const MIGRATION_LOCK_KEY = 7_424_001;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

const FILE_PATTERN = /^(\d{3,})_[a-z0-9_]+\.sql$/;

/**
 * Applies `migrations/NNN_name.sql` in order, each in its own transaction, recording it in
 * `schema_migrations` with a checksum. An already-applied file whose content changed is an
 * error: migrations are append-only.
 */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f)).sort();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Map<string, string>((await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]));
    const applied: string[] = [];
    for (const file of files) {
      const sql = await readFile(new URL(file, `file://${dir.endsWith("/") ? dir : `${dir}/`}`), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`migration ${file} was modified after it was applied`);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      applied.push(file);
    }
    return { applied, alreadyApplied: files.length - applied.length };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
