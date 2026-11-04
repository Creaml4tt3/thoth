// Date patterns (ADR-0051 rule 8): the exact Moment.js subset, and refusals with the token named.
import { describe, expect, it } from "vitest";
import { datePatternProblem, formatDate } from "../src/index.ts";

const NOV_4 = new Date(2026, 10, 4, 9, 5); // a Wednesday
const MAR_9 = new Date(2026, 2, 9, 21, 0); // a Monday

describe("formatDate", () => {
  it("makes every token of rule 8", () => {
    expect(formatDate("YYYY-MM-DD", NOV_4)).toBe("2026-11-04");
    expect(formatDate("YY M D", MAR_9)).toBe("26 3 9");
    expect(formatDate("MMM MMMM ddd dddd", NOV_4)).toBe("Nov November Wed Wednesday");
    expect(formatDate("YYYY/MM/YYYY-MM-DD", MAR_9)).toBe("2026/03/2026-03-09");
    expect(formatDate("YYYY", new Date(987, 0, 1))).toBe("0987");
  });

  it("keeps [text] and other characters as written", () => {
    expect(formatDate("[Week of] YYYY-MM-DD", NOV_4)).toBe("Week of 2026-11-04");
    expect(formatDate("[YYYY] DD", NOV_4)).toBe("YYYY 04");
    expect(formatDate("บันทึก DD.MM", NOV_4)).toBe("บันทึก 04.11");
  });

  it("makes the time tokens only when asked", () => {
    expect(formatDate("HH:mm H h hh A a", MAR_9, { time: true })).toBe("21:00 21 9 09 PM pm");
    expect(formatDate("h A", new Date(2026, 0, 1, 0, 30), { time: true })).toBe("12 AM");
    expect(datePatternProblem("HH:mm")).toEqual({ kind: "token", token: "HH" });
    expect(() => formatDate("HH", NOV_4)).toThrow();
  });
});

describe("datePatternProblem", () => {
  it("refuses any other token, naming it, and an unclosed bracket", () => {
    expect(datePatternProblem("YYYY-MM-DD")).toBeNull();
    expect(datePatternProblem("gggg-[W]ww")).toEqual({ kind: "token", token: "gggg" });
    expect(datePatternProblem("YYYY-DDD")).toEqual({ kind: "token", token: "DDD" });
    expect(datePatternProblem("Do MMMM")).toEqual({ kind: "token", token: "o" });
    expect(datePatternProblem("YYYY-MM-DD dd")).toEqual({ kind: "token", token: "dd" });
    expect(datePatternProblem("[Week YYYY")).toEqual({ kind: "bracket" });
    expect(datePatternProblem("  ")).toEqual({ kind: "empty" });
  });
});
