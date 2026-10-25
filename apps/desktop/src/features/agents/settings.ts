/**
 * The assistant's agent settings (Settings → Thoth assistant): which agent CLI a new task uses (the last one picked), the default time limit and
 * spending limit of a run (each can be changed per run in the task form; Codex has no spending limit, so it only
 * applies to Claude Code) and how long local run details are kept (ADR-0007, "Limits" and "History"). Like the
 * language, the theme and the default editor mode they are an app preference kept in the webview's localStorage.
 */
import { BUDGET_CHOICES_USD, DEFAULT_BUDGET_USD, DEFAULT_RETENTION_DAYS, DEFAULT_TIME_LIMIT_MINUTES, RETENTION_CHOICES_DAYS, TIME_LIMIT_MINUTES } from "@thoth/agent-core";

/** The agent CLIs the Agent Hub offers, in the picker's order. */
export const AGENT_PROVIDERS = ["claude", "codex"] as const;
export type AgentProviderId = (typeof AGENT_PROVIDERS)[number];

export interface AgentSettings {
  /** The agent a new task uses. */
  provider: AgentProviderId;
  /** Minutes a run may take; one of `TIME_LIMIT_MINUTES`. */
  timeMinutes: number;
  /** US dollars the CLI may spend on a run; null means no limit. */
  budgetUsd: number | null;
  /** Days local run details are kept; 0 keeps them for ever. */
  retentionDays: number;
  /** What may be given to an agent at all (Permissions): Private Space pages and folders, the whole Private Space,
   * read-only copies of workspace pages. Each only narrows what the context picker offers; none widens anything. */
  allowPrivate: boolean;
  allowWholeSpace: boolean;
  allowWorkspace: boolean;
}

export const AGENT_SETTINGS_KEY = "thoth.desktop.agents";
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  provider: "claude",
  timeMinutes: DEFAULT_TIME_LIMIT_MINUTES,
  budgetUsd: DEFAULT_BUDGET_USD,
  retentionDays: DEFAULT_RETENTION_DAYS,
  allowPrivate: true,
  allowWholeSpace: true,
  allowWorkspace: true,
};

const oneOf = <T extends number>(value: unknown, choices: readonly T[]): value is T => typeof value === "number" && (choices as readonly number[]).includes(value);
export const isAgentProvider = (value: unknown): value is AgentProviderId => typeof value === "string" && (AGENT_PROVIDERS as readonly string[]).includes(value);

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
    provider: isAgentProvider(o["provider"]) ? o["provider"] : DEFAULT_AGENT_SETTINGS.provider,
    timeMinutes: oneOf(o["timeMinutes"], TIME_LIMIT_MINUTES) ? o["timeMinutes"] : DEFAULT_AGENT_SETTINGS.timeMinutes,
    budgetUsd: o["budgetUsd"] === null ? null : oneOf(o["budgetUsd"], BUDGET_CHOICES_USD) ? o["budgetUsd"] : DEFAULT_AGENT_SETTINGS.budgetUsd,
    retentionDays: oneOf(o["retentionDays"], RETENTION_CHOICES_DAYS) ? o["retentionDays"] : DEFAULT_AGENT_SETTINGS.retentionDays,
    allowPrivate: typeof o["allowPrivate"] === "boolean" ? o["allowPrivate"] : DEFAULT_AGENT_SETTINGS.allowPrivate,
    allowWholeSpace: typeof o["allowWholeSpace"] === "boolean" ? o["allowWholeSpace"] : DEFAULT_AGENT_SETTINGS.allowWholeSpace,
    allowWorkspace: typeof o["allowWorkspace"] === "boolean" ? o["allowWorkspace"] : DEFAULT_AGENT_SETTINGS.allowWorkspace,
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
