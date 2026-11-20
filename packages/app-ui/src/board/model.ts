/**
 * What the Board draws, as plain data: notes and strings from the index graph (Vault.graph()) and a board file.
 * The graph shapes are re-declared here so app-ui does not depend on local-store.
 */
import { basename, dirname, isMarkdownPath, stripExtension } from "@thoth/domain";
import { pinnedPaths, type CanvasFile } from "./canvas.ts";

export interface GraphPage { id: string; path: string; title: string; tags: string[]; excerpt: string }
export interface GraphLink { from: string; to: string }
export interface Graph { pages: GraphPage[]; links: GraphLink[] }

export interface BoardNote {
  path: string;
  title: string;
  excerpt: string;
  tags: string[];
  /** Colour name from the folder colours, or null (the note is cream). */
  color: string | null;
  x: number;
  y: number;
  state: "pinned" | "suggested" | "missing" | "free";
  /** Distinct pages linked to or from this one, anywhere in the Space (for the aria-label). */
  links: number;
}
/** One string per linked pair; `from` is the lexically smaller path. */
export interface BoardString { from: string; to: string }

/** The nearest ancestor folder of the page that has a colour, its own folder first. */
export function folderColor(path: string, colors: Readonly<Record<string, string>>): string | null {
  for (let dir = dirname(path); dir; dir = dirname(dir)) if (Object.hasOwn(colors, dir) && colors[dir]) return colors[dir]!;
  return null;
}

function neighbours(links: readonly GraphLink[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  for (const { from, to } of links) {
    if (from === to) continue;
    add(from, to);
    add(to, from);
  }
  return adj;
}

const byTitle = (title: ReadonlyMap<string, string>) => (a: string, b: string) => (title.get(a) ?? a).localeCompare(title.get(b) ?? b) || a.localeCompare(b);

/** Unpinned pages linked to or from a pinned page, most links to pinned pages first, then title; at most `limit`. */
export function suggestions(graph: Graph, pinned: readonly string[], limit = 12): string[] {
  const pin = new Set(pinned);
  const adj = neighbours(graph.links);
  const known = new Set(graph.pages.map((p) => p.path));
  const title = new Map(graph.pages.map((p) => [p.path, p.title]));
  const score = new Map<string, number>();
  for (const [path, set] of adj) {
    if (pin.has(path) || !known.has(path)) continue;
    const n = [...set].filter((o) => pin.has(o)).length;
    if (n) score.set(path, n);
  }
  const cmp = byTitle(title);
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || cmp(a, b)).slice(0, limit);
}

const strings = (links: readonly GraphLink[], onBoard: ReadonlySet<string>): BoardString[] => {
  const seen = new Set<string>();
  const out: BoardString[] = [];
  for (const l of links) {
    const [from, to] = l.from < l.to ? [l.from, l.to] : [l.to, l.from];
    const key = `${from}\n${to}`;
    if (l.from === l.to || !onBoard.has(from) || !onBoard.has(to) || seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to });
  }
  return out;
};

const noteOf = (p: GraphPage, state: BoardNote["state"], x: number, y: number, colors: Readonly<Record<string, string>>, links: number): BoardNote => ({
  path: p.path, title: p.title, excerpt: p.excerpt, tags: p.tags, color: folderColor(p.path, colors), x, y, state, links,
});

// A suggestion sits on a ring around its strongest pinned neighbour: 8 spots a ring, rings 240 px apart.
// shortcut: it may land on another pinned note; the user can drag it, upgrade if that proves common.
const RING = 240;
function fan(anchor: { x: number; y: number }, k: number): { x: number; y: number } {
  const ring = Math.floor(k / 8);
  const angle = ((k % 8) * Math.PI) / 4 + (ring % 2) * (Math.PI / 8);
  const r = RING * (1 + ring);
  return { x: Math.round(anchor.x + r * Math.cos(angle)), y: Math.round(anchor.y + r * Math.sin(angle)) };
}

/**
 * Pinned notes at the board's positions ("missing" when the page is not in the index), plus suggestions placed next to
 * their strongest pinned neighbour (the one with the most links in the Space; ties by title). Strings join board notes only.
 */
export function boardNotes(graph: Graph, canvas: CanvasFile, colors: Readonly<Record<string, string>>): { notes: BoardNote[]; strings: BoardString[] } {
  const adj = neighbours(graph.links);
  const degree = (path: string) => adj.get(path)?.size ?? 0;
  const pages = new Map(graph.pages.map((p) => [p.path, p]));
  const title = new Map(graph.pages.map((p) => [p.path, p.title]));
  const pinned = pinnedPaths(canvas);
  const at = new Map<string, { x: number; y: number }>();
  for (const n of canvas.nodes) if (n.type === "file" && typeof n.file === "string" && !at.has(n.file)) at.set(n.file, { x: n.x, y: n.y });

  const notes: BoardNote[] = pinned.map((path) => {
    const { x, y } = at.get(path)!;
    const p = pages.get(path);
    return p ? noteOf(p, "pinned", x, y, colors, degree(path)) : { path, title: stripExtension(basename(path)), excerpt: "", tags: [], color: null, x, y, state: "missing", links: 0 };
  });

  const cmp = byTitle(title);
  const used = new Map<string, number>();
  for (const path of suggestions(graph, pinned)) {
    const anchor = [...adj.get(path)!].filter((o) => at.has(o) && pages.has(o)).sort((a, b) => degree(b) - degree(a) || cmp(a, b))[0];
    if (anchor === undefined) continue; // its only pinned neighbour is missing from the index (a reindex race)
    const k = used.get(anchor) ?? 0;
    used.set(anchor, k + 1);
    const { x, y } = fan(at.get(anchor)!, k);
    notes.push(noteOf(pages.get(path)!, "suggested", x, y, colors, degree(path)));
  }
  return { notes, strings: strings(graph.links, new Set(notes.map((n) => n.path))) };
}

/** Every page as a free note at its laid-out position (the origin until the layout has one), and every link as a string. */
export function overviewNotes(graph: Graph, colors: Readonly<Record<string, string>>, positions: ReadonlyMap<string, { x: number; y: number }>): { notes: BoardNote[]; strings: BoardString[] } {
  const adj = neighbours(graph.links);
  const notes = graph.pages.map((p) => noteOf(p, "free", positions.get(p.path)?.x ?? 0, positions.get(p.path)?.y ?? 0, colors, adj.get(p.path)?.size ?? 0));
  return { notes, strings: strings(graph.links, new Set(notes.map((n) => n.path))) };
}

/** A node Thoth does not own (Obsidian's text card, link card, group, or a file that is not a page), drawn plainly and read-only. */
export interface BoardExtra {
  id: string;
  kind: "text" | "link" | "group" | "file";
  x: number;
  y: number;
  width: number;
  height: number;
  /** The card's text, the link's URL, the group's label (may be empty) or the file's name. */
  text: string;
}

const EXTRA_FIELD = { text: "text", link: "url", group: "label", file: "file" } as const;

/** The canvas's other nodes, groups first so they draw under the cards. Unknown node types are not drawn. */
export function boardExtras(canvas: CanvasFile): BoardExtra[] {
  const out: BoardExtra[] = [];
  for (const n of canvas.nodes) {
    if (!Object.hasOwn(EXTRA_FIELD, n.type)) continue;
    const kind = n.type as BoardExtra["kind"];
    if (kind === "file" && typeof n.file === "string" && isMarkdownPath(n.file)) continue; // a page: a note
    const raw = n[EXTRA_FIELD[kind]];
    const text = typeof raw === "string" ? raw : "";
    out.push({ id: n.id, kind, x: n.x, y: n.y, width: n.width, height: n.height, text: kind === "file" ? basename(text) : text });
  }
  return out.sort((a, b) => Number(b.kind === "group") - Number(a.kind === "group"));
}
