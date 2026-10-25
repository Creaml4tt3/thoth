/**
 * Limits on one run (ADR-0007, "Limits"): how long it may take and how much the CLI may spend. The Agent Hub offers
 * a few choices and remembers a default; each run can override it. The Rust host checks the same bounds itself
 * (`crates/thoth-host/src/agent/limits.rs`, `claude.rs`) and refuses values outside them; this module is the
 * webview's copy, so a bad value fails before anything is staged.
 */

/** The time limit choices, in minutes. */
export const TIME_LIMIT_MINUTES = [5, 15, 30, 60] as const;
export const DEFAULT_TIME_LIMIT_MINUTES = 30;
export const MIN_TIME_LIMIT_MS = 1000;
/** The longest time limit the host accepts: 24 hours. */
export const MAX_TIME_LIMIT_MS = 24 * 60 * 60 * 1000;

/** The spending limit choices, in US dollars. "No limit" is the absence of a number. */
export const BUDGET_CHOICES_USD = [0.25, 0.5, 1, 2, 5] as const;
export const DEFAULT_BUDGET_USD = 1;
/**
 * The largest spending limit the host accepts (`MAX_BUDGET_USD` in `claude.rs`): 20 times the largest choice, so a
 * person who set a bigger one on purpose is not blocked, while a forged value cannot lift the safety net.
 */
export const MAX_BUDGET_USD = 100;

/** How long local run details are kept, in days; 0 keeps them for ever. */
export const RETENTION_CHOICES_DAYS = [7, 30, 90, 0] as const;
export const DEFAULT_RETENTION_DAYS = 30;

export class LimitError extends Error {
  readonly limit: "time" | "budget";

  constructor(limit: "time" | "budget", message: string) {
    super(message);
    this.name = "LimitError";
    this.limit = limit;
  }
}

/** Throws a `LimitError` unless the time limit is a whole number of milliseconds from 1 second to 24 hours. */
export function checkTimeLimitMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIME_LIMIT_MS || timeoutMs > MAX_TIME_LIMIT_MS) {
    throw new LimitError("time", "The time limit must be between 1 second and 24 hours");
  }
}

/** Throws a `LimitError` unless the spending limit is more than 0 and at most US$100. */
export function checkBudgetUsd(usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0 || usd > MAX_BUDGET_USD) {
    throw new LimitError("budget", `The spending limit must be more than US$0 and at most US$${MAX_BUDGET_USD}`);
  }
}

export const minutesToMs = (minutes: number): number => Math.round(minutes * 60_000);
