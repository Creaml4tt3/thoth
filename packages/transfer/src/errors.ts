/** How a transfer stops: shared by the Private Space engine (`engine.ts`) and transfers between workspaces (`between.ts`). */
import { ProblemError } from "@thoth/workspace-client";
import type { OperationRecord } from "./record.ts";

/** A known refusal: the operation stops and, before its commit, is rolled back. */
export class TransferRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TransferRefused";
    this.code = code;
  }
}

/** The operation could not continue for now (network, server, sign-in); its record keeps the last durable state. */
export class TransferInterrupted extends Error {
  readonly record: OperationRecord;
  constructor(record: OperationRecord, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TransferInterrupted";
    this.record = record;
  }
}

/** A refusal that will not change on retry (a 4xx other than auth, timeout and rate limit). */
export function isRefusal(error: unknown): error is ProblemError | TransferRefused {
  if (error instanceof TransferRefused) return true;
  return error instanceof ProblemError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408 && error.status !== 429;
}

export const codeOf = (error: unknown): string => (error instanceof TransferRefused || error instanceof ProblemError ? error.code : "interrupted");
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
