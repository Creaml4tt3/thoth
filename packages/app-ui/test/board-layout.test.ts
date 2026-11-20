// The Overview's force layout: deterministic, linked pages close, no overlap, fast for big Spaces.
import { describe, expect, it } from "vitest";
import { layoutOverview, layoutOverviewAsync } from "../src/board/layout.ts";

const pages = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `p${i}.md` }));
const dist = (m: Map<string, { x: number; y: number }>, a: string, b: string) => Math.hypot(m.get(a)!.x - m.get(b)!.x, m.get(a)!.y - m.get(b)!.y);
function minGap(m: Map<string, { x: number; y: number }>): number {
  const p = [...m.values()];
  let min = Infinity;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) min = Math.min(min, Math.hypot(p[i]!.x - p[j]!.x, p[i]!.y - p[j]!.y));
  return min;
}
function random(n: number, links: number) {
  let s = 7;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return { pages: pages(n), links: Array.from({ length: links }, () => ({ from: `p${Math.floor(r() * n)}.md`, to: `p${Math.floor(r() * n)}.md` })) };
}

describe("layoutOverview", () => {
  it("gives every page an integer position, the same for the same seed", () => {
    const { pages: p, links } = random(60, 90);
    const a = layoutOverview(p, links, 3);
    expect(a.size).toBe(60);
    expect([...a.values()].every((v) => Number.isInteger(v.x) && Number.isInteger(v.y))).toBe(true);
    expect([...layoutOverview(p, links, 3)]).toEqual([...a]);
  });

  it("ends linked pages closer than unlinked ones", () => {
    const m = layoutOverview(pages(6), [{ from: "p0.md", to: "p1.md" }]);
    expect(dist(m, "p0.md", "p1.md")).toBeLessThan(dist(m, "p2.md", "p3.md"));
  });

  it("keeps notes apart", () => {
    const { pages: p, links } = random(150, 200);
    expect(minGap(layoutOverview(p, links))).toBeGreaterThanOrEqual(170);
  });

  it("ignores links to pages that are not in the list", () => {
    expect(layoutOverview(pages(2), [{ from: "p0.md", to: "gone.md" }]).size).toBe(2);
  });

  it("lays out 2,000 pages and 3,000 links in under 5 seconds", () => {
    const { pages: p, links } = random(2000, 3000);
    const t = performance.now();
    const m = layoutOverview(p, links);
    expect(performance.now() - t).toBeLessThan(5000); // forceCollide alone took ~2 s; this guards against order-of-magnitude regressions under CI load
    expect(m.size).toBe(2000);
  });
});

describe("layoutOverviewAsync", () => {
  it("matches the sync layout (no Worker in the test runner: runs inline), small and big", async () => {
    for (const n of [20, 350]) {
      const { pages: p, links } = random(n, n);
      expect([...(await layoutOverviewAsync(p, links, 2))]).toEqual([...layoutOverview(p, links, 2)]);
    }
  });
});
