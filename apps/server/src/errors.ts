import { ERROR_CODES, PROBLEM_CONTENT_TYPE, problem, type ErrorCode } from "@thoth/workspace-protocol";

/** A protocol error: becomes an RFC 9457 problem document with the registry status. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;
  constructor(code: ErrorCode, detail: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(detail);
    this.name = "ApiError";
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

/** A fully formed HTTP reply, independent of the web framework. This is also what idempotency records store. */
export interface Reply {
  status: number;
  headers: Record<string, string>;
  body?: string | Buffer;
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

export function problemReply(error: ApiError, requestId?: string): Reply {
  const headers: Record<string, string> = { "content-type": PROBLEM_CONTENT_TYPE, ...error.headers };
  if (error.code === "unauthenticated") headers["www-authenticate"] = 'Bearer realm="thoth"';
  if (error.code === "rate_limited" && !headers["retry-after"]) headers["retry-after"] = "1";
  const body = { ...problem(error.code, { detail: error.message, ...(requestId === undefined ? {} : { requestId }) }), ...error.extra };
  return { status: ERROR_CODES[error.code].status, headers, body: JSON.stringify(body) };
}

export function fieldError(pointer: string, detail: string): { errors: { pointer: string; detail: string }[] } {
  return { errors: [{ pointer, detail }] };
}

export function zodFailure(error: { issues: { path: PropertyKey[]; message: string }[] }, what = "request body"): ApiError {
  return new ApiError("validation_failed", `${what} is invalid`, {
    errors: error.issues.slice(0, 20).map((i) => ({ pointer: `/${i.path.map(String).join("/")}`, detail: i.message })),
  });
}
