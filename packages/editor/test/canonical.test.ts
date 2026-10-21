import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markdownToDoc, thothSchema } from "../src/index.ts";
import { FIXTURES, GOLDEN, canonical, markdownFiles, read, semantic, typesIn } from "./helpers.ts";

const names = readdirSync(GOLDEN)
  .filter((f) => f.endsWith(".in.md"))
  .map((f) => f.replace(".in.md", ""));

describe("canonical goldens", () => {
  it("has a golden for every input", () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) expect(readdirSync(GOLDEN)).toContain(`${name}.out.md`);
  });

  describe.each(names)("%s", (name) => {
    const input = read(`${GOLDEN}${name}.in.md`);
    const expected = read(`${GOLDEN}${name}.out.md`);

    it("serializes to the expected canonical form", () => {
      expect(canonical(input)).toBe(expected);
    });

    it("is idempotent", () => {
      expect(canonical(expected)).toBe(expected);
    });

    it("reparses to an equivalent document", () => {
      expect(semantic(expected)).toEqual(semantic(input));
    });

    it("keeps the canonical form with CRLF line endings", () => {
      const crlf = input.replace(/\r?\n/g, "\r\n");
      expect(canonical(crlf)).toBe(expected.replace(/\r?\n/g, "\r\n"));
    });

    it("produces documents that satisfy the schema", () => {
      const schema = thothSchema();
      expect(() => schema.nodeFromJSON(markdownToDoc(input).doc).check()).not.toThrow();
    });
  });

  it("covers every node and mark type of the schema", () => {
    const seen = new Set<string>();
    for (const name of names) typesIn(markdownToDoc(read(`${GOLDEN}${name}.in.md`)).doc, seen);
    const schema = thothSchema();
    const all = [...Object.keys(schema.nodes), ...Object.keys(schema.marks)];
    expect(all.filter((t) => !seen.has(t))).toEqual([]);
  });

  it.each(markdownFiles(FIXTURES))("canonicalizes fixture %s idempotently and equivalently", (file) => {
    const source = read(file);
    const once = canonical(source);
    expect(canonical(once)).toBe(once);
    expect(semantic(once)).toEqual(semantic(source));
  });
});
