/**
 * Builds safe FTS5 MATCH expressions from free text. User input is never
 * passed through as FTS syntax: every token becomes a quoted phrase.
 */
export function tokenize(query: string): string[] {
  return query
    .normalize("NFC")
    .split(/\s+/)
    // Quotes and control characters (incl. NUL) cannot appear inside an FTS5 string.
    .map((t) => t.replace(/["\u0000-\u001f\u007f]/g, ""))
    .filter((t) => t.length > 0);
}

export function wordMatch(tokens: string[]): string | undefined {
  if (tokens.length === 0) return undefined;
  return tokens.map((t) => `"${t}"*`).join(" AND ");
}

/** Trigram tokenizer needs at least three characters per term. */
export function trigramMatch(tokens: string[]): string | undefined {
  if (tokens.length === 0 || tokens.some((t) => [...t].length < 3)) return undefined;
  return tokens.map((t) => `"${t}"`).join(" AND ");
}
