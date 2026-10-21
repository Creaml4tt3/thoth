import { ProblemDetailsSchema, PROBLEM_CONTENT_TYPE, checkProblemConsistency, isErrorCode } from "./errors.ts";
import { allowedStatuses, responseSchemaFor, type RouteDefinition } from "./routes.ts";

function summarize(prefix: string, issues: { path: PropertyKey[]; message: string }[]): string[] {
  const render = (i: { path: PropertyKey[]; message: string }) => `${prefix}${i.path.length ? "." + i.path.map(String).join(".") : ""}: ${i.message}`;
  const shown = issues.slice(0, 3).map(render);
  return issues.length > 3 ? [...shown, `${prefix}: ... and ${issues.length - 3} more issue(s)`] : shown;
}

export interface ObservedResponse {
  status: number;
  /** Raw `Content-Type` header value, or null. */
  contentType: string | null;
  /** Parsed JSON body, or `undefined` when the body is empty or not JSON. */
  body: unknown;
  /** True when a body was present but did not parse as JSON. */
  bodyUnparseable?: boolean;
}

/** Lower-cased media type without parameters. */
export function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Validates an observed response against the route registry. Returns human-readable
 * issues; an empty list means the response conforms. Never includes request headers.
 */
export function validateResponse(route: RouteDefinition, res: ObservedResponse): string[] {
  const issues: string[] = [];
  if (!allowedStatuses(route).includes(res.status)) {
    issues.push(`status ${res.status} is not declared for ${route.operationId} (declared: ${allowedStatuses(route).join(", ")})`);
    return issues;
  }
  const success = route.responses.find((r) => r.status === res.status);
  if (success) {
    if (success.contentType !== undefined) {
      if (mediaType(res.contentType) !== success.contentType) issues.push(`content-type is "${mediaType(res.contentType)}", expected "${success.contentType}"`);
    }
    if (success.schema) {
      if (res.bodyUnparseable) issues.push("body is not valid JSON");
      else {
        const parsed = success.schema.safeParse(res.body);
        if (!parsed.success) issues.push(...summarize("body", parsed.error.issues));
      }
    }
    return issues;
  }
  // Error response.
  if (mediaType(res.contentType) !== PROBLEM_CONTENT_TYPE) issues.push(`error content-type is "${mediaType(res.contentType)}", expected "${PROBLEM_CONTENT_TYPE}"`);
  if (res.bodyUnparseable) {
    issues.push("error body is not valid JSON");
    return issues;
  }
  const schema = responseSchemaFor(route, res.status) ?? ProblemDetailsSchema;
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) {
    issues.push(...summarize("problem", parsed.error.issues));
    return issues;
  }
  const generic = ProblemDetailsSchema.parse(res.body);
  issues.push(...checkProblemConsistency(generic, res.status));
  if (isErrorCode(generic.code) && !route.errors.includes(generic.code)) issues.push(`code ${generic.code} is not declared for ${route.operationId}`);
  return issues;
}

/** Validates a problem response for a request that matched no route (unknown path, bad method). */
export function validateUnroutedProblem(res: ObservedResponse): string[] {
  const issues: string[] = [];
  if (mediaType(res.contentType) !== PROBLEM_CONTENT_TYPE) issues.push(`error content-type is "${mediaType(res.contentType)}", expected "${PROBLEM_CONTENT_TYPE}"`);
  const parsed = ProblemDetailsSchema.safeParse(res.body);
  if (!parsed.success) {
    issues.push(...summarize("problem", parsed.error.issues));
    return issues;
  }
  issues.push(...checkProblemConsistency(parsed.data, res.status));
  return issues;
}
