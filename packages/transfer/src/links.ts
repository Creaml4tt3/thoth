/**
 * Reference classification and link mapping (spec §9.3, ADR-0006 §5).
 *
 * In the Private Space a link names a path (`[[Overview]]`, `[x](a/b.md)`).
 * In a workspace pages and attachments have only IDs, so links that travel
 * name them by ID: `thoth:page/<id>` and `thoth:attachment/<id>`. Every
 * reference of every selected page is classified before anything is
 * rewritten, and only references whose target is known through the ID
 * mapping are rewritten:
 *
 * - `included`: the target travels in this transfer.
 * - `already_at_destination`: the target is at the destination already (a
 *   `.thoth/sync/` mapping says so).
 * - `left_at_source`: the target exists but stays behind; the link keeps
 *   its target as written.
 * - `external`: a URL.
 * - `unresolved`: missing or ambiguous; kept exactly as written and flagged.
 *
 * Nothing is ever retargeted by title. When a link comes back to the Private
 * Space, the shortest spelling of its path is used only if the vault's own
 * resolver provably resolves that spelling to the same file.
 */
import { LinkResolver, parsePage, type ParsedReference } from "@thoth/content";
import { basename, isMarkdownPath, relativeLink, stripExtension } from "@thoth/domain";
import type { LinkSummary, ReferenceClass } from "./record.ts";

export const PAGE_LINK_PREFIX = "thoth:page/";
export const ATTACHMENT_LINK_PREFIX = "thoth:attachment/";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `{ kind, id }` for a `thoth:page/<id>` or `thoth:attachment/<id>` target, else undefined. */
export function parseThothLink(target: string): { kind: "page" | "attachment"; id: string } | undefined {
  for (const [prefix, kind] of [
    [PAGE_LINK_PREFIX, "page"],
    [ATTACHMENT_LINK_PREFIX, "attachment"],
  ] as const) {
    if (target.startsWith(prefix) && UUID_V7.test(target.slice(prefix.length))) return { kind, id: target.slice(prefix.length) };
  }
  return undefined;
}

export interface ClassifiedReference {
  sourcePath: string;
  reference: ParsedReference;
  class: ReferenceClass;
  /** The new target (no fragment) when the link is rewritten through the mapping. */
  newTarget?: string;
}

export function emptySummary(): LinkSummary {
  return { counts: { included: 0, already_at_destination: 0, left_at_source: 0, external: 0, unresolved: 0 }, rewritten: 0, flagged: [] };
}

export function summarize(classified: readonly ClassifiedReference[]): LinkSummary {
  const summary = emptySummary();
  for (const c of classified) {
    summary.counts[c.class] = (summary.counts[c.class] ?? 0) + 1;
    if (c.newTarget !== undefined) summary.rewritten++;
    if (c.class === "unresolved" || c.class === "left_at_source") summary.flagged.push({ sourcePath: c.sourcePath, target: c.reference.target, line: c.reference.range.startLine, class: c.class });
  }
  return summary;
}

/**
 * Splices new targets into `source`. A wikilink or embed without a label gets its original text as the label,
 * so `[[Overview]]` reads the same as `[[thoth:page/<id>|Overview]]`. Everything else stays byte-for-byte.
 */
export function applyRewrites(source: string, classified: readonly ClassifiedReference[], options: { labelBareWikilinks: boolean }): string {
  const edits = classified
    .filter((c) => c.newTarget !== undefined)
    .map((c) => {
      const ref = c.reference;
      const target = c.newTarget!;
      const isWiki = ref.syntax === "wikilink" || ref.syntax === "embed";
      if (isWiki) {
        if (/[[\]|#\n]/.test(target)) throw new Error(`Target cannot be written as a wikilink: ${target}`);
        if (options.labelBareWikilinks && ref.label === undefined) {
          // Insert `|<as written>` before the closing `]]`.
          const close = ref.range.end - 2;
          return [
            { start: ref.targetRange.start, end: ref.targetRange.end, text: target },
            { start: close, end: close, text: `|${ref.rawTarget}` },
          ];
        }
        return [{ start: ref.targetRange.start, end: ref.targetRange.end, text: target }];
      }
      const angled = source[ref.targetRange.start - 1] === "<";
      const text = angled ? target.replace(/[<>\n]/g, (ch) => encodeURIComponent(ch)) : target.replace(/[%\s()<>#?]/g, (ch) => encodeURIComponent(ch));
      return [{ start: ref.targetRange.start, end: ref.targetRange.end, text }];
    })
    .flat()
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const e of edits) {
    if (e.end > lastStart) throw new Error("Overlapping link edits");
    lastStart = e.start;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

// --------------------------------------------------------- Private → Workspace

export interface OutboundContext {
  /** Every vault file (pages and attachments) and page aliases, for the vault's own link resolution. */
  files: readonly string[];
  pages: readonly { path: string; aliases: readonly string[]; thothId: string | null }[];
  /** Selected page path → destination page ID. */
  includedPages: ReadonlyMap<string, string>;
  /** Included attachment path → destination attachment ID (null until uploaded: classified, not yet rewritable). */
  includedAttachments: ReadonlyMap<string, string | null>;
  /** Local page `thoth_id` → remote page ID, and attachment path → remote attachment ID, from `.thoth/sync/`. */
  mappedPages: ReadonlyMap<string, string>;
  mappedAttachments: ReadonlyMap<string, string>;
}

export function outboundResolver(ctx: Pick<OutboundContext, "files" | "pages">): LinkResolver {
  return new LinkResolver(ctx.files, ctx.pages);
}

/** Classifies (and, where the mapping knows the destination ID, rewrites) every reference of one selected page. */
export function classifyOutbound(path: string, source: string, ctx: OutboundContext, resolver: LinkResolver): ClassifiedReference[] {
  const doc = parsePage(path, source);
  const thothIdOf = new Map(ctx.pages.map((p) => [p.path, p.thothId]));
  return doc.references.map((reference): ClassifiedReference => {
    const base = { sourcePath: path, reference };
    if (reference.external) return { ...base, class: "external" };
    if (reference.target === "") return { ...base, class: "included" }; // same-page fragment
    const resolved = resolver.resolve(path, reference);
    if (resolved.state !== "resolved") return { ...base, class: "unresolved" };
    const target = resolved.path;
    if (isMarkdownPath(target)) {
      const dest = ctx.includedPages.get(target);
      if (dest !== undefined) return { ...base, class: "included", newTarget: `${PAGE_LINK_PREFIX}${dest}` };
      const thothId = thothIdOf.get(target);
      const remote = thothId ? ctx.mappedPages.get(thothId) : undefined;
      if (remote !== undefined) return { ...base, class: "already_at_destination", newTarget: `${PAGE_LINK_PREFIX}${remote}` };
      return { ...base, class: "left_at_source" };
    }
    if (ctx.includedAttachments.has(target)) {
      const dest = ctx.includedAttachments.get(target);
      return dest ? { ...base, class: "included", newTarget: `${ATTACHMENT_LINK_PREFIX}${dest}` } : { ...base, class: "included" };
    }
    const remote = ctx.mappedAttachments.get(target);
    if (remote !== undefined) return { ...base, class: "already_at_destination", newTarget: `${ATTACHMENT_LINK_PREFIX}${remote}` };
    return { ...base, class: "left_at_source" };
  });
}

/** Attachments (non-Markdown vault files) that the given pages link to and that resolve uniquely. */
export function referencedAttachments(pages: readonly { path: string; source: string }[], resolver: LinkResolver): string[] {
  const found = new Set<string>();
  for (const page of pages) {
    for (const ref of parsePage(page.path, page.source).references) {
      if (ref.external || ref.target === "") continue;
      const resolved = resolver.resolve(page.path, ref);
      if (resolved.state === "resolved" && !isMarkdownPath(resolved.path)) found.add(resolved.path);
    }
  }
  return [...found].sort();
}

// --------------------------------------------------------- Workspace → Private

export interface InboundContext {
  /** Remote page ID → vault path it is written to in this transfer. */
  includedPages: ReadonlyMap<string, string>;
  /** Remote page ID → existing vault path (from `.thoth/sync/`, file still present). */
  knownPages: ReadonlyMap<string, string>;
  /** Remote attachment ID → existing vault path whose bytes still match the mapping. */
  knownAttachments: ReadonlyMap<string, string>;
}

export function classifyInbound(destPath: string, markdown: string, ctx: InboundContext, resolver?: LinkResolver): ClassifiedReference[] {
  const doc = parsePage(destPath, markdown);
  return doc.references.map((reference): ClassifiedReference => {
    const base = { sourcePath: destPath, reference };
    const link = parseThothLink(reference.target);
    if (!link) {
      if (reference.external || reference.target === "") return { ...base, class: reference.external ? "external" : "included" };
      // A path or title link written in the workspace: there is no path to resolve it against. Kept and flagged.
      return { ...base, class: "unresolved" };
    }
    const path =
      link.kind === "page" ? (ctx.includedPages.get(link.id) ?? ctx.knownPages.get(link.id)) : ctx.knownAttachments.get(link.id);
    if (path === undefined) return { ...base, class: "left_at_source" };
    const cls: ReferenceClass = link.kind === "page" && ctx.includedPages.has(link.id) ? "included" : "already_at_destination";
    return { ...base, class: cls, newTarget: localSpelling(destPath, reference, path, resolver) };
  });
}

/**
 * How a link from `from` to `to` is written in the vault. Markdown links get a relative path. Wikilinks get the
 * shortest path suffix (`Plan`, then `Projects/Plan`, …) that the vault's own resolver maps to exactly `to`;
 * the full vault path is the fallback, and it always resolves exactly. No spelling is chosen by title.
 */
function localSpelling(from: string, ref: ParsedReference, to: string, resolver: LinkResolver | undefined): string {
  if (ref.syntax !== "wikilink" && ref.syntax !== "embed") return relativeLink(from, to);
  const full = isMarkdownPath(to) ? stripExtension(to) : to;
  if (!resolver) return full;
  const parts = full.split("/");
  for (let n = 1; n < parts.length; n++) {
    const candidate = parts.slice(-n).join("/");
    const hit = resolver.resolve(from, { syntax: ref.syntax, target: candidate, external: false });
    if (hit.state === "resolved" && hit.path === to) return candidate;
  }
  return full;
}

/**
 * Wikilinks whose label is the bare spelling `[[label]]` would have, and whose bare spelling resolves to the
 * same file, are written back as `[[label]]` (this undoes the label the outbound rewrite added).
 */
export function compactInbound(markdown: string, destPath: string, resolver: LinkResolver): string {
  const doc = parsePage(destPath, markdown);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const ref of doc.references) {
    if ((ref.syntax !== "wikilink" && ref.syntax !== "embed") || ref.label === undefined || ref.external || ref.target === "") continue;
    const exact = resolver.resolve(destPath, ref);
    if (exact.state !== "resolved") continue;
    const fragment = ref.fragment === undefined ? "" : `#${ref.fragment}`;
    const hash = ref.label.indexOf("#");
    const bare = hash === -1 ? ref.label : ref.label.slice(0, hash);
    const labelFragment = hash === -1 ? "" : ref.label.slice(hash);
    if (labelFragment !== fragment || bare.trim() === "" || /[[\]|\n]/.test(ref.label)) continue;
    const viaLabel = resolver.resolve(destPath, { syntax: ref.syntax, target: bare.trim(), external: false });
    if (viaLabel.state !== "resolved" || viaLabel.path !== exact.path) continue;
    // Replace everything between the brackets with the label.
    const open = ref.range.start + (ref.syntax === "embed" ? 3 : 2);
    edits.push({ start: open, end: ref.range.end - 2, text: ref.label });
  }
  let out = markdown;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** The default file name for a page title: unsafe characters replaced, at most 120 characters, never empty. */
export function fileNameForTitle(title: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.\-]+|[\s.\-]+$/g, "");
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(cleaned)].map((s) => s.segment);
  const short = graphemes.slice(0, 120).join("").trimEnd();
  const name = short === "" || short.toLowerCase() === ".thoth" ? "Untitled" : short;
  return `${name}.md`;
}

export const titleOfPath = (path: string): string => stripExtension(basename(path));
