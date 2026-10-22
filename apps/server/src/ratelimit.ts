import type { RateLimitConfig } from "./config.ts";
import type { Queryable } from "./db.ts";

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the window of the exhausted counter ends. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter in PostgreSQL, so the limit holds across serverless instances. One statement per
 * check (an upsert that returns the new count); the window is derived from the database clock, so instances
 * with skewed clocks agree. Window `n` covers `[n * windowSeconds, (n + 1) * windowSeconds)` of epoch time.
 */
export async function hit(db: Queryable, key: string, limit: number, windowSeconds: number): Promise<RateDecision> {
  const { rows } = await db.query<{ count: number; retry: number }>(
    `WITH w AS (SELECT floor(extract(epoch FROM now()) / $2::int)::bigint AS n)
     INSERT INTO rate_limits (key, window_start, count, expires_at)
     SELECT $1::text, w.n, 1, to_timestamp((w.n + 1) * $2::int) + interval '1 minute' FROM w
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count, ceil((extract(epoch FROM expires_at) - 60) - extract(epoch FROM now()))::int AS retry`,
    [key, windowSeconds],
  );
  const row = rows[0]!;
  return { allowed: row.count <= limit, retryAfterSeconds: Math.max(1, row.retry) };
}

/** Deletes counters of finished windows. */
export async function purgeRateLimits(db: Queryable): Promise<number> {
  return (await db.query("DELETE FROM rate_limits WHERE expires_at <= now()")).rowCount ?? 0;
}

export const rateLimitEnabled = (c: RateLimitConfig): boolean => c.perAccount !== undefined || c.perIp !== undefined;

/**
 * The client address. Behind a proxy the socket address is the proxy's, so `x-real-ip` / `x-forwarded-for`
 * are honoured only when `TRUST_PROXY` is set (the operator vouches that the proxy overwrites them; Vercel
 * does). The LAST `x-forwarded-for` entry is the one our proxy appended; earlier ones are client-supplied.
 */
export function clientIp(headers: Record<string, string | string[] | undefined>, socketAddress: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const real = headers["x-real-ip"];
    if (typeof real === "string" && real.trim() !== "") return real.trim();
    const forwarded = headers["x-forwarded-for"];
    const joined = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const last = joined?.split(",").at(-1)?.trim();
    if (last) return last;
  }
  return socketAddress ?? "unknown";
}
