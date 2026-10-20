import type { ParsedReference } from "./schema.ts";

export interface TargetEdit {
  reference: ParsedReference;
  /** New decoded target path (no fragment). Encoding is applied per syntax. */
  newTarget: string;
}

/** Percent-encodes only characters that would break a Markdown link destination. */
export function encodeLinkDestination(path: string): string {
  return path.replace(/[%\s()<>#?]/g, (c) => encodeURIComponent(c));
}

/**
 * Rewrites link targets by splicing their exact source ranges (ADR-002).
 * Everything outside the edited target ranges stays byte-for-byte identical,
 * including fragments, aliases, titles, and surrounding formatting.
 */
export function rewriteTargets(source: string, edits: TargetEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.reference.targetRange.start - a.reference.targetRange.start);
  let out = source;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const { reference, newTarget } of sorted) {
    const { start, end } = reference.targetRange;
    if (end > lastStart) throw new Error("Overlapping link edits");
    lastStart = start;
    let replacement: string;
    if (reference.syntax === "wikilink" || reference.syntax === "embed") {
      if (/[[\]|#\n]/.test(newTarget)) throw new Error(`Target cannot be written as a wikilink: ${newTarget}`);
      replacement = newTarget;
    } else {
      const angled = source[start - 1] === "<";
      replacement = angled ? newTarget.replace(/[<>\n]/g, (c) => encodeURIComponent(c)) : encodeLinkDestination(newTarget);
    }
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}
