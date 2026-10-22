/**
 * Plain mode edits the file's text, not a model of it (ADR-0012).
 *
 * CodeMirror splits a document into lines and joins them with one separator.
 * The separator is chosen per file and every other line-break character stays
 * inside its line as an ordinary character, so `bom + state.sliceDoc()`
 * reproduces the source exactly. A leading BOM is kept aside so it is not
 * shown as a stray character.
 */
import type { EditorState } from "@codemirror/state";

export interface EditorText {
  /** The source without its BOM. */
  text: string;
  bom: string;
  lineBreak: "\n" | "\r\n";
}

export function toEditorText(source: string): EditorText {
  const bom = source.startsWith("﻿") ? "﻿" : "";
  const text = source.slice(bom.length);
  // CRLF only when every LF belongs to a CRLF: a lone LF inside a CRLF line would otherwise be a line break CodeMirror cannot hold.
  const lineBreak = text.includes("\r\n") && !/(^|[^\r])\n/.test(text) ? "\r\n" : "\n";
  return { text, bom, lineBreak };
}

/** Pasted or dropped text takes the document's line ending, so a paste never mixes CRLF into an LF file (or the reverse). */
export const normalizeLineBreaks = (text: string, state: EditorState): string => text.replace(/\r\n?|\n/g, state.lineBreak);
