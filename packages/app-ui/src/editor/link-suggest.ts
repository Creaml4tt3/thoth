/**
 * Wikilink suggestions, shared by both editor modes: which pages match what
 * was typed after `[[`, in what order, and what link text to insert.
 *
 * The inserted target is the shortest one that `LinkResolver` resolves to the
 * chosen page (ADR-0010): the bare page name when it is unique in the vault,
 * otherwise its vault path without `.md`. A link chosen here therefore never
 * comes out ambiguous.
 */
import { LinkResolver } from "@thoth/content";
import { basename, collisionKey, stripExtension, type PageSummary } from "@thoth/domain";

export interface LinkSuggestion {
  path: string;
  /** What the menu shows first: the page title. */
  title: string;
  /** Folder path, shown to tell same-named pages apart; "" at the vault root. */
  folder: string;
  /** Set when the match came from an alias rather than the title or name. */
  alias: string | null;
  /** The text to put between `[[` and `]]`. */
  target: string;
}

export const MAX_SUGGESTIONS = 8;

const fold = (s: string): string => collisionKey(s.trim());

/** 0 is best. Prefix beats word-start beats substring; titles beat names beat aliases beat folders. */
function score(query: string, page: PageSummary): { rank: number; alias: string | null } | null {
  if (query === "") return { rank: 0, alias: null };
  const name = fold(stripExtension(basename(page.path)));
  const fields: [string, number, string | null][] = [
    [fold(page.title), 0, null],
    [name, 1, null],
    ...page.aliases.map((a): [string, number, string | null] => [fold(a), 2, a]),
    [fold(stripExtension(page.path)), 3, null],
  ];
  let best: { rank: number; alias: string | null } | null = null;
  for (const [text, field, alias] of fields) {
    const at = text.indexOf(query);
    if (at < 0) continue;
    const kind = text === query ? 0 : at === 0 ? 1 : /[\s\-_/.(]/.test(text[at - 1]!) ? 2 : 3;
    const rank = kind * 10 + field;
    if (!best || rank < best.rank) best = { rank, alias };
  }
  return best;
}

/** The link target for `path` as seen from `fromPath`: the page name when that resolves uniquely, else the full path. */
export function linkTarget(path: string, fromPath: string, resolver: LinkResolver): string {
  const name = stripExtension(basename(path));
  const short = resolver.resolve(fromPath, { syntax: "wikilink", target: name, external: false });
  return short.state === "resolved" && short.path === path ? name : stripExtension(path);
}

export interface LinkSuggester {
  suggest(query: string): LinkSuggestion[];
}

export function createLinkSuggester(fromPath: string, pages: readonly PageSummary[]): LinkSuggester {
  const resolver = new LinkResolver(
    pages.map((p) => p.path),
    pages.map((p) => ({ path: p.path, aliases: p.aliases })),
  );
  return {
    suggest(raw) {
      // Only the page part of `[[Page#Heading|label` is matched.
      const query = fold(raw.split(/[#|]/, 1)[0]!);
      const ranked: { page: PageSummary; rank: number; alias: string | null }[] = [];
      for (const page of pages) {
        if (page.path === fromPath) continue;
        const hit = score(query, page);
        if (hit) ranked.push({ page, ...hit });
      }
      ranked.sort((a, b) => a.rank - b.rank || b.page.mtimeMs - a.page.mtimeMs || a.page.path.localeCompare(b.page.path));
      return ranked.slice(0, MAX_SUGGESTIONS).map(({ page, alias }) => {
        const slash = page.path.lastIndexOf("/");
        return { path: page.path, title: page.title, folder: slash < 0 ? "" : page.path.slice(0, slash), alias, target: linkTarget(page.path, fromPath, resolver) };
      });
    },
  };
}

export const EMPTY_SUGGESTER: LinkSuggester = { suggest: () => [] };
