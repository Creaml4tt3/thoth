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
import { atMenuOpen, atQuery, createLinkSuggester } from "@thoth/app-ui/editor/link-suggest.ts";
import { workspaceLinkLookup, workspaceLinkSuggester } from "@thoth/app-ui/workspace/workspace-links.ts";
import { buildLinkLookup } from "@thoth/app-ui/editor/links.ts";
import { completion, findTrigger } from "@thoth/app-ui/editor/plain/link-suggest-plain.ts";
import { markdownSupport } from "@thoth/app-ui/editor/plain/syntax.ts";

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
  const item = { kind: "page" as const, path: "Roadmap.md", title: "Roadmap", folder: "", alias: null, target: "Roadmap" };

  it("finds `[[query` before the caret", () => {
    expect(findTrigger(at("See [[Ro|"))).toEqual({ from: 4, to: 8, query: "Ro", kind: "wiki" });
    expect(findTrigger(at("[[|"))).toEqual({ from: 0, to: 2, query: "", kind: "wiki" });
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

describe("@ trigger rules (ADR-0043)", () => {
  it("opens at the start of a line, after whitespace or an opening bracket", () => {
    expect(atQuery("@")).toEqual({ at: 0, query: "" });
    expect(atQuery("@ro")).toEqual({ at: 0, query: "ro" });
    expect(atQuery("see @ro")).toEqual({ at: 4, query: "ro" });
    expect(atQuery("(@ro")).toEqual({ at: 1, query: "ro" });
    expect(atQuery("[@ro")).toEqual({ at: 1, query: "ro" });
    expect(atQuery("x\t@Somchai Jai")).toEqual({ at: 2, query: "Somchai Jai" });
  });

  it("never opens inside an email address or a word", () => {
    expect(atQuery("mail@example")).toBeNull();
    expect(atQuery("write to ada@thoth.test")).toBeNull();
    expect(atQuery("a@")).toBeNull();
    expect(atQuery("ชื่อ@ro")).toBeNull();
    expect(atQuery("@@ro")).toBeNull();
    expect(atQuery("@ ro")).toBeNull(); // a space right after @ is not a query
  });

  it("closes once a space is typed and nothing matches", () => {
    expect(atMenuOpen("Somchai", 0)).toBe(true);
    expect(atMenuOpen("Somchai J", 1)).toBe(true);
    expect(atMenuOpen("Somchai x", 0)).toBe(false);
  });

  it("Plain mode: finds @query, but not in code, emails, or a mention already written", () => {
    const at = (doc: string) => {
      const caret = doc.indexOf("|");
      const state = EditorState.create({ doc: doc.replace("|", ""), selection: EditorSelection.cursor(caret), extensions: [markdownSupport()] });
      ensureSyntaxTree(state, state.doc.length, 5000);
      return state;
    };
    expect(findTrigger(at("Hi @ro|"))).toEqual({ from: 3, to: 6, query: "ro", kind: "at" });
    expect(findTrigger(at("@|"))).toEqual({ from: 0, to: 1, query: "", kind: "at" });
    expect(findTrigger(at("me@ro|"))).toBeNull();
    expect(findTrigger(at("`@ro|`"))).toBeNull();
    expect(findTrigger(at("[@Ada|](thoth:user/a)"))).toBeNull();
  });

  it("Plain mode: @ inserts a wikilink for a page or folder and a mention for a person", () => {
    const state = EditorState.create({ doc: "Hi @ro", selection: EditorSelection.cursor(6), extensions: [markdownSupport()] });
    ensureSyntaxTree(state, state.doc.length, 5000);
    const trigger = findTrigger(state)!;
    expect(completion(state, trigger, { kind: "folder", path: "Projects/", title: "Projects", folder: "", alias: null, target: "Projects/" }).insert).toBe("[[Projects/]]");
    expect(completion(state, trigger, { kind: "page", path: "x", title: "Road", folder: "", alias: null, target: "thoth:page/x", label: "Road" }).insert).toBe("[[thoth:page/x|Road]]");
    expect(completion(state, trigger, { kind: "person", path: "u_1", title: "Ada [QA]", folder: "", alias: null, target: "u_1" })).toEqual({ from: 3, to: 6, insert: "[@Ada \\[QA\\]](thoth:user/u_1)", cursor: 3 + "[@Ada \\[QA\\]](thoth:user/u_1)".length });
  });
});

describe("folders in the Private Space menu and chips", () => {
  const folders = ["Projects", "Projects/Road", "Home"];
  it("offers folders, matched from a word start (an exact name first), with the shortest resolving target", () => {
    const hits = createLinkSuggester("Here.md", PAGES, folders).suggest("road");
    expect(hits.map((h) => `${h.kind}:${h.title}`)).toEqual(["folder:Road", "page:Road trip", "page:Roadmap"]);
    expect(createLinkSuggester("Here.md", PAGES, folders).suggest("ro").map((h) => h.kind)).toEqual(["page", "page", "folder"]);
    expect(hits.find((h) => h.kind === "folder")?.target).toBe("Road/");
    expect(createLinkSuggester("Here.md", PAGES, folders).suggest("oad").some((h) => h.kind === "folder")).toBe(false);
    // Never people in the Private Space.
    expect(createLinkSuggester("Here.md", PAGES, folders).suggest("", { people: true }).some((h) => h.kind === "person")).toBe(false);
  });

  it("resolves a folder chip to the folder, never to a page by its title", () => {
    const lookup = buildLinkLookup("Here.md", [], PAGES, folders);
    expect(lookup.resolve("Projects/")).toEqual({ state: "resolved", path: "Projects/", folder: true });
    expect(lookup.resolve("Here/")).toEqual({ state: "unresolved" });
  });
});

describe("workspace links (ADR-0043)", () => {
  const id = (n: number) => `01890000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const node = (n: number, title: string, parentId: string | null = null) => ({ id: id(n), parentId, title, revisionId: "r", updatedAt: `2026-10-0${n}T00:00:00Z` });
  const nodes = [node(1, "Projects"), node(2, "Roadmap", id(1)), node(3, "Here"), node(4, "Road notes")];
  const source = { nodes, isFolder: (x: string) => x === id(1), page: id(3), members: [{ userId: "u_1", displayName: "Rosa Diaz", role: "editor" as const }] };

  it("offers pages and folders by ID with the title as label, and people only after @", () => {
    const s = workspaceLinkSuggester(source);
    expect(s.people).toBe(true);
    const wiki = s.suggest("ro");
    expect(wiki.map((h) => [h.kind, h.title, h.folder])).toEqual([["page", "Road notes", ""], ["page", "Roadmap", "Projects"]]);
    expect(wiki[1]).toMatchObject({ target: `thoth:page/${id(2)}`, label: "Roadmap" });
    expect(s.suggest("ro", { people: true }).map((h) => h.title)).toEqual(["Road notes", "Roadmap", "Rosa Diaz"]);
    expect(s.suggest("proj", { people: true })[0]).toMatchObject({ kind: "folder", target: `thoth:page/${id(1)}` });
    expect(s.suggest("here")).toEqual([]); // never the open page
  });

  it("resolves thoth:page links in this workspace to the current title, folders as folders", () => {
    const lookup = workspaceLinkLookup(source);
    expect(lookup.resolve(`thoth:page/${id(2)}`)).toEqual({ state: "resolved", path: id(2), title: "Roadmap" });
    expect(lookup.resolve(`thoth:page/${id(1)}`)).toEqual({ state: "resolved", path: id(1), title: "Projects", folder: true });
    expect(lookup.resolve(`thoth:page/${id(9)}`)).toEqual({ state: "unresolved" });
    expect(lookup.resolve("Roadmap")).toEqual({ state: "unresolved" });
  });

  it("offers no people when the server does not tell the members", () => {
    expect(workspaceLinkSuggester({ ...source, members: null }).people).toBe(false);
  });
});
