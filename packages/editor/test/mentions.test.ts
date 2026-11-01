import { describe, expect, it } from "vitest";
import { docToMarkdown, mentionText } from "../src/index.ts";
import { canonical, roundTrip, semantic } from "./helpers.ts";

/** ADR-0043: folder links `[[Folder/]]` and person mentions `[@Name](thoth:user/<id>)`. */
describe("folder links and person mentions", () => {
  const inline = (source: string) => semantic(source)[0]?.content ?? [];

  it("parses a folder link as a wikilink whose target keeps its slash", () => {
    expect(inline("See [[Projects/2026/]] now\n")[1]).toMatchObject({ type: "wikilink", attrs: { target: "Projects/2026/", fragment: null, label: null } });
  });

  it("parses a mention to an atom with the ID and the name, and writes it back the same", () => {
    const source = "Ask [@Somchai Jaidee](thoth:user/u_42) now\n";
    expect(inline(source)[1]).toEqual({ type: "mention", attrs: { id: "u_42", label: "Somchai Jaidee" } });
    expect(roundTrip(source)).toBe(source);
    expect(canonical(source)).toBe(source);
  });

  it("escapes brackets in a name so the link survives, and reads them back", () => {
    const text = mentionText("ada", "Ada [QA] *x*");
    expect(text).toBe("[@Ada \\[QA\\] \\*x\\*](thoth:user/ada)");
    expect(inline(`${text}\n`)[0]).toEqual({ type: "mention", attrs: { id: "ada", label: "Ada [QA] *x*" } });
  });

  it("leaves other links alone: no @, another scheme, a title, a bad ID", () => {
    for (const source of ["[Ada](thoth:user/u_1)\n", "[@Ada](https://x.test)\n", '[@Ada](thoth:user/u_1 "t")\n', "[@Ada](thoth:user/a%20b)\n", "[@ ](thoth:user/u_1)\n"]) {
      expect(inline(source).some((n) => n.type === "mention"), source).toBe(false);
      expect(roundTrip(source)).toBe(source);
    }
  });

  it("serializes a new mention and a new folder link built in the editor", () => {
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "u_9", label: "สมชาย" } }, { type: "text", text: " and " }, { type: "wikilink", attrs: { target: "Archive/", fragment: null, label: null } }] }],
    };
    expect(docToMarkdown(doc)).toBe("[@สมชาย](thoth:user/u_9) and [[Archive/]]\n");
  });

  it("keeps a mention in a table cell", () => {
    const source = "| who |\n| --- |\n| [@Ada](thoth:user/ada) |\n";
    expect(roundTrip(source)).toBe(source);
    expect(canonical(source)).toBe(source);
  });
});
