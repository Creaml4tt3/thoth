/**
 * Usage totals from the local run records (Settings → Thoth assistant → Usage): runs per agent per day, week or month,
 * with Claude Code's estimated cost and Codex's tokens. Nothing is fetched; it is the history the app already keeps.
 * Periods are in local time, weeks start on Monday, and empty periods are kept (as zeros), so the chart's axis is even.
 */
import type { RunRecord } from "@thoth/agent-core";

export type UsagePeriod = "day" | "week" | "month";
/** How many periods are shown, the current one last. */
export const PERIOD_COUNT: Record<UsagePeriod, number> = { day: 14, week: 8, month: 6 };

export interface UsageRow {
  /** The period's first day (local midnight), ms. */
  start: number;
  key: string;
  claude: { runs: number; costUsd: number };
  codex: { runs: number; tokens: number };
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The first day of the period that holds `time`. */
export function periodStart(time: number, period: UsagePeriod): Date {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (period === "month") d.setDate(1);
  return d;
}

function step(d: Date, period: UsagePeriod, by: number): Date {
  const next = new Date(d);
  if (period === "day") next.setDate(next.getDate() + by);
  else if (period === "week") next.setDate(next.getDate() + 7 * by);
  else next.setMonth(next.getMonth() + by, 1);
  return next;
}

export function usageRows(records: readonly RunRecord[], period: UsagePeriod, now: number): UsageRow[] {
  const count = PERIOD_COUNT[period];
  const last = periodStart(now, period);
  const rows: UsageRow[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = step(last, period, -i);
    rows.push({ start: start.getTime(), key: dayKey(start), claude: { runs: 0, costUsd: 0 }, codex: { runs: 0, tokens: 0 } });
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const record of records) {
    const row = byKey.get(dayKey(periodStart(record.createdAt, period)));
    if (!row) continue;
    if (record.provider.id === "codex") {
      row.codex.runs += 1;
      const tokens = record.outcome?.tokens;
      if (tokens) row.codex.tokens += tokens.input + tokens.output;
    } else {
      row.claude.runs += 1;
      row.claude.costUsd += record.outcome?.costUsd ?? 0;
    }
  }
  return rows;
}

export function usageTotals(rows: readonly UsageRow[]): UsageRow["claude"] & { codexRuns: number; tokens: number } {
  return rows.reduce(
    (t, r) => ({ runs: t.runs + r.claude.runs, costUsd: t.costUsd + r.claude.costUsd, codexRuns: t.codexRuns + r.codex.runs, tokens: t.tokens + r.codex.tokens }),
    { runs: 0, costUsd: 0, codexRuns: 0, tokens: 0 },
  );
}
