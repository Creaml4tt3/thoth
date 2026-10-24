/** How a callout kind looks, shared by the Blocks callout view and Plain mode's live preview. */
const CALLOUT_ICONS: Record<string, string> = {
  note: "i", info: "i", todo: "☐", tip: "✦", hint: "✦", important: "!", success: "✓", check: "✓", done: "✓",
  question: "?", help: "?", faq: "?", warning: "!", caution: "!", attention: "!", failure: "×", fail: "×", missing: "×",
  danger: "!", error: "!", bug: "•", example: "§", quote: "“", cite: "“", abstract: "≡", summary: "≡", tldr: "≡",
  toggle: "▸",
};

/** The `data-callout` value CSS styles by: lowercase, letters, digits and `-`. */
export const kindClass = (kind: string): string => kind.toLowerCase().replace(/[^a-z0-9-]/g, "");

/** The kind as a label (`WARNING` → `Warning`). */
export const kindLabel = (kind: string): string => kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();

export const kindIcon = (kind: string): string => CALLOUT_ICONS[kindClass(kind)] ?? "i";
