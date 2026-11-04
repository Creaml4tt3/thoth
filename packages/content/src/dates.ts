/**
 * Date patterns for daily notes and template placeholders (ADR-0051 rules 8 and 10): a small, exact subset of
 * Moment.js format strings, so a pattern written for Obsidian means the same here or is refused, never guessed.
 *
 * A run of the same ASCII letter is one token (`DDD` is one token, Moment's day of the year, not `DD` then `D`), and it
 * must be one of the tokens below. Text in `[brackets]` is kept as written; any other character (digits, `-`, `/`,
 * spaces, Thai) is kept as it is. Month and day names are English, as Obsidian's are by default; years are Gregorian.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const hour12 = (d: Date) => d.getHours() % 12 || 12;

const DATE_TOKENS: Record<string, (d: Date) => string> = {
  YYYY: (d) => pad(d.getFullYear(), 4),
  YY: (d) => pad(d.getFullYear() % 100),
  MMMM: (d) => MONTHS[d.getMonth()]!,
  MMM: (d) => MONTHS[d.getMonth()]!.slice(0, 3),
  MM: (d) => pad(d.getMonth() + 1),
  M: (d) => String(d.getMonth() + 1),
  DD: (d) => pad(d.getDate()),
  D: (d) => String(d.getDate()),
  dddd: (d) => DAYS[d.getDay()]!,
  ddd: (d) => DAYS[d.getDay()]!.slice(0, 3),
};
const TIME_TOKENS: Record<string, (d: Date) => string> = {
  HH: (d) => pad(d.getHours()),
  H: (d) => String(d.getHours()),
  hh: (d) => pad(hour12(d)),
  h: (d) => String(hour12(d)),
  mm: (d) => pad(d.getMinutes()),
  A: (d) => (d.getHours() < 12 ? "AM" : "PM"),
  a: (d) => (d.getHours() < 12 ? "am" : "pm"),
};

/** Why a pattern is refused: empty, a token Thoth does not make, or a `[` that is never closed. */
export type DatePatternProblem = { kind: "empty" } | { kind: "token"; token: string } | { kind: "bracket" };

type Part = { text: string } | { token: (d: Date) => string };

function parse(pattern: string, time: boolean): Part[] | DatePatternProblem {
  if (pattern.trim() === "") return { kind: "empty" };
  const parts: Part[] = [];
  for (let i = 0; i < pattern.length; ) {
    const c = pattern[i]!;
    if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) return { kind: "bracket" };
      parts.push({ text: pattern.slice(i + 1, close) });
      i = close + 1;
    } else if (/[A-Za-z]/.test(c)) {
      let end = i + 1;
      while (pattern[end] === c) end++;
      const token = pattern.slice(i, end);
      const format = DATE_TOKENS[token] ?? (time ? TIME_TOKENS[token] : undefined);
      if (!format) return { kind: "token", token };
      parts.push({ token: format });
      i = end;
    } else {
      parts.push({ text: c });
      i++;
    }
  }
  return parts;
}

/** The problem with `pattern`, or null. `time` also allows the hour, minute and AM/PM tokens (placeholders only). */
export function datePatternProblem(pattern: string, options: { time?: boolean } = {}): DatePatternProblem | null {
  const parts = parse(pattern, options.time === true);
  return Array.isArray(parts) ? null : parts;
}

/** `date` written with `pattern` (local time). Throws on a pattern `datePatternProblem` refuses. */
export function formatDate(pattern: string, date: Date, options: { time?: boolean } = {}): string {
  const parts = parse(pattern, options.time === true);
  if (!Array.isArray(parts)) throw new Error(`Unsupported date pattern: ${pattern}`);
  return parts.map((p) => ("text" in p ? p.text : p.token(date))).join("");
}
