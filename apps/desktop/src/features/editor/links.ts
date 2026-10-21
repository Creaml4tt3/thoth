/**
 * Resolves a wikilink chip to a page. The index's own resolution
 * (`vault.outgoingLinks`) wins; otherwise the same `LinkResolver` the index
 * uses, then a unique title match, so freshly created pages still open.
 */
import { LinkResolver } from "@thoth/content";
import type { PageSummary } from "@thoth/domain";
import type { Vault } from "@thoth/local-store";

export type LinkTarget = { state: "resolved"; path: string } | { state: "unresolved" } | { state: "ambiguous"; candidates: string[] };

export interface LinkLookup {
  resolve(target: string): LinkTarget;
}

export interface OutgoingLink {
  target: string;
  resolution: string;
  targetPath: string | null;
}

export const EMPTY_LOOKUP: LinkLookup = { resolve: () => ({ state: "unresolved" }) };

export function buildLinkLookup(fromPath: string, outgoing: readonly OutgoingLink[], pages: readonly PageSummary[]): LinkLookup {
  const indexed = new Map<string, string>();
  for (const link of outgoing) if (link.resolution === "resolved" && link.targetPath) indexed.set(link.target, link.targetPath);
  const resolver = new LinkResolver(
    pages.map((p) => p.path),
    pages.map((p) => ({ path: p.path, aliases: p.aliases })),
  );
  return {
    resolve(target) {
      const hit = indexed.get(target);
      if (hit) return { state: "resolved", path: hit };
      const result = resolver.resolve(fromPath, { syntax: "wikilink", target, external: false });
      if (result.state === "resolved") return { state: "resolved", path: result.path };
      if (result.state === "ambiguous") return { state: "ambiguous", candidates: result.candidates };
      const wanted = target.trim().toLowerCase();
      const byTitle = pages.filter((p) => p.title.toLowerCase() === wanted);
      if (byTitle.length === 1) return { state: "resolved", path: byTitle[0]!.path };
      if (byTitle.length > 1) return { state: "ambiguous", candidates: byTitle.map((p) => p.path) };
      return { state: "unresolved" };
    },
  };
}

export async function loadLinkLookup(vault: Vault, path: string): Promise<LinkLookup> {
  const [outgoing, pages] = await Promise.all([vault.outgoingLinks(path).catch(() => []), vault.listPages()]);
  return buildLinkLookup(path, outgoing, pages);
}
