import { createHash } from "node:crypto";
import { IDEMPOTENCY_MIN_WINDOW_SECONDS, IdempotencyKeySchema } from "@thoth/workspace-protocol";
import { ApiError, problemReply, type Reply } from "./errors.ts";
import type { Database, Queryable, Tx } from "./db.ts";

export const IDEMPOTENCY_WINDOW_SECONDS = IDEMPOTENCY_MIN_WINDOW_SECONDS;

export interface MutationRequest {
  method: string;
  /** Request target: path and query, exactly as received. */
  target: string;
  idempotencyKey: string | undefined;
  ifMatch: string | undefined;
  ifNoneMatch: string | undefined;
  body: Buffer;
  principalId: string;
  requestId: string;
}

/** What a mutation handler may need to know about the request it runs for. */
export interface MutationInfo {
  /** The request fingerprint of protocol section 8. */
  fingerprint: string;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Protocol section 8: method, target URI, If-Match, If-None-Match and a digest of the body bytes. */
export function fingerprintOf(req: Pick<MutationRequest, "method" | "target" | "ifMatch" | "ifNoneMatch" | "body">): string {
  return sha256([req.method, req.target, req.ifMatch ?? "", req.ifNoneMatch ?? "", sha256(req.body)].join("\n"));
}

/** Replies worth remembering: the outcome of a request-specific decision. 5xx and 429 are retried, 401 never reaches here. */
export const isStorable = (status: number): boolean => status < 500 && status !== 429 && status !== 401;

interface StoredRow {
  fingerprint: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
}

/**
 * Runs a mutating handler in one transaction, with idempotency when the request carries a key.
 *
 * With a key, the transaction first takes an advisory lock on (principal, key), so a duplicate that
 * arrives while the first is executing waits and then replays the stored answer rather than running
 * twice. The stored reply is committed in the same transaction as the write: a crash can never leave
 * a write without its record or the reverse.
 *
 * A handler that throws `ApiError` is a normal outcome: its partial writes are rolled back to a
 * savepoint and the problem reply is stored like any other 4xx.
 */
export async function runMutation(db: Database, req: MutationRequest, run: (tx: Tx, info: MutationInfo) => Promise<Reply>): Promise<Reply> {
  const key = req.idempotencyKey;
  const fingerprint = fingerprintOf(req);
  const info: MutationInfo = { fingerprint };
  if (key === undefined) return db.tx((tx) => run(tx, info));
  if (!IdempotencyKeySchema.safeParse(key).success) throw new ApiError("validation_failed", "Idempotency-Key must be 1 to 255 visible ASCII characters", { errors: [{ pointer: "header:Idempotency-Key", detail: "invalid" }] });
  return db.tx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${req.principalId.length}:${req.principalId}${key}`]);
    await tx.query("DELETE FROM idempotency_records WHERE principal_id = $1 AND key = $2 AND created_at <= now() - make_interval(secs => $3)", [req.principalId, key, IDEMPOTENCY_WINDOW_SECONDS]);
    const found = await tx.query<StoredRow>("SELECT fingerprint, status, headers, body FROM idempotency_records WHERE principal_id = $1 AND key = $2", [req.principalId, key]);
    const stored = found.rows[0];
    if (stored) {
      if (stored.fingerprint !== fingerprint) throw new ApiError("idempotency_key_reused", "Idempotency-Key was used with a different request");
      return { status: stored.status, headers: { ...stored.headers, "idempotent-replayed": "true" }, ...(stored.body ? { body: stored.body } : {}) };
    }
    await tx.query("SAVEPOINT idempotent_run");
    let reply: Reply;
    try {
      reply = await run(tx, info);
      await tx.query("RELEASE SAVEPOINT idempotent_run");
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await tx.query("ROLLBACK TO SAVEPOINT idempotent_run");
      reply = problemReply(error, req.requestId);
    }
    if (isStorable(reply.status)) {
      const body = reply.body === undefined ? null : Buffer.from(reply.body);
      await tx.query("INSERT INTO idempotency_records (principal_id, key, fingerprint, status, headers, body) VALUES ($1, $2, $3, $4, $5, $6)", [req.principalId, key, fingerprint, reply.status, JSON.stringify(reply.headers), body]);
    }
    return reply;
  });
}

/** Deletes records older than the replay window. Safe to run at any time, on any instance. */
export async function purgeIdempotencyRecords(db: Queryable): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM idempotency_records WHERE created_at <= now() - make_interval(secs => $1)", [IDEMPOTENCY_WINDOW_SECONDS]);
  return rowCount ?? 0;
}
