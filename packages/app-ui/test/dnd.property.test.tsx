// @vitest-environment jsdom
/**
 * Preservation properties of `useTreeDnd`. They pin what the hook does today for drags
 * that are not in the bug condition (a first drag, a drag that starts after the previous one has fully ended, refused
 * drops, cancelled drags, hover-to-open). They are run on generated trees and generated event sequences; the generator
 * is a small seeded PRNG (no property-testing library is installed), so a failure names its seed and can be replayed.
 *
 * The "oracle" below is the documented rule written out again from the doc comments in `dnd.ts`, not a call into the hook.
 */
import { act, cleanup, createEvent, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeDnd, type DropState, type DropZone, type TreeDnd } from "../src/order/dnd.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Seeded generator

type Random = () => number;
/** mulberry32: 32 bits of state, good enough for shaping test inputs. */
function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: Random, n: number) => Math.floor(r() * n);
const pick = <T,>(r: Random, list: readonly T[]): T => list[int(r, list.length)]!;
const chance = (r: Random, p: number) => r() < p;

/** Runs `check` for seeds 1..count; a failure is rethrown with its seed so it can be replayed. */
function forSeeds(count: number, check: (seed: number, r: Random) => void): void {
  for (let seed = 1; seed <= count; seed++) {
    try {
      check(seed, seeded(seed));
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      throw new Error(`seed ${seed}: ${reason}`, { cause: failure });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// A generated tree, and the rules that go with it

const TOP = "top";
const HOVER_OPEN_MS = 700;

interface TreeNode {
  id: string;
  parent: string | null;
  /** Can others be dropped inside (a folder, or a page that holds pages)? */
  container: boolean;
  /** Open when the drag starts. */
  open: boolean;
}
interface Model {
  nodes: TreeNode[];
  /** Does the tree keep an order, so that before and after mean something? */
  ordered: boolean;
  /** Is there a "Top level" strip, a row that only takes drops inside? */
  strip: boolean;
  /** `over:zone` pairs a drop is refused on, besides onto itself and into a descendant. */
  refused: Set<string>;
}

function generate(r: Random): Model {
  const nodes: TreeNode[] = [];
  const count = 3 + int(r, 7);
  for (let i = 0; i < count; i++) {
    const holders = nodes.filter((n) => n.container);
    const parent = holders.length > 0 && chance(r, 0.6) ? pick(r, holders).id : null;
    const container = chance(r, 0.5);
    nodes.push({ id: `n${i}`, parent, container, open: container && chance(r, 0.6) });
  }
  const refused = new Set<string>();
  for (const n of nodes) for (const zone of ["before", "inside", "after"] as const) if (chance(r, 0.1)) refused.add(`${n.id}:${zone}`);
  return { nodes, ordered: chance(r, 0.75), strip: chance(r, 0.6), refused };
}

const find = (model: Model, id: string) => model.nodes.find((n) => n.id === id);
const childrenOf = (model: Model, id: string | null) => model.nodes.filter((n) => n.parent === id);
const isOpen = (model: Model, opened: ReadonlySet<string>, id: string) => {
  const n = find(model, id);
  return n !== undefined && n.container && (n.open || opened.has(id));
};
/** Rows on screen, top to bottom: depth first, a child only under an open parent. */
function visibleIds(model: Model, opened: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (parent: string | null) => {
    for (const n of childrenOf(model, parent)) {
      out.push(n.id);
      if (isOpen(model, opened, n.id)) walk(n.id);
    }
  };
  walk(null);
  return out;
}
const firstChildOf = (model: Model, opened: ReadonlySet<string>, id: string): string | null => (isOpen(model, opened, id) ? (childrenOf(model, id)[0]?.id ?? null) : null);
/** Is `id` the page `ancestor` or below it? */
function isWithin(model: Model, id: string, ancestor: string): boolean {
  for (let at: string | null = id; at !== null; at = find(model, at)?.parent ?? null) if (at === ancestor) return true;
  return false;
}
/** The drop rule of a tree: not onto itself, not into a descendant, nothing back to the top level for a page already there, and the refused places. */
function allowed(model: Model, drag: string, over: string, zone: DropZone): boolean {
  if (model.refused.has(`${over}:${zone}`)) return false;
  if (over === TOP) return find(model, drag)?.parent !== null;
  return drag !== over && !isWithin(model, over, drag);
}

// ---------------------------------------------------------------------------------------------------------------------
// The oracle: where a pointer at `k` (a 40th of the row height) over row `id` would drop

const rowHeight = 100;
const pointerY = (k: number) => k * 2.5; // k/40 of the row height; 10, 20 and 30 sit exactly on the band edges
const KS = Array.from({ length: 49 }, (_, i) => i - 4); // from above the row (-0.1) to below it (1.1)

function band(offsetY: number, container: boolean, ordered: boolean): DropZone | null {
  const f = Math.min(1, Math.max(0, offsetY / rowHeight));
  if (!ordered) return container && f >= 0.25 && f <= 0.75 ? "inside" : null;
  if (container) return f < 0.25 ? "before" : f > 0.75 ? "after" : "inside";
  return f < 0.5 ? "before" : "after";
}

function expected(model: Model, opened: ReadonlySet<string>, from: string, id: string, k: number): DropState | null {
  const zone = id === TOP ? "inside" : band(pointerY(k), find(model, id)?.container ?? false, model.ordered);
  if (zone === null) return null;
  if (zone === "after") {
    const first = id === TOP ? null : firstChildOf(model, opened, id);
    if (first !== null) return allowed(model, from, first, "before") ? { id: first, zone: "before" } : null;
  }
  return allowed(model, from, id, zone) ? { id, zone } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The rig: the hook on a generated tree, like a tree view uses it

interface Rig {
  dnd: TreeDnd;
  opened: ReadonlySet<string>;
  drops: [string, string, DropZone][];
  hovers: string[];
}

function Harness({ model, rig }: { model: Model; rig: Rig }) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const dnd = useTreeDnd({
    enabled: true,
    canContain: (id) => id !== TOP && (find(model, id)?.container ?? false),
    canOrder: model.ordered,
    onlyInside: (id) => id === TOP,
    firstChild: (id) => (id === TOP ? null : firstChildOf(model, opened, id)),
    canDrop: (drag, over, zone) => allowed(model, drag, over, zone),
    onDrop: (drag, over, zone) => void rig.drops.push([drag, over, zone]),
    // What a tree view does: open the row.
    onHoverOpen: (id) => {
      rig.hovers.push(id);
      if (id !== TOP) setOpened((s) => new Set(s).add(id));
    },
  });
  rig.dnd = dnd;
  rig.opened = opened;
  const ids = [...visibleIds(model, opened), ...(model.strip ? [TOP] : [])];
  return (
    <div>
      {ids.map((id) => (
        <button key={id} data-testid={id} data-dragging={dnd.dragging === id || undefined} {...(id === TOP ? { ...dnd.rowProps(id), draggable: undefined } : dnd.rowProps(id))}>
          <span className="tree-label">{id}</span>
        </button>
      ))}
    </div>
  );
}

const data = { setData: () => undefined, getData: () => "", effectAllowed: "", dropEffect: "", setDragImage: vi.fn() };
const el = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
type Kind = "dragOver" | "dragEnter" | "dragLeave" | "drop";
/** A drag event on row `id` with the pointer at `k` of its height (and in the middle of its width). The row is 200 by 100. */
function fire(id: string, type: Kind, k: number, extra: object = {}): { defaultPrevented: boolean } {
  const target = el(id);
  target.getBoundingClientRect = () => ({ top: 0, height: rowHeight, left: 0, width: 200, bottom: rowHeight, right: 200, x: 0, y: 0, toJSON: () => ({}) });
  const event = createEvent[type](target, { dataTransfer: data, ...extra });
  Object.defineProperty(event, "clientY", { value: pointerY(k) });
  Object.defineProperty(event, "clientX", { value: 100 });
  fireEvent(target, event);
  return event;
}
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

/** Mounts a generated tree. */
function mount(model: Model): Rig {
  const rig: Rig = { dnd: undefined as unknown as TreeDnd, opened: new Set<string>(), drops: [], hovers: [] };
  render(<Harness model={model} rig={rig} />);
  return rig;
}

/** Which rows show an indicator on screen, as `id:zone`. */
const shown = () => [...document.querySelectorAll("[data-drop]")].map((n) => `${(n as HTMLElement).dataset.testid}:${n.getAttribute("data-drop")}`);
const shownFor = (d: DropState | null) => (d === null ? [] : [`${d.id}:${d.zone}`]);
const attribute = () => document.documentElement.hasAttribute("data-tree-dragging");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.querySelectorAll(".tree-drag-image").forEach((n) => n.remove());
  document.documentElement.removeAttribute("data-tree-dragging");
});

/** Starts a drag of `id` and lets the tick pass that sets `data-tree-dragging`. */
function start(id: string) {
  fireEvent.dragStart(el(id), { dataTransfer: data });
  advance(1);
}

/** After a drag has ended (a drop, or a drag that ended without one) nothing of it may be left. */
function expectNothingLeft(rig: Rig) {
  advance(1); // the picture's own timer
  expect(rig.dnd.dragging).toBeNull();
  expect(rig.dnd.drop).toBeNull();
  expect(attribute()).toBe(false);
  expect(shown()).toEqual([]);
  expect(document.querySelectorAll("[data-dragging]")).toHaveLength(0);
  expect(document.querySelector(".tree-drag-image")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
}

// ---------------------------------------------------------------------------------------------------------------------

describe("useTreeDnd preservation properties", () => {
  /**
   * (b) For generated trees and pointer positions, the indicator is the one the rule gives for the row and the band under
   * the pointer, and there is none exactly where the rule refuses the drop (onto itself, into a descendant, a refused
   * place, a band that is not a drop place). The drop is cancelled (accepted) exactly where an indicator shows.
   *
   * **Validates: Requirements 3.1, 3.2**
   */
  it("shows the indicator the rule gives for the row and zone under the pointer, and none where the drop is refused", () => {
    let seen = 0;
    let refusedSeen = 0;
    forSeeds(40, (seed, r) => {
      const model = generate(r);
      const rig = mount(model);
      const rows = [...visibleIds(model, rig.opened), ...(model.strip ? [TOP] : [])];
      for (let i = 0; i < 12; i++) {
        const source = pick(r, visibleIds(model, rig.opened));
        const over = pick(r, rows);
        const k = pick(r, KS);
        const type = pick(r, ["dragOver", "dragEnter"] as const);
        start(source);
        const want = expected(model, rig.opened, source, over, k);
        const event = fire(over, type, k);
        expect(shown(), `seed ${seed}: ${source} over ${over} at ${k}/40 (${type})`).toEqual(shownFor(want));
        expect(rig.dnd.drop).toEqual(want);
        expect(event.defaultPrevented, "a drop is accepted exactly where an indicator shows").toBe(want !== null);
        // A pending hover timer exactly when the indicator is "inside" (the one timer; the picture's and the tick's have run).
        expect(vi.getTimerCount()).toBe(want?.zone === "inside" ? 1 : 0);
        if (want) seen++;
        else refusedSeen++;
        fireEvent.dragEnd(el(source), { dataTransfer: data });
        expectNothingLeft(rig);
      }
      cleanup();
    });
    // The generator reaches both outcomes.
    expect(seen).toBeGreaterThan(100);
    expect(refusedSeen).toBeGreaterThan(50);
  });

  it("never marks a page onto itself or into its own descendant, at any height of the pointer", () => {
    forSeeds(40, (seed, r) => {
      const model = generate(r);
      const rig = mount(model);
      const ids = visibleIds(model, rig.opened);
      for (const source of ids) {
        start(source);
        for (const over of ids.filter((id) => isWithin(model, id, source))) {
          for (const k of KS) {
            const event = fire(over, "dragOver", k);
            expect(shown(), `seed ${seed}: ${source} over ${over} at ${k}/40`).toEqual([]);
            expect(event.defaultPrevented).toBe(false);
          }
        }
        fireEvent.dragEnd(el(source), { dataTransfer: data });
      }
      expectNothingLeft(rig);
      cleanup();
    });
  });

  /**
   * (a) A single drag that completes leaves nothing behind: `dragging` and `drop` are null, `data-tree-dragging` is gone, no
   * row is marked or has `data-dragging`, and no timer is pending (a hover timer never fires later). The sequences are
   * generated: dragenter, dragover and dragleave over random rows and heights with random pauses (long enough for a hover
   * to open a folder), then a drop, or a drag that ends without one. While it runs, the indicator follows a small reference
   * model of the events, and a drop calls `onDrop` exactly where the rule allows it. The drag that follows on the settled tree
   * behaves like the first.
   *
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.5**
   */
  it("a drag that completes leaves no dragging, drop, attribute or timer, and the next one on the settled tree behaves like the first", () => {
    const outcomes = { dropped: 0, droppedRefused: 0, cancelled: 0, opened: 0 };
    forSeeds(150, (seed, r) => {
      const model = generate(r);
      const rig = mount(model);

      for (let round = 0; round < 2; round++) {
        const where = `seed ${seed}, drag ${round + 1}`;
        const rows = () => [...visibleIds(model, rig.opened), ...(model.strip ? [TOP] : [])];
        const source = pick(r, visibleIds(model, rig.opened));
        start(source);
        expect(rig.dnd.dragging, where).toBe(source);
        expect(attribute(), where).toBe(true);
        expect(el(source).hasAttribute("data-dragging"), where).toBe(true);

        // The reference model: what the indicator should be after each event.
        let want: DropState | null = null;
        let via: string | null = null;
        const steps = int(r, 12);
        for (let i = 0; i < steps; i++) {
          const over = pick(r, rows());
          const k = pick(r, KS);
          const kind = pick(r, ["dragOver", "dragOver", "dragEnter", "dragLeave"] as const);
          if (kind === "dragLeave") {
            fire(over, "dragLeave", k, { relatedTarget: null });
            const inside = pointerY(k) > 0 && pointerY(k) < rowHeight; // x is in the middle of the row
            if (!inside && via === over) {
              want = null;
              via = null;
            }
          } else {
            const to = expected(model, rig.opened, source, over, k);
            const event = fire(over, kind, k);
            expect(event.defaultPrevented, `${where}: ${kind} on ${over} at ${k}/40`).toBe(to !== null);
            want = to;
            via = to === null ? null : over;
          }
          expect(shown(), `${where}: after ${kind} on ${over} at ${k}/40`).toEqual(shownFor(want));
          expect(rig.dnd.dragging).toBe(source);
          const before = rig.opened.size;
          advance(pick(r, [0, 20, 300, 700, 1000]));
          // A folder that opens in the middle of the drag leaves the indicator where it is; the next event decides again.
          if (rig.opened.size > before) outcomes.opened++;
          expect(shown(), `${where}: after a pause`).toEqual(shownFor(want));
        }

        // The end: a drop (anywhere, it may be refused), or the drag ends without one (Escape, or released outside).
        const ending = pick(r, ["drop", "drop+end", "end", "leave+end"] as const);
        const dropsBefore = rig.drops.length;
        if (ending === "drop" || ending === "drop+end") {
          const over = pick(r, rows());
          const k = pick(r, KS);
          const to = expected(model, rig.opened, source, over, k);
          const event = fire(over, "drop", k);
          expect(event.defaultPrevented, `${where}: drop`).toBe(true);
          expect(rig.drops.slice(dropsBefore), `${where}: drop on ${over} at ${k}/40`).toEqual(to === null ? [] : [[source, to.id, to.zone]]);
          if (to === null) outcomes.droppedRefused++;
          else outcomes.dropped++;
          if (ending === "drop+end") fireEvent.dragEnd(el(source), { dataTransfer: data });
        } else {
          if (ending === "leave+end") fire(pick(r, rows()), "dragLeave", -4, { relatedTarget: null });
          fireEvent.dragEnd(el(source), { dataTransfer: data });
          expect(rig.drops.length, `${where}: a drag without a drop drops nothing`).toBe(dropsBefore);
          outcomes.cancelled++;
        }
        expectNothingLeft(rig);

        // Whatever comes later from the old drag is ignored: no indicator, nothing cancelled, no drop, no hover opens.
        const hovers = rig.hovers.length;
        const drops = rig.drops.length;
        for (const kind of ["dragEnter", "dragOver", "dragLeave", "drop"] as const) {
          const event = fire(pick(r, rows()), kind, pick(r, KS));
          expect(shown()).toEqual([]);
          if (kind !== "drop") expect(event.defaultPrevented, `${where}: a stray ${kind}`).toBe(false);
        }
        advance(5000);
        expect(rig.hovers.length).toBe(hovers);
        expect(rig.drops.length).toBe(drops);
        expectNothingLeft(rig);
      }
      cleanup();
    });
    expect(outcomes.dropped).toBeGreaterThan(20);
    expect(outcomes.droppedRefused).toBeGreaterThan(5);
    expect(outcomes.cancelled).toBeGreaterThan(20);
    expect(outcomes.opened).toBeGreaterThan(5);
  });

  /**
   * (hover) A closed folder under the dragged page for HOVER_OPEN_MS opens (the tree view is told once); leaving it first, or
   * ending the drag, cancels that; and the page can then be dropped at an exact place inside: the lower edge of the open
   * folder means "before its first child", and a drop on that child lands there.
   *
   * **Validates: Requirements 3.3**
   */
  it("a closed folder opens after the hover delay, and the page can then be dropped at an exact place inside", () => {
    let opened = 0;
    let exact = 0;
    forSeeds(150, (seed, r) => {
      const model = generate(r);
      // A closed container that holds something, and a page to drag that is neither it nor above it.
      const initial = visibleIds(model, new Set());
      const closed = initial.filter((id) => {
        const n = find(model, id)!;
        return n.container && !n.open && childrenOf(model, id).length > 0;
      });
      if (closed.length === 0) return;
      const folder = pick(r, closed);
      const sources = initial.filter((id) => !isWithin(model, folder, id));
      if (sources.length === 0) return;
      const source = pick(r, sources);
      // The middle of the row is "inside" whether or not the tree keeps an order, if a drop inside is allowed at all.
      const into = expected(model, new Set(), source, folder, 20);
      if (into === null) return;
      expect(into.zone).toBe("inside");

      const rig = mount(model);
      // Under the pointer for 699 ms: not yet. A repeated dragover on the same row does not restart the delay.
      start(source);
      fire(folder, "dragOver", 20);
      advance(400);
      fire(folder, "dragOver", 20);
      advance(299);
      expect(rig.hovers, `seed ${seed}`).toEqual([]);
      advance(1);
      expect(rig.hovers, `seed ${seed}: after ${HOVER_OPEN_MS} ms`).toEqual([folder]);
      expect(isOpen(model, rig.opened, folder)).toBe(true);
      opened++;
      advance(5000);
      expect(rig.hovers, "it opens once").toEqual([folder]);

      // Now at an exact place inside: the lower edge of the folder row is "before its first child", and a drop on that child lands there.
      const first = firstChildOf(model, rig.opened, folder)!;
      fire(folder, "dragOver", 36);
      expect(rig.dnd.drop).toEqual(expected(model, rig.opened, source, folder, 36));
      const dropped = fire(first, "drop", 4);
      expect(dropped.defaultPrevented).toBe(true);
      const want = expected(model, rig.opened, source, first, 4);
      expect(rig.drops).toEqual(want === null ? [] : [[source, first, want.zone]]);
      if (want !== null) exact++;
      fireEvent.dragEnd(el(source), { dataTransfer: data });
      expectNothingLeft(rig);
      cleanup();

      // Moving to another row before the delay is over cancels it, whatever that row does.
      const again = mount(model);
      const others = [...visibleIds(model, again.opened), ...(model.strip ? [TOP] : [])].filter((id) => id !== folder && id !== source);
      if (others.length > 0) {
        start(source);
        fire(folder, "dragOver", 20);
        advance(500);
        fire(pick(r, others), "dragEnter", pick(r, KS));
        advance(5000);
        expect(again.hovers.includes(folder), `seed ${seed}: left the folder, it must not open`).toBe(false);
        fireEvent.dragEnd(el(source), { dataTransfer: data });
        expectNothingLeft(again);
      }
      cleanup();
    });
    expect(opened).toBeGreaterThan(10);
    expect(exact).toBeGreaterThan(5);
  });
});
