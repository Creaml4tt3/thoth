import { z } from "zod";

/**
 * Canonical content model, schemaVersion 1 (ADR-002).
 *
 * The persisted canonical form is the Markdown source. `PageDocument` is the
 * derived, validated in-memory view: frontmatter + body + blocks + references.
 * Anything Thoth does not understand becomes a `raw` block that keeps its exact
 * source text; nothing is dropped.
 */
export const CONTENT_SCHEMA_VERSION = 1 as const;

export const SourceRangeSchema = z.object({
  /** UTF-16 offsets into the full file source (including frontmatter). */
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  /** 1-based line numbers. */
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});
export type SourceRange = z.infer<typeof SourceRangeSchema>;

export const BlockTypeSchema = z.enum([
  "paragraph",
  "heading",
  "list",
  "taskList",
  "blockquote",
  "callout",
  "code",
  "table",
  "thematicBreak",
  "image",
  "embed",
  "html",
  "math",
  "raw",
]);
export type BlockType = z.infer<typeof BlockTypeSchema>;

export const BlockSchema = z.object({
  type: BlockTypeSchema,
  range: SourceRangeSchema,
  /** Explicit Obsidian-style block anchor (`^id`) when present; blocks have no implicit persisted IDs. */
  anchor: z.string().optional(),
  /** heading */
  level: z.number().int().min(1).max(6).optional(),
  text: z.string().optional(),
  /** list / taskList */
  ordered: z.boolean().optional(),
  tasks: z.array(z.object({ checked: z.boolean(), text: z.string() })).optional(),
  /** callout */
  calloutKind: z.string().optional(),
  /** code */
  lang: z.string().optional(),
});
export type Block = z.infer<typeof BlockSchema>;

export const LinkSyntaxSchema = z.enum(["markdown-link", "markdown-image", "definition", "wikilink", "embed"]);
export type LinkSyntax = z.infer<typeof LinkSyntaxSchema>;

export const ParsedReferenceSchema = z.object({
  syntax: LinkSyntaxSchema,
  /** Decoded target path or URL, without fragment. Empty for same-page fragment links. */
  target: z.string(),
  /** Heading (`Heading`) or block (`^id`) fragment, decoded. */
  fragment: z.string().optional(),
  /** Display text / alias where the syntax carries one. */
  label: z.string().optional(),
  /** True for http(s), mailto, and other scheme-qualified URLs. */
  external: z.boolean(),
  /** Range of the whole construct. */
  range: SourceRangeSchema,
  /** Range of just the target text as written, for in-place rewriting. */
  targetRange: SourceRangeSchema,
  /** The target exactly as written in source (still encoded). */
  rawTarget: z.string(),
});
export type ParsedReference = z.infer<typeof ParsedReferenceSchema>;

export const PageDocumentSchema = z.object({
  schemaVersion: z.literal(CONTENT_SCHEMA_VERSION),
  path: z.string(),
  title: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  frontmatterError: z.string().optional(),
  /** Offset where the Markdown body starts (after frontmatter). */
  bodyOffset: z.number().int().nonnegative(),
  blocks: z.array(BlockSchema),
  references: z.array(ParsedReferenceSchema),
  headings: z.array(z.object({ level: z.number().int(), text: z.string() })),
  blockAnchors: z.array(z.string()),
  tags: z.array(z.string()),
  aliases: z.array(z.string()),
  /** `thoth_id` from frontmatter when it is a valid stable ID. */
  thothId: z.string().optional(),
  /** Plain text for full-text search. */
  plainText: z.string(),
});
export type PageDocument = z.infer<typeof PageDocumentSchema>;
