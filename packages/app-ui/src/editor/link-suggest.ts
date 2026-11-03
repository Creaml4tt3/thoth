/**
 * Link suggestions, shared by both editor modes and both triggers (`[[` and `@`, ADR-0049): which pages, folders and
 * (in a workspace, after `@`) people match what was typed, in what order, and what to insert.
 *
 * In the Private Space the inserted target is the shortest one that `LinkResolver` resolves to the chosen page or
 * folder (ADR-0010): the bare name when it is unique in the vault, otherwise its vault path (without `.md`; a folder
 * keeps its trailing `/`). A link chosen here therefore never comes out ambiguous. In a workspace the target is
 * `thoth:page/<id>` with the title as label, so the link survives renames (`workspace/workspace-links.ts`).
 */
import { LinkResolver } from "@thoth/content";
import { basename, collisionKey, stripExtension, type PageSummary } from "@thoth/domain";

export interface LinkSuggestion {
  kind: "page" | "folder" | "person";
  /** The page's path or ID, the folder's path (ending in `/`) or ID, or the person's user ID. */
  path: string;
  /** What the menu shows first: the title, folder name or display name. */
  title: string;
  /** Folder path, shown to tell same-named pages apart; "" at the top. */
  folder: string;
  /** Set when the match came from an alias rather than the title or name. */
  alias: string | null;
  /** The text to put between `[[` and `]]` (a person: the user ID). */
  target: string;
  /** Written after `|` (workspace links: the title). */
  label?: string;
}

export const MAX_SUGGESTIONS = 8;

export const fold = (s: string): string => collisionKey(s.trim());

/** What a suggestion is matched on: the text, how good a field it is (0 best), and the alias it came from. */
export type Field = [text: string, field: number, alias: string | null];

/** 0 is best. Prefix beats word-start beats substring; titles beat names beat aliases beat folders. */
export function rank(query: string, fields: readonly Field[]): { rank: number; alias: string | null } | null {
  if (query === "") return { rank: 0, alias: null };
  let best: { rank: number; alias: string | null } | null = null;
  for (const [raw, field, alias] of fields) {
    const text = fold(raw);
    const at = text.indexOf(query);
    if (at < 0) continue;
    const kind = text === query ? 0 : at === 0 ? 1 : /[\s\-_/.(]/.test(text[at - 1]!) ? 2 : 3;
    const r = kind * 10 + field;
    if (!best || r < best.rank) best = { rank: r, alias };
  }
  return best;
}

export interface Candidate {
  item: LinkSuggestion;
  fields: readonly Field[];
  /** Newer first among equal matches. */
  recency: number;
}

/** Ranks `candidates` for `raw` (only the page part of `Page#Heading|label` counts) and keeps the best few. */
export function rankCandidates(raw: string, candidates: readonly Candidate[]): LinkSuggestion[] {
  const query = fold(raw.split(/[#|]/, 1)[0]!);
  const order = { page: 0, folder: 1, person: 2 };
  const ranked: { c: Candidate; rank: number; alias: string | null }[] = [];
  for (const c of candidates) {
    const hit = rank(query, c.fields);
    // A folder or person matches from the start of a word only: "ro" inside "Projects" is noise.
    if (hit && (c.item.kind === "page" || hit.rank < 30)) ranked.push({ c, ...hit });
  }
  ranked.sort((a, b) => a.rank - b.rank || order[a.c.item.kind] - order[b.c.item.kind] || b.c.recency - a.c.recency || a.c.item.path.localeCompare(b.c.item.path));
  return ranked.slice(0, MAX_SUGGESTIONS).map(({ c, alias }) => ({ ...c.item, alias }));
}

/** The link target for `path` as seen from `fromPath`: the page name when that resolves uniquely, else the full path. */
export function linkTarget(path: string, fromPath: string, resolver: LinkResolver): string {
  const name = stripExtension(basename(path));
  const short = resolver.resolve(fromPath, { syntax: "wikilink", target: name, external: false });
  return short.state === "resolved" && short.path === path ? name : stripExtension(path);
}

/** The same for a folder: `Name/` when that resolves uniquely, else `Full/Path/`. */
function folderTarget(folder: string, fromPath: string, resolver: LinkResolver): string {
  const name = `${basename(folder)}/`;
  const short = resolver.resolve(fromPath, { syntax: "wikilink", target: name, external: false });
  return short.state === "resolved" && short.path === `${folder}/` ? name : `${folder}/`;
}

export interface LinkSuggester {
  /** True when `suggest` offers people (a workspace). */
  people?: boolean;
  /** `people`: also offer people (after `@` in a workspace). */
  suggest(query: string, options?: { people?: boolean }): LinkSuggestion[];
}

const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** The Private Space: vault pages and folders (no people, ADR-0049). */
export function createLinkSuggester(fromPath: string, pages: readonly PageSummary[], folders: readonly string[] = []): LinkSuggester {
  const resolver = new LinkResolver(
    pages.map((p) => p.path),
    pages.map((p) => ({ path: p.path, aliases: p.aliases })),
    folders,
  );
  let candidates: Candidate[] | null = null;
  const all = (): Candidate[] =>
    (candidates ??= [
      ...pages
        .filter((p) => p.path !== fromPath)
        .map((p): Candidate => ({
          item: { kind: "page", path: p.path, title: p.title, folder: parentOf(p.path), alias: null, target: linkTarget(p.path, fromPath, resolver) },
          fields: [[p.title, 0, null], [stripExtension(basename(p.path)), 1, null], ...p.aliases.map((a): Field => [a, 2, a]), [stripExtension(p.path), 3, null]],
          recency: p.mtimeMs,
        })),
      ...folders.map((f): Candidate => ({
        item: { kind: "folder", path: `${f}/`, title: basename(f), folder: parentOf(f), alias: null, target: folderTarget(f, fromPath, resolver) },
        fields: [[basename(f), 1, null], [f, 3, null]],
        recency: 0,
      })),
    ]);
  return { suggest: (raw) => rankCandidates(raw, all()) };
}

export const EMPTY_SUGGESTER: LinkSuggester = { suggest: () => [] };

/**
 * `@query` directly before the caret (ADR-0049): the `@` starts a word (start of the line, after whitespace or an
 * opening bracket), so an email address or a word with `@` inside never opens the menu. The query may hold spaces
 * (names have them); the editors close the menu once a query with a space matches nothing. Null otherwise.
 */
export function atQuery(before: string): { at: number; query: string } | null {
  const m = /(?:^|[\s([{])@([^@\n￼[\]]{0,60})$/.exec(before);
  if (!m || /^\s/.test(m[1]!)) return null;
  return { at: before.length - m[1]!.length - 1, query: m[1]! };
}

/** A menu after `@` stays open while its query has no space, or still matches something. */
export const atMenuOpen = (query: string, matches: number): boolean => matches > 0 || !/\s/.test(query);
