/**
 * The order of the sidebar's sections (ADR-0019 amendment, 2026-10-26): the Private Space (`private`), one per workspace
 * server (`server:<id>`) and, where the app has it, the agents (`agents`). The brand row, search and the actions at the
 * bottom are not sections and never move.
 *
 * The stored order is a list of ids. Sections that are there now follow it; a section it does not name (new, or added
 * by a later version) goes at the end, in its natural place among the other new ones; ids it names that are not there
 * now (a server removed, or signed out of this list for a while) are ignored, and keep their place for when they come
 * back.
 */

export const PRIVATE_SECTION = "private";
export const AGENTS_SECTION = "agents";
export const serverSection = (id: string): string => `server:${id}`;

/** The sections shown, in order: `present` (their natural order) arranged by the `stored` order. */
export function arrangeSections(stored: readonly string[], present: readonly string[]): string[] {
  const here = new Set(present);
  const known = stored.filter((id) => here.has(id));
  const seen = new Set(known);
  return [...known, ...present.filter((id) => !seen.has(id))];
}

/**
 * The order to store after the section `id` is moved to index `to` of what is shown. Ids that are stored but not
 * shown stay where they were among the others.
 */
export function moveSection(stored: readonly string[], present: readonly string[], id: string, to: number): string[] {
  const shown = arrangeSections(stored, present);
  const from = shown.indexOf(id);
  if (from < 0) return [...stored];
  const next = shown.filter((x) => x !== id);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
  const here = new Set(present);
  const full = [...stored.filter((x, i) => stored.indexOf(x) === i), ...present.filter((x) => !stored.includes(x))];
  let k = 0;
  return full.map((x) => (here.has(x) ? next[k++]! : x));
}
