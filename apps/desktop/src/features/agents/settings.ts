/**
 * The Agent Hub's settings: the default time limit and spending limit of a run (each can be changed per run in the
 * task form) and how long local run details are kept (ADR-0007, "Limits" and "History"). Like the language, the
 * theme and the default editor mode they are an app preference kept in the webview's localStorage.
 */
import { BUDGET_CHOICES_USD, DEFAULT_BUDGET_USD, DEFAULT_RETENTION_DAYS, DEFAULT_TIME_LIMIT_MINUTES, RETENTION_CHOICES_DAYS, TIME_LIMIT_MINUTES } from "@thoth/agent-core";

export interface AgentSettings {
  /** Minutes a run may take; one of `TIME_LIMIT_MINUTES`. */
  timeMinutes: number;
  /** US dollars the CLI may spend on a run; null means no limit. */
  budgetUsd: number | null;
  /** Days local run details are kept; 0 keeps them for ever. */
  retentionDays: number;
}

export const AGENT_SETTINGS_KEY = "thoth.desktop.agents";
export const DEFAULT_AGENT_SETTINGS: AgentSettings = { timeMinutes: DEFAULT_TIME_LIMIT_MINUTES, budgetUsd: DEFAULT_BUDGET_USD, retentionDays: DEFAULT_RETENTION_DAYS };

const oneOf = <T extends number>(value: unknown, choices: readonly T[]): value is T => typeof value === "number" && (choices as readonly number[]).includes(value);

/** Settings from stored text; anything missing or not one of the offered choices falls back to the default. */
export function parseAgentSettings(raw: string | null | undefined): AgentSettings {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  const o = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    timeMinutes: oneOf(o["timeMinutes"], TIME_LIMIT_MINUTES) ? o["timeMinutes"] : DEFAULT_AGENT_SETTINGS.timeMinutes,
    budgetUsd: o["budgetUsd"] === null ? null : oneOf(o["budgetUsd"], BUDGET_CHOICES_USD) ? o["budgetUsd"] : DEFAULT_AGENT_SETTINGS.budgetUsd,
    retentionDays: oneOf(o["retentionDays"], RETENTION_CHOICES_DAYS) ? o["retentionDays"] : DEFAULT_AGENT_SETTINGS.retentionDays,
  };
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage can be disabled; the choice then lasts for the session
  }
}

export function loadAgentSettings(): AgentSettings {
  try {
    return parseAgentSettings(storage()?.getItem(AGENT_SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS };
  }
}

export function saveAgentSettings(settings: AgentSettings): void {
  try {
    storage()?.setItem(AGENT_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // quota or privacy mode: the settings last for the session
  }
}
