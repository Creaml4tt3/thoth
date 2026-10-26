/**
 * The block types offered by the `/` menu and by "Turn into" in the block
 * menu: one catalog, one filter.
 */
export type BlockKind = "text" | "h1" | "h2" | "h3" | "bullet" | "numbered" | "todo" | "toggle" | "callout" | "quote" | "code" | "divider";

export interface BlockKindInfo {
  kind: BlockKind;
  title: string;
  description: string;
  /** Extra words that find the item (lowercase). */
  aliases: string[];
  /** A short decorative glyph. */
  icon: string;
  /** Markdown shortcut typed at the start of an empty line, shown as a hint. */
  hint?: string;
}

export const BLOCK_KINDS: readonly BlockKindInfo[] = [
  { kind: "text", title: "Text", description: "Plain paragraph", aliases: ["paragraph", "p", "plain"], icon: "T" },
  { kind: "h1", title: "Heading 1", description: "Big section heading", aliases: ["h1", "heading", "title", "#"], icon: "H1", hint: "#" },
  { kind: "h2", title: "Heading 2", description: "Medium section heading", aliases: ["h2", "heading", "subtitle", "##"], icon: "H2", hint: "##" },
  { kind: "h3", title: "Heading 3", description: "Small section heading", aliases: ["h3", "heading", "###"], icon: "H3", hint: "###" },
  { kind: "bullet", title: "Bulleted list", description: "A simple list with bullets", aliases: ["bullet", "ul", "list", "unordered", "-"], icon: "•", hint: "-" },
  { kind: "numbered", title: "Numbered list", description: "A list with numbering", aliases: ["number", "ol", "list", "ordered", "1."], icon: "1.", hint: "1." },
  { kind: "todo", title: "To-do list", description: "Track tasks with checkboxes", aliases: ["todo", "to-do", "task", "check", "checkbox", "checklist", "[]"], icon: "☐", hint: "[]" },
  { kind: "toggle", title: "Toggle", description: "A block you can fold open and closed", aliases: ["fold", "collapse", "collapsible", "details", "expand", ">>"], icon: "▸", hint: ">>" },
  { kind: "callout", title: "Callout", description: "Make writing stand out", aliases: ["note", "info", "tip", "admonition", "alert"], icon: "i" },
  { kind: "quote", title: "Quote", description: "Capture a quote", aliases: ["blockquote", "cite", "citation", ">"], icon: "❝", hint: ">" },
  { kind: "code", title: "Code", description: "A block of code", aliases: ["snippet", "pre", "```"], icon: "</>", hint: "```" },
  { kind: "divider", title: "Divider", description: "Visually divide blocks", aliases: ["hr", "line", "rule", "separator", "---"], icon: "—", hint: "---" },
];

export const kindInfo = (kind: BlockKind): BlockKindInfo => BLOCK_KINDS.find((k) => k.kind === kind)!;

/** Lower is better; null means no match. */
function rank(info: Pick<BlockKindInfo, "title" | "aliases" | "description">, query: string): number | null {
  const title = info.title.toLowerCase();
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (info.aliases.some((a) => a === query)) return 2;
  if (info.aliases.some((a) => a.startsWith(query))) return 3;
  if (title.split(" ").some((w) => w.startsWith(query))) return 4;
  if (title.includes(query)) return 5;
  if (info.description.toLowerCase().includes(query)) return 6;
  return null;
}

/**
 * The catalog in another language. Titles and descriptions are translated; the English title joins the aliases,
 * so `/heading` keeps working whatever the UI language is.
 */
export function localizedBlockKinds(text: Record<BlockKind, { title: string; description: string }>): readonly BlockKindInfo[] {
  return BLOCK_KINDS.map((k) => {
    const t = text[k.kind];
    if (t.title === k.title) return k;
    return { ...k, title: t.title, description: t.description, aliases: [...k.aliases, k.title.toLowerCase()] };
  });
}

/** Items matching `query` (title, aliases, description), best first, catalog order within a rank. */
export function filterBlockKinds<T extends Pick<BlockKindInfo, "title" | "aliases" | "description"> = BlockKindInfo>(query: string, kinds: readonly T[] = BLOCK_KINDS as unknown as readonly T[]): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...kinds];
  return kinds.map((info, i) => ({ info, i, r: rank(info, q) }))
    .filter((x): x is { info: T; i: number; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.info);
}
