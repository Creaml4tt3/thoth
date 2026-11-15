import { describe, expect, it } from "vitest";
import { scopeSelector } from "../postcss-scope.ts";

describe("scopeSelector", () => {
  it.each([
    [":root", ".thoth-demo"],
    ["body", ".thoth-demo"],
    ["#root", ".thoth-demo"],
    ['[data-theme="night"][data-theme]', '.thoth-demo[data-theme="night"][data-theme]'],
    [".tree-item:hover", ".thoth-demo .tree-item:hover"],
    ["*", ".thoth-demo *"],
  ])("%s", (input, expected) => {
    // PostCSS hands each selector of a list (`html, body`) to scopeSelector on its own, so lists are not cases here.
    expect(scopeSelector(input)).toBe(expected);
  });

  it("never leaves a rule that reaches the host page", () => {
    for (const s of ["button", ".sr-only", ":focus-visible", "h1", ".page-view"]) expect(scopeSelector(s).startsWith(".thoth-demo")).toBe(true);
  });
});
