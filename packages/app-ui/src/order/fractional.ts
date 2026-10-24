/**
 * Fractional index keys for the order people give workspace pages (ADR-0016 rule 4, protocol `page-order`).
 *
 * A key is a string over `0-9A-Za-z`, compared as a byte string (ASCII order, never locale). Between any two keys
 * there is room for another one, so moving a page writes only that page's key. This is the midpoint step of the
 * well-known "fractional-indexing" algorithm without its integer-part header; keys this module makes never end in
 * `0`, which keeps a gap between neighbours. Keys made by other clients may not follow that rule: when there is no
 * room, `keyBetween` throws `NoRoom` and the caller renumbers the siblings (`spread`).
 */
export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY = /^[0-9A-Za-z]{1,128}$/;
/** The protocol's limit on a key's length. */
export const MAX_KEY_LENGTH = 128;

export class NoRoom extends Error {
  constructor(a: string | null, b: string | null) {
    super(`No key fits between ${a ?? "start"} and ${b ?? "end"}`);
    this.name = "NoRoom";
  }
}

export const isKey = (value: unknown): value is string => typeof value === "string" && KEY.test(value);

/** ASCII comparison, the order servers and clients sort keys in. */
export const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // A shared prefix stays; the midpoint is found after it.
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a === "" ? 0 : DIGITS.indexOf(a[0]!);
  const db = b === null ? DIGITS.length : DIGITS.indexOf(b[0]!);
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  // Adjacent digits: take b's first digit if b is longer (b > that digit), else extend a.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

/** A key strictly between `a` and `b` (null: the start or the end). Throws `NoRoom` when none fits. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !isKey(a)) throw new NoRoom(a, b);
  if (b !== null && !isKey(b)) throw new NoRoom(a, b);
  if (a !== null && b !== null && compareKeys(a, b) >= 0) throw new NoRoom(a, b);
  // "x" and "x0" have nothing between them; neither does any b that is a or a followed by zeros.
  if (b !== null && /^0*$/.test(b.slice((a ?? "").length)) && b.startsWith(a ?? "")) throw new NoRoom(a, b);
  const key = midpoint(a ?? "", b);
  if (key.length > MAX_KEY_LENGTH || (a !== null && compareKeys(key, a) <= 0) || (b !== null && compareKeys(key, b) >= 0)) throw new NoRoom(a, b);
  return key;
}

/** `n` increasing keys strictly between `a` and `b`, spread evenly (by repeated bisection). */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}

/** Fresh keys for `n` siblings, used to renumber a folder whose keys have no room left. */
export const spread = (n: number): string[] => keysBetween(null, null, n);

export interface Positioned {
  id: string;
  position: string | null | undefined;
}

/**
 * What to write so that `moving` sits at `index` among `siblings` (the display order of its new parent, without
 * `moving`). Only `moving` gets a key, unless an unpositioned sibling has to stay above it: those get keys too, in
 * their current order. When the keys have no room, every sibling is renumbered. Returns the pages to update.
 */
export function placeAt(siblings: readonly Positioned[], moving: string, index: number): { id: string; position: string }[] {
  const list = siblings.filter((s) => s.id !== moving);
  const at = Math.max(0, Math.min(index, list.length));
  const before = list.slice(0, at);
  const after = list.slice(at);
  // Every page above the new place needs a key, or it would sort below a positioned page.
  const firstUnkeyed = before.findIndex((s) => !isKey(s.position));
  try {
    if (firstUnkeyed === -1) {
      const prev = before.at(-1)?.position ?? null;
      const next = after[0] && isKey(after[0].position) ? after[0].position : null;
      return [{ id: moving, position: keyBetween(prev, next) }];
    }
    const prev = firstUnkeyed === 0 ? null : before[firstUnkeyed - 1]!.position!;
    const tail = before.slice(firstUnkeyed);
    const next = after[0] && isKey(after[0].position) ? after[0].position : null;
    const keys = keysBetween(prev, next, tail.length + 1);
    return [...tail.map((s, i) => ({ id: s.id, position: keys[i]! })), { id: moving, position: keys.at(-1)! }];
  } catch (error) {
    if (!(error instanceof NoRoom)) throw error;
    const order = [...before.map((s) => s.id), moving, ...after.filter((s) => isKey(s.position)).map((s) => s.id)];
    const keys = spread(order.length);
    const current = new Map(list.map((s) => [s.id, s.position]));
    return order.map((id, i) => ({ id, position: keys[i]! })).filter((u) => u.id === moving || current.get(u.id) !== u.position);
  }
}
