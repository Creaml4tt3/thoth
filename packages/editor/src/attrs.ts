import type { JSONContent } from "@tiptap/core";
import { z } from "zod";

/**
 * Node, mark and source attribute schemas (ADR-0002 section 7).
 *
 * The serializer reads attributes from plain JSON, so every field has a `catch`:
 * a malformed attribute degrades to its default instead of throwing.
 */
const str = z.string().catch("");
const optStr = z.string().nullable().catch(null);

/** Source-tracking attributes carried by top-level blocks only. */
export const SourceAttrsSchema = z.object({
  /** Exact original Markdown of the block. */
  mdSrc: optStr,
  /** Exact text between the previous block (or body start) and this block. */
  mdSep: optStr,
  /** Canonical serialization at parse time; `null` means "same as mdSrc". */
  mdFp: optStr,
  /** Position among the original top-level blocks. */
  mdIx: z.number().int().nonnegative().nullable().catch(null),
});
export type SourceAttrs = z.infer<typeof SourceAttrsSchema>;
export const SOURCE_ATTR_NAMES = ["mdSrc", "mdSep", "mdFp", "mdIx"] as const;

/** Document-level attributes. */
export const DocAttrsSchema = z.object({
  /** Line ending used when canonical text is emitted. */
  eol: z.enum(["\n", "\r\n"]).catch("\n"),
  /** Exact text after the last block; `null` means "one trailing newline". */
  trailer: optStr,
});

export const HeadingAttrsSchema = z.object({ level: z.number().int().min(1).max(6).catch(1) });
export const ListAttrsSchema = z.object({
  ordered: z.boolean().catch(false),
  start: z.number().int().min(0).max(999_999_999).catch(1),
  tight: z.boolean().catch(true),
});
export const TaskItemAttrsSchema = z.object({ checked: z.boolean().catch(false) });
/** The title is the callout's first child (`calloutTitle`), not an attribute. */
export const CalloutAttrsSchema = z.object({
  kind: z.string().catch("note"),
  fold: z.enum(["", "+", "-"]).catch(""),
});
export const CodeAttrsSchema = z.object({ lang: optStr, meta: optStr });
export const TableAttrsSchema = z.object({
  align: z.array(z.enum(["left", "right", "center"]).nullable().catch(null)).catch([]),
});
export const ImageAttrsSchema = z.object({ src: str, alt: str, title: optStr });
export const WikiAttrsSchema = z.object({ target: str, fragment: optStr, label: optStr });
export const SourceOnlyAttrsSchema = z.object({ source: str });
export const LinkMarkAttrsSchema = z.object({ href: str, title: optStr });

/** The text colour palette (ADR-0016 rule 1). Each name has a light and a dark design token (`--thoth-text-NAME`). */
export const TEXT_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "red"] as const;
export type TextColor = (typeof TEXT_COLORS)[number];
export const isTextColor = (value: unknown): value is TextColor => (TEXT_COLORS as readonly unknown[]).includes(value);
/** A colour outside the palette reads as `null`, and the serializer then drops the mark (it never writes raw CSS). */
export const TextColorMarkAttrsSchema = z.object({ color: z.enum(TEXT_COLORS).nullable().catch(null) });

export function readAttrs<S extends z.ZodType>(schema: S, node: { attrs?: Record<string, unknown> | undefined }): z.infer<S> {
  return schema.parse(node.attrs ?? {});
}

export type Align = "left" | "right" | "center" | null;
export type Json = JSONContent;
