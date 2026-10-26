/** Small pure operations on a list of favorite ids (ADR-0027); the order is the person's. */

/** Adds `id` at the end, or takes it out when it is there. */
export function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Moves `id` to index `to` of the list (kept within it). An id that is not there changes nothing. */
export function moveInGroup(list: readonly string[], id: string, to: number): string[] {
  const from = list.indexOf(id);
  if (from < 0) return [...list];
  const rest = list.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(Math.trunc(to), rest.length)), 0, id);
  return rest;
}
