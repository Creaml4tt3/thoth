import pg from "pg";

/** What both a pool and a transaction client can do. Handlers take this so they work in either. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}
export type Tx = pg.PoolClient & Queryable;

export interface Database extends Queryable {
  readonly pool: pg.Pool;
  /** Runs `fn` in a transaction: commit on return, rollback on throw. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** `bigint` columns (sequence positions, counts) are far below 2^53, so they are plain numbers. */
const INT8_OID = 20;
const types = {
  getTypeParser: (oid: number, format?: string) => (oid === INT8_OID ? Number : pg.types.getTypeParser(oid as never, format as never)),
} as unknown as pg.CustomTypesConfig;

export function createDatabase(connectionString: string, options: { max?: number; onError?: (error: Error) => void } = {}): Database {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10, types, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  // An idle client can fail (database restart); without a listener that would crash the process.
  let closing: Promise<void> | null = null;
  pool.on("error", (error) => options.onError?.(error));
  return {
    pool,
    query: ((text: string, values?: unknown[]) => pool.query(text, values as never)) as Queryable["query"],
    async tx(fn) {
      const client = (await pool.connect()) as Tx;
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => (closing ??= pool.end()),
  };
}

/** True for failures that mean "the database cannot serve this right now" (503), not a bug. */
export function isUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/.test(error.message);
  return code.startsWith("08") || ["57P01", "57P02", "57P03", "53300", "40001", "40P01", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(code);
}
