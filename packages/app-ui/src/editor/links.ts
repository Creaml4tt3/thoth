/**
 * Resolves a wikilink chip to a page or, for `[[Folder/]]` (ADR-0049), a folder: its path ends in `/`. The index's own resolution
 * (`vault.outgoingLinks`) wins; otherwise the same `LinkResolver` the index
 * uses, then a unique title match, so freshly created pages still open.
 */
import { LinkResolver } from "@thoth/content";
import type { PageSummary } from "@thoth/domain";

/**
 * `folder`: the target is a folder (its sidebar row is shown on a click). `title`: the page's current title, shown on
 * a `thoth:page/<id>` chip instead of the label it was written with (a workspace, ADR-0049).
 */
export type LinkTarget = { state: "resolved"; path: string; folder?: boolean; title?: string } | { state: "unresolved" } | { state: "ambiguous"; candidates: string[] };

export interface LinkLookup {
  resolve(target: string): LinkTarget;
}

export interface OutgoingLink {
  target: string;
  resolution: string;
  targetPath: string | null;
}

export const EMPTY_LOOKUP: LinkLookup = { resolve: () => ({ state: "unresolved" }) };

export function buildLinkLookup(fromPath: string, outgoing: readonly OutgoingLink[], pages: readonly PageSummary[], folders: readonly string[] = []): LinkLookup {
  const indexed = new Map<string, string>();
  for (const link of outgoing) if (link.resolution === "resolved" && link.targetPath) indexed.set(link.target, link.targetPath);
  const resolver = new LinkResolver(
    pages.map((p) => p.path),
    pages.map((p) => ({ path: p.path, aliases: p.aliases })),
    folders,
  );
  return {
    resolve(target) {
      const hit = indexed.get(target);
      if (hit) return hit.endsWith("/") ? { state: "resolved", path: hit, folder: true } : { state: "resolved", path: hit };
      const result = resolver.resolve(fromPath, { syntax: "wikilink", target, external: false });
      if (result.state === "resolved") return result.path.endsWith("/") ? { state: "resolved", path: result.path, folder: true } : { state: "resolved", path: result.path };
      if (target.endsWith("/")) return result.state === "ambiguous" ? result : { state: "unresolved" };
      if (result.state === "ambiguous") return { state: "ambiguous", candidates: result.candidates };
      const wanted = target.trim().toLowerCase();
      const byTitle = pages.filter((p) => p.title.toLowerCase() === wanted);
      if (byTitle.length === 1) return { state: "resolved", path: byTitle[0]!.path };
      if (byTitle.length > 1) return { state: "ambiguous", candidates: byTitle.map((p) => p.path) };
      return { state: "unresolved" };
    },
  };
}
