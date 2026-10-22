/**
 * Plain mode's core promise (ADR-0012): loading a file into CodeMirror and
 * reading it back gives the exact same string, and an edit changes only the
 * characters typed. Pure state tests, no DOM.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { decodeText } from "@thoth/content";
import { normalizeLineBreaks, toEditorText } from "../src/features/editor/plain/text.ts";
import { markdownSupport } from "../src/features/editor/plain/syntax.ts";
import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";

const FIXTURES = new URL("../../../tests/fixtures/", import.meta.url).pathname;
const GOLDEN = new URL("../../../packages/editor/test/golden/", import.meta.url).pathname;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return path.endsWith(".md") ? [path] : [];
  });
}

function load(source: string): { state: EditorState; read(state: EditorState): string } {
  const { text, bom, lineBreak } = toEditorText(source);
  const state = EditorState.create({ doc: text, extensions: [EditorState.lineSeparator.of(lineBreak), markdownSupport()] });
  return { state, read: (s) => bom + s.sliceDoc() };
}

const roundTrip = (source: string) => {
  const { state, read } = load(source);
  return read(state);
};

describe("Plain mode keeps the file's exact text", () => {
  const files = [...markdownFiles(FIXTURES), ...markdownFiles(GOLDEN)];

  it("finds the corpus", () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it.each(files)("%s", (file) => {
    const { text, editable } = decodeText(new Uint8Array(readFileSync(file)));
    if (editable) expect(roundTrip(text)).toBe(text);
  });

  const cases: Record<string, string> = {
    empty: "",
    "only newline": "\n",
    "no trailing newline": "# Title\n\ntext",
    crlf: "# Title\r\n\r\nText\r\n",
    "mixed line endings": "a\r\n\r\nb\n\nc\r\n",
    "lone CR": "a\rb\nc\r\n",
    "CR only": "a\rb\rc\r",
    bom: "﻿# Title\n\ntext\n",
    "bom + frontmatter crlf": "﻿---\r\ntitle: T\r\n---\r\n\r\n# Body\r\n",
    "line and paragraph separators": "a b c\n",
    "nul and controls": "a\u0000b\u0007c\n",
    thai: "# บันทึกการประชุม\n\nข้อความภาษาไทย [[หน้าอื่น|ชื่อ]]\n",
    emoji: "# 🚀 👩‍👩‍👧‍👦\n",
    "trailing spaces and tabs": "a  \n\tb\t\n",
  };
  it.each(Object.entries(cases))("%s", (_name, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it("an edit changes only the typed characters, in a mixed-ending file", () => {
    const source = "﻿---\r\na: 1\r\n---\r\nkeep  me\n\n* odd\r\nlast";
    const { state, read } = load(source);
    const at = state.doc.toString().indexOf("odd") + 3;
    const next = state.update({ changes: { from: at, insert: "!" } }).state;
    expect(read(next)).toBe(source.replace("odd", "odd!"));
  });

  it("a new line uses the file's own line ending", () => {
    const source = "# T\r\n\r\ntext\r\n";
    const { state, read } = load(source);
    const end = state.doc.length;
    const next = state.update({ changes: { from: end, insert: state.lineBreak + "more" } }).state;
    expect(read(next)).toBe("# T\r\n\r\ntext\r\n\r\nmore");
  });

  it("pasted text takes the document's line ending", () => {
    const crlf = load("a\r\nb\r\n").state;
    expect(normalizeLineBreaks("x\ny\rz\r\nw", crlf)).toBe("x\r\ny\r\nz\r\nw");
    const lf = load("a\nb\n").state;
    expect(normalizeLineBreaks("x\r\ny", lf)).toBe("x\ny");
  });

  it("parses wikilinks and frontmatter for highlighting", () => {
    const { state } = load("---\ntitle: T\n---\nSee [[Target|alias]] and ![[img.png]], not `[[code]]`.\n");
    ensureSyntaxTree(state, state.doc.length, 5000);
    const names: string[] = [];
    syntaxTree(state).iterate({ enter: (n) => void names.push(n.name) });
    expect(names.filter((n) => n === "Wikilink")).toHaveLength(2);
    expect(names).toContain("Frontmatter");
    expect(names).toContain("BlockMapping"); // the YAML inside is parsed as YAML
  });
});
