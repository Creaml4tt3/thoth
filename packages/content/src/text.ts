/**
 * Lossless text decoding for Markdown files (ADR-001).
 *
 * The UTF-8 BOM is kept as a leading U+FEFF in the decoded string (frontmatter
 * handling already preserves it), so `encodeText(decodeText(b).text)` returns
 * the original bytes for any valid UTF-8 input. Non-UTF-8 files are flagged and
 * must never be rewritten by Thoth: decoding them would replace bytes.
 */
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenient = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const encoder = new TextEncoder();

export interface DecodedText {
  text: string;
  /** False when the bytes are not valid UTF-8; `text` is then display-only. */
  editable: boolean;
}

export function decodeText(bytes: Uint8Array): DecodedText {
  try {
    return { text: strict.decode(bytes), editable: true };
  } catch {
    return { text: lenient.decode(bytes), editable: false };
  }
}

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

export class NotEditableError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`"${path}" is not valid UTF-8 and cannot be edited without changing its bytes`);
    this.name = "NotEditableError";
    this.path = path;
  }
}
