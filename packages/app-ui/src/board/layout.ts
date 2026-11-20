/** The Overview's force layout: one run to rest, deterministic for a seed. Positions are note centres. */
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";

export type Positions = Map<string, { x: number; y: number }>;
type Pages = readonly { path: string }[];
type Links = readonly { from: string; to: string }[];

/** Above this many pages the layout runs in a worker. */
const WORKER_ABOVE = 300;
const MAX_TICKS = 400;
const MIN_GAP = 175; // never closer than this once settled
const GAP = 190; // two notes of ~160 px plus air: collide radius 95 each

/** Push overlapping notes apart on a grid (forceCollide costs seconds at 2,000 notes) until none is closer than GAP. */
function separate(nodes: SimulationNodeDatum[]): void {
  for (let pass = 0; pass < 1000; pass++) {
    // A crowded middle converges slowly; open the whole layout up a little now and then, then keep pushing.
    if (pass && pass % 6 === 0) for (const n of nodes) (n.x! *= 1.05, n.y! *= 1.05);
    const cells = new Map<string, number[]>();
    nodes.forEach((n, i) => {
      const k = `${Math.floor(n.x! / GAP)},${Math.floor(n.y! / GAP)}`;
      (cells.get(k) ?? cells.set(k, []).get(k)!).push(i);
    });
    let moved = false;
    nodes.forEach((a, i) => {
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const j of cells.get(`${Math.floor(a.x! / GAP) + dx},${Math.floor(a.y! / GAP) + dy}`) ?? []) {
            if (j <= i) continue;
            const b = nodes[j]!;
            // Identical positions get a fixed push direction so the result stays deterministic.
            let vx = b.x! - a.x!, vy = b.y! - a.y!;
            let d = Math.hypot(vx, vy);
            if (d >= MIN_GAP) continue;
            if (d < 1e-6) (vx = 1, vy = 0, d = 1);
            const push = ((GAP - d) / 2 / d) * 1.5;
            a.x! -= vx * push; a.y! -= vy * push; b.x! += vx * push; b.y! += vy * push;
            moved = true;
          }
    });
    if (!moved) return;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function layoutOverview(pages: Pages, links: Links, seed = 1): Positions {
  // Start on a phyllotaxis spaced like the notes, so collide does not begin with every note on top of every other.
  const nodes: (SimulationNodeDatum & { path: string })[] = pages.map((p, i) => {
    const r = 200 * Math.sqrt(i + 0.5);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    return { path: p.path, x: r * Math.cos(a), y: r * Math.sin(a) };
  });
  const known = new Set(nodes.map((n) => n.path));
  const edges = links.filter((l) => l.from !== l.to && known.has(l.from) && known.has(l.to)).map((l) => ({ source: l.from, target: l.to }));
  const sim = forceSimulation(nodes)
    .randomSource(mulberry32(seed))
    .force("link", forceLink<(typeof nodes)[number], { source: string; target: string }>(edges).id((n) => n.path).distance(220))
    // shortcut: theta/distanceMax trade exactness for speed on 2,000+ pages; revisit if big Spaces look clumped.
    .force("charge", forceManyBody().strength(-400).theta(1.8).distanceMax(300))
    .force("x", forceX(0).strength(0.03))
    .force("y", forceY(0).strength(0.03))
    .alphaMin(0.01).alphaDecay(0.06)
    .stop();
  for (let i = 0; i < MAX_TICKS && sim.alpha() >= 0.01; i++) sim.tick();
  separate(nodes);
  return new Map(nodes.map((n) => [n.path, { x: Math.round(n.x ?? 0), y: Math.round(n.y ?? 0) }]));
}

/**
 * Same result as layoutOverview; big Spaces run in a worker so the UI never freezes. Falls back to this thread.
 * The main bundle must keep importing this module (the inline fallback): otherwise the licence plugin no longer sees d3-force.
 */
export function layoutOverviewAsync(pages: Pages, links: Links, seed = 1): Promise<Positions> {
  const inline = () => layoutOverview(pages, links, seed);
  if (pages.length <= WORKER_ABOVE || typeof Worker === "undefined") return Promise.resolve(inline());
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    } catch {
      return resolve(inline());
    }
    let settled = false;
    const finish = (positions?: Positions) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(positions ?? inline());
    };
    worker.onmessage = (e: MessageEvent<[string, { x: number; y: number }][]>) => finish(new Map(e.data));
    worker.onerror = () => finish();
    worker.onmessageerror = () => finish();
    try {
      worker.postMessage({ pages: pages.map((p) => ({ path: p.path })), links: links.map((l) => ({ from: l.from, to: l.to })), seed });
    } catch {
      finish();
    }
  });
}
