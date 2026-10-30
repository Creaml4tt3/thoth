import { createHmac } from "node:crypto";
import { newStableId } from "@thoth/domain";
import type { FeedbackRequest } from "@thoth/workspace-protocol";
import type { Queryable } from "./db.ts";
import { ApiError } from "./errors.ts";
import { hit } from "./ratelimit.ts";

/**
 * Feedback (ADR-0033): storage, the salted client-address hash and the rate limits. The address itself is never
 * stored or logged here; its HMAC with the database's own salt (migration 013) is the rate-limit key and the row's
 * `ip_hash`, so two messages from one address can be told apart from others without knowing the address.
 */

/** Per client address and per account: a short window and a daily one. A refusal is 429 with Retry-After. */
export const FEEDBACK_LIMITS = {
  short: { limit: 5, windowSeconds: 600 },
  day: { limit: 30, windowSeconds: 86_400 },
} as const;

/** Feedback, with any app log sent with it, is deleted by maintenance this many days after it arrived (ADR-0040). */
export const FEEDBACK_RETENTION_DAYS = 90;

/** Deletes feedback older than `FEEDBACK_RETENTION_DAYS`; returns how many rows went. */
export async function purgeFeedback(db: Queryable): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM feedback WHERE created_at < now() - make_interval(days => $1)", [FEEDBACK_RETENTION_DAYS]);
  return rowCount ?? 0;
}

const salts = new WeakMap<object, Promise<string>>();

function saltOf(db: Queryable): Promise<string> {
  let salt = salts.get(db);
  if (!salt) {
    salt = db.query<{ ip_salt: string }>("SELECT ip_salt FROM feedback_settings WHERE singleton").then(({ rows }) => {
      if (!rows[0]) throw new Error("feedback_settings has no salt: apply migration 013");
      return rows[0].ip_salt;
    });
    // A failed read is tried again on the next request, not cached.
    salt.catch(() => salts.delete(db));
    salts.set(db, salt);
  }
  return salt;
}

/** HMAC-SHA-256 of the client address with the database's salt, lower-case hex. */
export async function feedbackIpHash(db: Queryable, ip: string): Promise<string> {
  return createHmac("sha256", await saltOf(db)).update(ip, "utf8").digest("hex");
}

/** Counts one message against every window of the address and the account; the first exhausted one refuses. */
export async function enforceFeedbackLimits(db: Queryable, ipHash: string, accountId: string | null): Promise<void> {
  const keys = [`feedback-ip-10m:${ipHash}`, ...(accountId ? [`feedback-acct-10m:${accountId}`] : [])];
  const dayKeys = [`feedback-ip-day:${ipHash}`, ...(accountId ? [`feedback-acct-day:${accountId}`] : [])];
  let retry = 0;
  for (const key of keys) {
    const d = await hit(db, key, FEEDBACK_LIMITS.short.limit, FEEDBACK_LIMITS.short.windowSeconds);
    if (!d.allowed) retry = Math.max(retry, d.retryAfterSeconds);
  }
  for (const key of dayKeys) {
    const d = await hit(db, key, FEEDBACK_LIMITS.day.limit, FEEDBACK_LIMITS.day.windowSeconds);
    if (!d.allowed) retry = Math.max(retry, d.retryAfterSeconds);
  }
  if (retry > 0) throw new ApiError("rate_limited", "too much feedback from here; retry after the time in the Retry-After header", {}, { "retry-after": String(retry) });
}

export async function storeFeedback(db: Queryable, input: FeedbackRequest, who: { accountId: string | null; ipHash: string }): Promise<string> {
  const id = newStableId();
  await db.query("INSERT INTO feedback (id, kind, message, email, context, diagnostics, account_id, ip_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
    id,
    input.kind,
    input.message,
    input.email ?? null,
    input.context ? JSON.stringify(input.context) : null,
    input.diagnostics ? JSON.stringify(input.diagnostics) : null,
    who.accountId,
    who.ipHash,
  ]);
  return id;
}

export interface FeedbackRow {
  id: string;
  createdAt: string;
  kind: string;
  message: string;
  email: string | null;
  context: Record<string, string> | null;
  diagnostics: { log: string[] } | null;
  accountId: string | null;
}

/** Newest first, optionally only those at or after `since`. The address hash is not part of the listing. */
export async function listFeedback(db: Queryable, options: { since?: Date; limit?: number } = {}): Promise<FeedbackRow[]> {
  const { rows } = await db.query<{ id: string; created_at: Date; kind: string; message: string; email: string | null; context: Record<string, string> | null; diagnostics: { log: string[] } | null; account_id: string | null }>(
    `SELECT id, created_at, kind, message, email, context, diagnostics, account_id FROM feedback
      WHERE ($1::timestamptz IS NULL OR created_at >= $1) ORDER BY created_at DESC, id DESC LIMIT $2`,
    [options.since ?? null, options.limit ?? 1_000_000],
  );
  return rows.map((r) => ({ id: r.id, createdAt: r.created_at.toISOString(), kind: r.kind, message: r.message, email: r.email, context: r.context, diagnostics: r.diagnostics, accountId: r.account_id }));
}
