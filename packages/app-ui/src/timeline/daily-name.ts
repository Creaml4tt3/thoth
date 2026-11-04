/**
 * The date in a daily note's file name (ADR-0051 rule 15): a page in the daily folder whose name matches the file name
 * pattern. Patterns use the Moment-style tokens of rule 8 (`YYYY`, `YY`, `MM`, `M`, `DD`, `D`, `MMM`, `MMMM`, `ddd`,
 * `dddd`, `[text]`, `/` for subfolders); month and day names are English. Dates in file names are Gregorian.
 */
import { isCalendarDay } from "@thoth/content";

/** 0.6.0's defaults (ADR-0050), and the daily setting's when `.thoth/daily.json` is missing (ADR-0051 rule 7). */
export const DEFAULT_DAILY = { folder: "Daily", pattern: "YYYY-MM-DD" } as const;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = "Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday";

type Part = "year" | "year2" | "month" | "monthShort" | "monthLong" | "day" | null;
const TOKENS: [string, string, Part][] = [
  ["YYYY", "(\\d{4})", "year"],
  ["YY", "(\\d{2})", "year2"],
  ["MMMM", `(${MONTHS.join("|")})`, "monthLong"],
  ["MMM", `(${MONTHS.map((m) => m.slice(0, 3)).join("|")})`, "monthShort"],
  ["MM", "(\\d{2})", "month"],
  ["M", "(\\d{1,2})", "month"],
  ["DD", "(\\d{2})", "day"],
  ["D", "(\\d{1,2})", "day"],
  ["dddd", `(?:${DAYS})`, null],
  ["ddd", `(?:${DAYS.replace(/(\w{3})\w*/g, "$1")})`, null],
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The pattern as a regular expression and the date part each group holds; null for a pattern with another token. */
function compile(pattern: string): { re: RegExp; parts: Part[] } | null {
  let source = "";
  const parts: Part[] = [];
  for (let i = 0; i < pattern.length; ) {
    if (pattern[i] === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) return null;
      source += escape(pattern.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    const token = TOKENS.find(([t]) => pattern.startsWith(t, i));
    if (token) {
      source += token[1];
      if (token[2]) parts.push(token[2]);
      i += token[0].length;
    } else if (/[A-Za-z]/.test(pattern[i]!)) return null; // a token rule 8 does not allow
    else source += escape(pattern[i++]!);
  }
  return { re: new RegExp(`^${source}$`, "i"), parts };
}

/**
 * The `YYYY-MM-DD` date a daily note's path names, or undefined: `path` must be `<folder>/<pattern>.md` (`folder` may
 * be "" for the top level) and the date must exist. A pattern without year, month and day names no date.
 */
export function dateFromDailyName(path: string, folder: string, pattern: string): string | undefined {
  const prefix = folder.replace(/^\/+|\/+$/g, "");
  const rest = prefix === "" ? path : path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`) ? path.slice(prefix.length + 1) : null;
  if (rest === null || !/\.md$/i.test(rest)) return undefined;
  const compiled = compile(pattern);
  const m = compiled?.re.exec(rest.slice(0, -3));
  if (!compiled || !m) return undefined;
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  compiled.parts.forEach((part, i) => {
    const v = m[i + 1]!;
    if (part === "year") year = Number(v);
    else if (part === "year2") year = 2000 + Number(v);
    else if (part === "month") month = Number(v);
    else if (part === "monthLong" || part === "monthShort") month = MONTHS.findIndex((name) => name.toLowerCase().startsWith(v.toLowerCase())) + 1;
    else if (part === "day") day = Number(v);
  });
  if (year === undefined || month === undefined || day === undefined || !isCalendarDay(year, month, day)) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
