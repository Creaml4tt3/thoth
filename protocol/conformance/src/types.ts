import type { CapabilityId } from "@thoth/workspace-protocol";

export type CheckStatus = "pass" | "fail" | "skip";

/** `core` checks always apply; the others apply only when the server lists the capability. */
export type CheckGroup = "core" | CapabilityId;

export interface CheckResult {
  /** Stable identifier, `<group>.<area>.<behavior>`. */
  id: string;
  title: string;
  capability: CheckGroup;
  status: CheckStatus;
  /** Human-readable evidence. Never contains the bearer token. */
  detail: string;
}

export interface ConformanceGroup {
  capability: CheckGroup;
  results: CheckResult[];
}

export interface ConformanceSummary {
  pass: number;
  fail: number;
  skip: number;
}

export interface ConformanceReport {
  baseUrl: string;
  protocolVersion: string | null;
  /** Capabilities the server listed, or null when the capabilities check failed. */
  capabilities: string[] | null;
  groups: ConformanceGroup[];
  results: CheckResult[];
  summary: ConformanceSummary;
}

export interface ConformanceOptions {
  /** Server origin (and optional path prefix). `/api/v1` is appended. */
  baseUrl: string;
  /** Bearer credential of a principal that is owner or editor in at least one workspace. Never printed. */
  token: string;
  /** Injectable `fetch`, for tests or custom transports. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Run write checks in this workspace. Default: the first workspace where the principal is owner or editor. */
  workspaceId?: string;
  /** How long to poll for eventually consistent search results. Default 10000. */
  searchTimeoutMs?: number;
  /** How long to wait for an SSE hint. Default 10000. */
  eventTimeoutMs?: number;
}
