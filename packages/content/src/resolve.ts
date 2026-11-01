import { basename, collisionKey, dirname, extname, isMarkdownPath, resolveRelative, stripExtension } from "@thoth/domain";
import type { ParsedReference } from "./schema.ts";

export interface ResolvablePage {
  path: string;
  aliases: readonly string[];
}

export type Resolution =
  | { state: "resolved"; path: string }
  | { state: "unresolved" }
  | { state: "ambiguous"; candidates: string[] }
  | { state: "external" };

/**
 * Deterministic link resolution over a complete set of vault paths (ADR-010).
 *
 * Wikilinks: exact vault path (with or without `.md`), then path relative to the
 * linking file, then unique basename, then unique alias. Markdown links: path
 * relative to the linking file, then vault-root path. Multiple candidates are
 * reported as ambiguous and never guessed; matching is case-insensitive only
 * when the case-insensitive match is unique.
 *
 * A wikilink whose target ends in `/` names a folder (ADR-0043): `[[Projects/2026/]]`. It resolves to the folder's
 * path with a trailing `/`, by exact path, then relative to the linking file, then a unique path suffix. Folders are
 * the given ones plus every folder that holds a file.
 */
export class LinkResolver {
  private readonly exact = new Map<string, string>();
  private readonly folded = new Map<string, string[]>();
  private readonly byBasename = new Map<string, string[]>();
  private readonly byAlias = new Map<string, string[]>();
  private readonly folders = new Map<string, string>();

  constructor(files: readonly string[], pages: readonly ResolvablePage[] = [], folders: readonly string[] = []) {
    for (const path of files) this.addFile(path);
    for (const page of pages) {
      if (!this.exact.has(page.path)) this.addFile(page.path);
      for (const alias of page.aliases) push(this.byAlias, collisionKey(alias), page.path);
    }
    for (const folder of folders) this.folders.set(folder, folder);
    for (const path of this.exact.keys()) for (let d = dirname(path); d !== ""; d = dirname(d)) this.folders.set(d, d);
  }

  private addFile(path: string): void {
    this.exact.set(path, path);
    push(this.folded, collisionKey(path), path);
    const base = basename(path);
    push(this.byBasename, collisionKey(base), path);
    if (isMarkdownPath(path)) push(this.byBasename, collisionKey(stripExtension(base)), path);
  }

  resolve(fromPath: string, ref: Pick<ParsedReference, "syntax" | "target" | "external">): Resolution {
    if (ref.external) return { state: "external" };
    if (ref.target === "") return { state: "resolved", path: fromPath }; // same-page fragment
    return ref.syntax === "wikilink" || ref.syntax === "embed"
      ? this.resolveWikilink(fromPath, ref.target)
      : this.resolveMarkdown(fromPath, ref.target);
  }

  private lookup(path: string | undefined): Resolution | undefined {
    if (path === undefined) return undefined;
    const normalized = path.normalize("NFC");
    const hit = this.exact.get(normalized);
    if (hit) return { state: "resolved", path: hit };
    const folded = this.folded.get(collisionKey(normalized));
    if (folded?.length === 1) return { state: "resolved", path: folded[0]! };
    if (folded && folded.length > 1) return { state: "ambiguous", candidates: [...folded].sort() };
    return undefined;
  }

  private lookupPage(path: string | undefined): Resolution | undefined {
    if (path === undefined) return undefined;
    return this.lookup(path) ?? (extname(path) === "" ? this.lookup(`${path}.md`) : undefined);
  }

  private resolveFolder(fromPath: string, target: string): Resolution {
    const clean = target.replace(/^\/+|\/+$/g, "").normalize("NFC");
    if (clean === "") return { state: "unresolved" };
    const exact = this.folders.get(clean) ?? this.folders.get(resolveRelative(fromPath, clean) ?? "");
    if (exact) return { state: "resolved", path: `${exact}/` };
    const key = collisionKey(clean);
    const matches = [...this.folders.keys()].filter((f) => {
      const k = collisionKey(f);
      return k === key || k.endsWith(`/${key}`);
    });
    if (matches.length === 1) return { state: "resolved", path: `${matches[0]!}/` };
    if (matches.length > 1) return { state: "ambiguous", candidates: matches.map((m) => `${m}/`).sort() };
    return { state: "unresolved" };
  }

  private resolveWikilink(fromPath: string, target: string): Resolution {
    if (target.endsWith("/")) return this.resolveFolder(fromPath, target);
    const clean = target.replace(/^\/+/, "");
    const direct = this.lookupPage(clean) ?? this.lookupPage(resolveRelative(fromPath, clean));
    if (direct) return direct;
    if (!clean.includes("/")) {
      const key = collisionKey(clean);
      const candidates = this.byBasename.get(key) ?? [];
      const unique = [...new Set(candidates)];
      if (unique.length === 1) return { state: "resolved", path: unique[0]! };
      if (unique.length > 1) return { state: "ambiguous", candidates: unique.sort() };
    } else {
      // Obsidian allows the shortest unambiguous path suffix, e.g. [[Thoth/Overview]].
      const suffix = collisionKey(clean);
      const matches = [...this.exact.keys()].filter((p) => {
        const k = collisionKey(p);
        return k.endsWith(`/${suffix}`) || k.endsWith(`/${suffix}.md`);
      });
      if (matches.length === 1) return { state: "resolved", path: matches[0]! };
      if (matches.length > 1) return { state: "ambiguous", candidates: matches.sort() };
    }
    const aliased = [...new Set(this.byAlias.get(collisionKey(clean)) ?? [])];
    if (aliased.length === 1) return { state: "resolved", path: aliased[0]! };
    if (aliased.length > 1) return { state: "ambiguous", candidates: aliased.sort() };
    return { state: "unresolved" };
  }

  private resolveMarkdown(fromPath: string, target: string): Resolution {
    if (target.startsWith("/")) return this.lookup(target.replace(/^\/+/, "")) ?? { state: "unresolved" };
    return this.lookup(resolveRelative(fromPath, target)) ?? this.lookup(target) ?? { state: "unresolved" };
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}
