import { ERROR_CODES, ProblemDetailsSchema, QuotaExceededProblemSchema, RevisionConflictProblemSchema, isErrorCode, problemTypeFor, type ErrorCode, type ProblemDetails, type RevisionSummary } from "@thoth/workspace-protocol";

/**
 * A protocol error (RFC 9457 problem). `code` is the registry code (or an `x-` vendor code), `status` the HTTP status
 * and `problem` the parsed body. `message` is plain words a person can read.
 */
export class ProblemError extends Error {
  readonly code: string;
  readonly status: number;
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails, message?: string) {
    super(message ?? describeProblem(problem));
    this.name = "ProblemError";
    this.code = problem.code;
    this.status = problem.status;
    this.problem = problem;
  }
}

/** HTTP 412 `revision_conflict`: the write was based on a stale revision. Nothing was written. */
export class RevisionConflict extends ProblemError {
  /** The revision that was current on the server when the write was evaluated. */
  readonly currentRevision: RevisionSummary;

  constructor(problem: ProblemDetails & { currentRevision: RevisionSummary }) {
    super(problem, "This page was changed by someone else since you opened it. Nothing was overwritten.");
    this.name = "RevisionConflict";
    this.currentRevision = problem.currentRevision;
  }
}

/** HTTP 409 `quota_exceeded`. `limit` and `current` are absent for server-wide quotas. */
export class QuotaExceeded extends ProblemError {
  readonly quota: string | undefined;
  readonly limit: number | undefined;
  readonly current: number | undefined;

  constructor(problem: ProblemDetails & { quota?: string | undefined; limit?: number | undefined; current?: number | undefined }) {
    super(problem, describeQuota(problem));
    this.name = "QuotaExceeded";
    this.quota = problem.quota;
    this.limit = problem.limit;
    this.current = problem.current;
  }
}

/** The server answered something this client cannot read (not JSON, or not the protocol shape). */
export class ProtocolError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProtocolError";
    this.status = status;
  }
}

const sentence = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed === "") return trimmed;
  const capital = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

const QUOTA_UNITS: Record<string, string> = {
  pagesPerWorkspace: "pages in this workspace",
  membersPerWorkspace: "members in this workspace",
  workspacesPerAccount: "workspaces you can own",
  attachmentBytesPerWorkspace: "bytes of attachments in this workspace",
};

function describeQuota(problem: ProblemDetails & { quota?: string | undefined; limit?: number | undefined }): string {
  if (problem.detail) return sentence(problem.detail);
  const unit = problem.quota ? QUOTA_UNITS[problem.quota] : undefined;
  if (unit && problem.limit !== undefined) return `This server allows at most ${problem.limit} ${unit}.`;
  return "This server has reached one of its limits. Nothing was saved.";
}

const PLAIN: Partial<Record<ErrorCode, string>> = {
  unauthenticated: "You are signed out of this server. Sign in again in Settings.",
  forbidden: "Your role in this workspace does not allow this.",
  not_found: "This page or workspace no longer exists, or you no longer have access to it.",
  rate_limited: "The server is busy. Try again in a moment.",
  payload_too_large: "This page is larger than the server accepts.",
  internal_error: "The server had a problem. Try again later.",
  service_unavailable: "The server is not available right now. Try again later.",
};

/** Plain words for a problem: the registry's own wording for common codes, else the server's detail. */
export function describeProblem(problem: ProblemDetails): string {
  const plain = isErrorCode(problem.code) ? PLAIN[problem.code] : undefined;
  if (plain) return plain;
  if (problem.detail) return sentence(problem.detail);
  return sentence(problem.title || `The server refused the request (HTTP ${problem.status})`);
}

/** Registry code for a bare HTTP status, used when an error response carries no problem body. */
function codeForStatus(status: number): ErrorCode {
  const exact = (Object.keys(ERROR_CODES) as ErrorCode[]).filter((code) => ERROR_CODES[code].status === status);
  // A status shared by several codes (400, 403, 409) is reported as its most generic one.
  const preferred: Partial<Record<number, ErrorCode>> = { 400: "validation_failed", 403: "forbidden", 409: "invalid_transfer_state" };
  return preferred[status] ?? exact[0] ?? (status >= 500 ? "internal_error" : "validation_failed");
}

/** Turns an error response into the most specific error class. */
export function problemFromResponse(status: number, body: string): ProblemError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  if (status === 412) {
    const conflict = RevisionConflictProblemSchema.safeParse(parsed);
    if (conflict.success) return new RevisionConflict(conflict.data);
  }
  if (status === 409) {
    const quota = QuotaExceededProblemSchema.safeParse(parsed);
    if (quota.success) return new QuotaExceeded(quota.data);
  }
  const problem = ProblemDetailsSchema.safeParse(parsed);
  if (problem.success) return new ProblemError(problem.data);
  const code = codeForStatus(status);
  return new ProblemError({ type: problemTypeFor(code), title: ERROR_CODES[code].title, status, code });
}
