import { describe, expect, it } from "vitest";
import { PagePositionSchema } from "@thoth/workspace-protocol";
import { DIGITS, MAX_KEY_LENGTH, NoRoom, compareKeys, isKey, keyBetween, keysBetween, placeAt, spread, type Positioned } from "../src/order/fractional.ts";

const sorted = (keys: readonly string[]) => [...keys].sort(compareKeys);
const page = (id: string, position: string | null = null): Positioned => ({ id, position });

/** Applies the writes of `placeAt` to `siblings` and returns the resulting display order of ids (positioned, then the rest by id). */
function apply(siblings: Positioned[], moving: string, index: number): { order: string[]; writes: { id: string; position: string }[] } {
  const writes = placeAt(siblings, moving, index);
  const next = new Map(siblings.map((s) => [s.id, s.position]));
  if (!next.has(moving)) next.set(moving, null);
  for (const w of writes) next.set(w.id, w.position);
  const keyed = [...next].filter(([, p]) => p !== null && p !== undefined) as [string, string][];
  const rest = [...next].filter(([, p]) => p === null || p === undefined).map(([id]) => id).sort();
  return { order: [...keyed.sort((a, b) => compareKeys(a[1], b[1])).map(([id]) => id), ...rest], writes };
}

describe("keyBetween", () => {
  it("makes a first key, one before, one after, and one between", () => {
    const first = keyBetween(null, null);
    expect(isKey(first)).toBe(true);
    const before = keyBetween(null, first);
    const after = keyBetween(first, null);
    expect(compareKeys(before, first)).toBeLessThan(0);
    expect(compareKeys(first, after)).toBeLessThan(0);
    const between = keyBetween(before, first);
    expect(compareKeys(before, between)).toBeLessThan(0);
    expect(compareKeys(between, first)).toBeLessThan(0);
  });

  it("keeps order when inserting at the end, at the start, and always in the same gap", () => {
    let end = keyBetween(null, null);
    const ends = [end];
    for (let i = 0; i < 60; i++) {
      end = keyBetween(end, null);
      ends.push(end);
    }
    expect(ends).toEqual(sorted(ends));
    let start = ends[0]!;
    const starts = [start];
    for (let i = 0; i < 60; i++) {
      start = keyBetween(null, start);
      starts.push(start);
    }
    expect([...starts].reverse()).toEqual(sorted(starts));
    // Bisecting the same gap again and again stays ordered and valid for the protocol.
    let lo = "a";
    const hi = "b";
    for (let i = 0; i < 80; i++) {
      const mid = keyBetween(lo, hi);
      expect(compareKeys(lo, mid)).toBeLessThan(0);
      expect(compareKeys(mid, hi)).toBeLessThan(0);
      expect(PagePositionSchema.safeParse(mid).success).toBe(true);
      lo = mid;
    }
  });

  it("compares as ASCII bytes, never by locale", () => {
    // In ASCII, digits < upper case < lower case. A locale comparison would put "a" before "B".
    expect(compareKeys("B", "a")).toBeLessThan(0);
    expect(compareKeys("9", "A")).toBeLessThan(0);
    expect(DIGITS).toBe(sorted([...DIGITS]).join(""));
    const key = keyBetween("B", "a");
    expect(compareKeys("B", key)).toBeLessThan(0);
    expect(compareKeys(key, "a")).toBeLessThan(0);
    expect(compareKeys("Z", keyBetween("Z", "a"))).toBeLessThan(0);
  });

  it("throws NoRoom when nothing fits between two keys", () => {
    expect(() => keyBetween("x", "x0")).toThrow(NoRoom);
    expect(() => keyBetween("x", "x00")).toThrow(NoRoom);
    expect(() => keyBetween("0", "00")).toThrow(NoRoom);
    expect(() => keyBetween(null, "0")).toThrow(NoRoom);
    expect(() => keyBetween("b", "a")).toThrow(NoRoom);
    expect(() => keyBetween("a", "a")).toThrow(NoRoom);
  });

  it("throws NoRoom for keys the protocol would refuse", () => {
    expect(() => keyBetween("a-b", null)).toThrow(NoRoom);
    expect(() => keyBetween(null, "")).toThrow(NoRoom);
    expect(() => keyBetween("a", "é")).toThrow(NoRoom);
  });

  it("never returns a key longer than 128 characters; it throws NoRoom instead", () => {
    expect(MAX_KEY_LENGTH).toBe(128);
    const long = "z".repeat(MAX_KEY_LENGTH);
    expect(isKey(long)).toBe(true);
    expect(isKey(`${long}a`)).toBe(false);
    // Nothing above the highest digit fits without a 129th character.
    expect(() => keyBetween(long, null)).toThrow(NoRoom);
    // Growth by always inserting right after the previous key ends in NoRoom, not in an invalid key.
    let key = "a";
    let threw = false;
    for (let i = 0; i < 3000; i++) {
      try {
        key = keyBetween(key, "b");
        expect(key.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
        expect(PagePositionSchema.safeParse(key).success).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(NoRoom);
        threw = true;
        break;
      }
    }
    expect(threw).toBe(true);
  });
});

describe("keysBetween and spread", () => {
  it("returns n increasing keys inside the gap", () => {
    const keys = keysBetween("a", "b", 20);
    expect(keys).toHaveLength(20);
    expect(keys).toEqual(sorted(keys));
    expect(new Set(keys).size).toBe(20);
    expect(compareKeys("a", keys[0]!)).toBeLessThan(0);
    expect(compareKeys(keys.at(-1)!, "b")).toBeLessThan(0);
    expect(keysBetween("a", "b", 0)).toEqual([]);
  });

  it("spread renumbers n siblings with short, distinct, ordered, valid keys that leave room", () => {
    for (const n of [1, 2, 3, 10, 200]) {
      const keys = spread(n);
      expect(keys).toHaveLength(n);
      expect(keys).toEqual(sorted(keys));
      expect(new Set(keys).size).toBe(n);
      for (const key of keys) {
        expect(PagePositionSchema.safeParse(key).success).toBe(true);
        expect(key.length).toBeLessThanOrEqual(4);
      }
      // There is room between every pair, and before the first and after the last.
      for (let i = 1; i < n; i++) expect(() => keyBetween(keys[i - 1]!, keys[i]!)).not.toThrow();
      expect(() => keyBetween(null, keys[0]!)).not.toThrow();
      expect(() => keyBetween(keys.at(-1)!, null)).not.toThrow();
    }
    expect(spread(0)).toEqual([]);
  });
});

describe("placeAt", () => {
  const abc = [page("a", "G"), page("b", "N"), page("c", "U")];

  it("writes only the moved page when its siblings all have positions", () => {
    for (const [moving, index] of [["a", 2], ["c", 0], ["b", 0], ["c", 1]] as const) {
      const { writes, order } = apply(abc, moving, index);
      expect(writes.map((w) => w.id)).toEqual([moving]);
      const others = abc.filter((s) => s.id !== moving).map((s) => s.id);
      expect(order.filter((id) => id !== moving)).toEqual(others);
      expect(order.indexOf(moving)).toBe(index);
    }
  });

  it("places a new page (not among the siblings) anywhere", () => {
    const { order, writes } = apply(abc, "new", 1);
    expect(writes).toHaveLength(1);
    expect(order).toEqual(["a", "new", "b", "c"]);
    expect(apply([], "only", 0).order).toEqual(["only"]);
  });

  it("clamps an index that is out of range", () => {
    expect(apply(abc, "a", 99).order).toEqual(["b", "c", "a"]);
    expect(apply(abc, "c", -5).order).toEqual(["c", "a", "b"]);
  });

  it("renumbers the siblings that have no room when the keys cannot be split", () => {
    const tight = [page("a", "x"), page("b", "x0"), page("c", "x00"), page("d", "y")];
    const { writes, order } = apply(tight, "d", 1); // between "x" and "x0": no room
    expect(order).toEqual(["a", "d", "b", "c"]);
    // All of them got fresh, valid keys (NoRoom triggered renumbering), and only changed ones are written.
    expect(writes.map((w) => w.id).sort()).toEqual(["a", "b", "c", "d"].sort());
    expect(writes.map((w) => w.position)).toEqual(spread(4));
    for (const w of writes) expect(PagePositionSchema.safeParse(w.position).success).toBe(true);
  });

  it("renumbers when two siblings hold the same key (written by two clients at once)", () => {
    const clash = [page("a", "M"), page("b", "M"), page("c", "T")];
    const { order, writes } = apply(clash, "c", 1);
    expect(order).toEqual(["a", "c", "b"]);
    expect(writes.length).toBeGreaterThan(1);
  });

  it("renumbers when a key has no room because of the 128-character limit", () => {
    const long = "a".repeat(MAX_KEY_LENGTH);
    const siblings = [page("a", long), page("b", `${long.slice(0, -1)}b`)];
    const { order, writes } = apply(siblings, "x", 1);
    expect(order).toEqual(["a", "x", "b"]);
    expect(writes.map((w) => w.id).sort()).toEqual(["a", "b", "x"]);
    for (const w of writes) expect(w.position.length).toBeLessThan(10);
  });

  it("skips renumbered siblings whose key did not change", () => {
    const first = spread(3);
    const siblings = [page("a", first[0]!), page("b", first[1]!), page("c", "zz0")];
    const { writes } = apply([...siblings, page("d", "zz00")], "a", 3);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      const before = [...siblings, page("d", "zz00")].find((s) => s.id === w.id)?.position;
      expect(before).not.toBe(w.position);
    }
  });

  it("keeps unpositioned siblings above the moved page by giving them keys, in their order", () => {
    const siblings = [page("a"), page("b"), page("c")]; // all unpositioned: A-Z
    const { order, writes } = apply(siblings, "x", 2);
    expect(order).toEqual(["a", "b", "x", "c"]);
    expect(writes.map((w) => w.id)).toEqual(["a", "b", "x"]);
    // Moving to the top of an unpositioned list writes only the moved page.
    const top = apply(siblings, "c", 0);
    expect(top.order).toEqual(["c", "a", "b"]);
    expect(top.writes.map((w) => w.id)).toEqual(["c"]);
  });

  it("leaves unpositioned siblings below the moved page alone", () => {
    const siblings = [page("a", "M"), page("b"), page("c")];
    const { order, writes } = apply(siblings, "x", 1);
    expect(order).toEqual(["a", "x", "b", "c"]);
    expect(writes.map((w) => w.id)).toEqual(["x"]);
  });

  it("stays consistent over many random moves", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let list: Positioned[] = "abcdefghijkl".split("").map((id) => page(id));
    let expected = list.map((s) => s.id);
    for (let step = 0; step < 300; step++) {
      const moving = expected[rand(expected.length)]!;
      const index = rand(expected.length);
      const writes = placeAt(list, moving, index);
      const rest = expected.filter((id) => id !== moving);
      rest.splice(Math.min(index, rest.length), 0, moving);
      expected = rest;
      const next = new Map(list.map((s) => [s.id, s.position]));
      for (const w of writes) {
        expect(PagePositionSchema.safeParse(w.position).success).toBe(true);
        next.set(w.id, w.position);
      }
      const keyed = [...next].filter(([, p]) => p).sort((a, b) => compareKeys(a[1]!, b[1]!));
      const unkeyed = [...next].filter(([, p]) => !p).map(([id]) => id).sort();
      list = [...keyed.map(([id, p]) => page(id, p)), ...unkeyed.map((id) => page(id))];
      expect(list.map((s) => s.id)).toEqual(expected);
    }
  });
});
