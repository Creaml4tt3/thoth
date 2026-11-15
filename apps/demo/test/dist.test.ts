import { describe, expect, it } from "vitest";
import { violations } from "../scripts/check-dist.ts";

describe("the dist check", () => {
  it("finds the things that need unsafe-eval or reach the network or storage", () => {
    for (const bad of ["eval(x)", "new Function('a')", "WebAssembly.instantiate", "fetch(u)", "new XMLHttpRequest", "new WebSocket(u)", "localStorage.getItem", "sessionStorage", "indexedDB.open", "document.cookie"]) {
      expect(violations("a.js", bad), bad).not.toEqual([]);
    }
  });
  it("passes plain code", () => expect(violations("a.js", "const a = 1; fetchish(); evaluate()")).toEqual([]));
});
