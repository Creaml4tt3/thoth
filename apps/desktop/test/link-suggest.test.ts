/**
 * `[[` suggestions: ranking, and the inserted target always resolving to the
 * chosen page (never ambiguous). Plain-mode trigger and completion text are
 * pure state functions, tested here without a DOM.
 */
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { LinkResolver } from "@thoth/content";
import type { PageSummary } from "@thoth/domain";
import { createLinkSuggester } from "../src/features/editor/link-suggest.ts";
import { completion, findTrigger } from "../src/features/editor/plain/link-suggest-plain.ts";
import { markdownSupport } from "../src/features/editor/plain/syntax.ts";

let mtime = 0;
const page = (path: string, title: string, aliases: string[] = []): PageSummary => ({
  id: `00000000-0000-4000-8000-${String(++mtime).padStart(12, "0")}`,
  path,
  title,
  contentHash: "",
  size: 0,
  mtimeMs: mtime,
  aliases,
  tags: [],
});

const PAGES = [
  page("Roadmap.md", "Roadmap"),
  page("Projects/Road trip.md", "Road trip"),
  page("Meetings/2026-10-22.md", "Weekly sync", ["standup"]),
  page("Work/Notes.md", "Work notes"),
  page("Home/Notes.md", "Home notes"),
  page("บันทึก/ประชุม.md", "ประชุมทีม"),
  page("Here.md", "Here"),
];

describe("link suggestions", () => {
  const suggest = (q: string) => createLinkSuggester("Here.md", PAGES).suggest(q);

  it("ranks exact, then prefix, then word starts, then substrings; never the open page", () => {
    // Both are title prefixes; the more recently changed page comes first.
    expect(suggest("road").map((s) => s.title)).toEqual(["Road trip", "Roadmap"]);
    expect(suggest("roadmap").map((s) => s.title)).toEqual(["Roadmap"]);
    // Equal matches (word start "notes" in both titles): most recently changed first.
    expect(suggest("notes").map((s) => s.title)).toEqual(["Home notes", "Work notes"]);
    // A word start ("sync" in "Weekly sync") beats a match inside a word ("ync").
    expect(createLinkSuggester("x.md", [page("A.md", "async jobs"), page("B.md", "Weekly sync")]).suggest("sync").map((s) => s.title)).toEqual(["Weekly sync", "async jobs"]);
    expect(suggest("trip").map((s) => s.title)).toEqual(["Road trip"]);
    expect(suggest("here")).toEqual([]);
    expect(suggest("").length).toBe(PAGES.length - 1);
  });

  it("matches aliases and says so", () => {
    const [hit] = suggest("stand");
    expect(hit).toMatchObject({ title: "Weekly sync", alias: "standup", folder: "Meetings" });
  });

  it("matches Thai titles and ignores the #heading and |label parts of the query", () => {
    expect(suggest("ประชุม")[0]?.path).toBe("บันทึก/ประชุม.md");
    expect(suggest("roadmap#Goals|see")[0]?.title).toBe("Roadmap");
  });

  it("inserts the bare name when unique and the full path when not; every target resolves to the chosen page", () => {
    const resolver = new LinkResolver(PAGES.map((p) => p.path), PAGES.map((p) => ({ path: p.path, aliases: p.aliases })));
    const all = suggest("");
    expect(all.find((s) => s.path === "Roadmap.md")?.target).toBe("Roadmap");
    expect(all.find((s) => s.path === "Work/Notes.md")?.target).toBe("Work/Notes");
    for (const s of all) expect(resolver.resolve("Here.md", { syntax: "wikilink", target: s.target, external: false })).toEqual({ state: "resolved", path: s.path });
  });

  it("caps the list", () => {
    const many = Array.from({ length: 30 }, (_, i) => page(`P${i}.md`, `Page ${i}`));
    expect(createLinkSuggester("x.md", many).suggest("page")).toHaveLength(8);
  });
});

describe("Plain mode trigger and completion", () => {
  const at = (doc: string) => {
    const caret = doc.indexOf("|");
    const text = doc.replace("|", "");
    const state = EditorState.create({ doc: text, selection: EditorSelection.cursor(caret), extensions: [markdownSupport()] });
    ensureSyntaxTree(state, state.doc.length, 5000);
    return state;
  };
  const item = { path: "Roadmap.md", title: "Roadmap", folder: "", alias: null, target: "Roadmap" };

  it("finds `[[query` before the caret", () => {
    expect(findTrigger(at("See [[Ro|"))).toEqual({ from: 4, to: 8, query: "Ro" });
    expect(findTrigger(at("[[|"))).toEqual({ from: 0, to: 2, query: "" });
  });

  it("ignores escaped brackets, closed links, code and frontmatter", () => {
    expect(findTrigger(at("\\[[Ro|"))).toBeNull();
    expect(findTrigger(at("[[Ro]] x|"))).toBeNull();
    expect(findTrigger(at("`[[Ro|`"))).toBeNull();
    expect(findTrigger(at("```\n[[Ro|\n```\n"))).toBeNull();
    expect(findTrigger(at("---\na: [[Ro|\n---\n"))).toBeNull();
  });

  it("completes with the closing brackets, keeping a typed heading or label", () => {
    const s1 = at("See [[ro| now");
    expect(completion(s1, findTrigger(s1)!, item)).toEqual({ from: 4, to: 8, insert: "[[Roadmap]]", cursor: 15 });
    const s2 = at("[[ro#Goals|");
    expect(completion(s2, findTrigger(s2)!, item).insert).toBe("[[Roadmap#Goals]]");
    const s3 = at("[[ro|]] tail"); // `]]` already typed (auto-paired or by hand)
    expect(completion(s3, findTrigger(s3)!, item)).toEqual({ from: 0, to: 4, insert: "[[Roadmap", cursor: 11 });
  });
});
