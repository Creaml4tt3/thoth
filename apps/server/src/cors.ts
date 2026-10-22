/** Methods and headers a browser client may use; fixed by the protocol, not configurable. */
export const CORS_ALLOW_METHODS = "GET, POST, PUT, DELETE";
export const CORS_ALLOW_HEADERS = "Authorization, Content-Type, If-Match, If-None-Match, Idempotency-Key";
export const CORS_EXPOSE_HEADERS = "ETag, Location, Retry-After, WWW-Authenticate";
const PREFLIGHT_MAX_AGE_SECONDS = "600";

/**
 * Response headers for a request carrying `Origin`. Only an origin that is in the allow-list (exact string
 * match) is echoed; any other gets no CORS header at all, so the browser blocks the response. `Vary: Origin`
 * is always sent when an allow-list exists, so caches never serve one origin's answer to another.
 */
export function corsHeaders(allowed: readonly string[], origin: string | undefined, preflight: boolean): Record<string, string> {
  if (allowed.length === 0) return {};
  const headers: Record<string, string> = { vary: "Origin" };
  if (origin === undefined || !allowed.includes(origin)) return headers;
  headers["access-control-allow-origin"] = origin;
  headers["access-control-allow-credentials"] = "true";
  if (preflight) {
    headers["access-control-allow-methods"] = CORS_ALLOW_METHODS;
    headers["access-control-allow-headers"] = CORS_ALLOW_HEADERS;
    headers["access-control-max-age"] = PREFLIGHT_MAX_AGE_SECONDS;
  } else {
    headers["access-control-expose-headers"] = CORS_EXPOSE_HEADERS;
  }
  return headers;
}

/** A CORS preflight: `OPTIONS` with `Origin` and `Access-Control-Request-Method`. */
export const isPreflight = (method: string, headers: Record<string, string | string[] | undefined>): boolean => method === "OPTIONS" && typeof headers.origin === "string" && typeof headers["access-control-request-method"] === "string";
