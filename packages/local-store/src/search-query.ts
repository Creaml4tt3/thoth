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

/** A LIKE pattern (with `ESCAPE '\'`) that matches `term` anywhere, taking `%`, `_` and `\` literally. */
export function likeAnywhere(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Brackets each term in `text` the way FTS5 `snippet()` does, so every search path reads the same. */
export function markTerms(text: string, tokens: string[]): string {
  const any = new RegExp([...tokens].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return text.replace(any, "[$&]");
}
