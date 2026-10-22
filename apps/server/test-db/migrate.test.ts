import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { createTestDatabase } from "./helpers.ts";

describe("migration runner", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });
  const fresh = async () => {
    const database = await createTestDatabase();
    const pool = new pg.Pool({ connectionString: database.url, max: 5 });
    cleanup.push(async () => {
      await pool.end();
      await database.drop();
    });
    return pool;
  };

  it("applies the shipped migrations once, in order, and records them", async () => {
    const pool = await fresh();
    const first = await migrate(pool);
    expect(first.applied).toEqual(["001_core.sql", "002_idempotency.sql", "003_attachments_transfers_audit.sql", "004_search.sql", "005_change_notify.sql"]);
    const again = await migrate(pool);
    expect(again).toEqual({ applied: [], alreadyApplied: 5 });
    const rows = (await pool.query("SELECT name FROM schema_migrations ORDER BY name")).rows;
    expect(rows).toHaveLength(5);
  });

  it("several instances starting together apply each migration exactly once", async () => {
    const pool = await fresh();
    const results = await Promise.all(Array.from({ length: 4 }, () => migrate(pool)));
    expect(results.flatMap((r) => r.applied)).toHaveLength(5);
  });

  it("rolls a failing migration back completely and reports it; a modified applied migration is an error", async () => {
    const pool = await fresh();
    const dir = await mkdtemp(join(tmpdir(), "thoth-mig-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "001_ok.sql"), "CREATE TABLE a (id int);");
    await writeFile(join(dir, "002_bad.sql"), "CREATE TABLE b (id int); SELECT * FROM does_not_exist;");
    await expect(migrate(pool, dir)).rejects.toThrow(/002_bad.sql failed/);
    expect((await pool.query("SELECT to_regclass('b') AS t")).rows[0].t).toBeNull();
    expect((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name)).toEqual(["001_ok.sql"]);
    await writeFile(join(dir, "001_ok.sql"), "CREATE TABLE a (id int, extra int);");
    await writeFile(join(dir, "002_bad.sql"), "CREATE TABLE b (id int);");
    await expect(migrate(pool, dir)).rejects.toThrow(/001_ok.sql was modified/);
  });
});
