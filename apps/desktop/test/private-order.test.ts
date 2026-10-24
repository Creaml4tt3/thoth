import { describe, expect, it } from "vitest";
import type { PageSummary } from "@thoth/domain";
import type { OrderRecord } from "@thoth/local-store";
import { placeName } from "../src/features/shell/arrange.ts";
import { buildTree, childrenAt, listFolders, nodeName } from "../src/features/shell/tree.ts";

const page = (path: string, title = path.replace(/^.*\//, "").replace(/\.md$/, "")): PageSummary => ({ path, title }) as PageSummary;
const names = (tree: ReturnType<typeof buildTree>) => tree.map(nodeName);

describe("Private Space tree order", () => {
  const pages = [page("Alpha.md"), page("Beta.md"), page("Gamma.md"), page("Docs/Notes.md"), page("Docs/Zed.md"), page("Docs/Abe.md")];

  it("is folders first, then pages A–Z, without an order record", () => {
    expect(names(buildTree(pages))).toEqual(["Docs", "Alpha.md", "Beta.md", "Gamma.md"]);
  });

  it("follows the order record, per folder; unlisted names come after, A–Z; stale names are ignored", () => {
    const order: OrderRecord = { version: 1, folders: { "": ["Gamma.md", "Gone.md", "Alpha.md"], Docs: ["Zed.md"] } };
    const tree = buildTree(pages, { order });
    expect(names(tree)).toEqual(["Gamma.md", "Alpha.md", "Docs", "Beta.md"]);
    expect(names(childrenAt(tree, "Docs") as typeof tree)).toEqual(["Zed.md", "Abe.md", "Notes.md"]);
  });

  it("lets folders sit among pages when the record says so, and shows folders that hold no page", () => {
    const order: OrderRecord = { version: 1, folders: { "": ["Alpha.md", "Docs"] } };
    const tree = buildTree(pages, { order, folders: ["Docs", "Empty", "Docs/Deep"] });
    expect(names(tree)).toEqual(["Alpha.md", "Docs", "Empty", "Beta.md", "Gamma.md"]);
    expect(listFolders(tree).map((f) => `${f.depth}:${f.path}`)).toEqual(["0:Docs", "1:Docs/Deep", "0:Empty"]);
  });

  it("puts a name at an index among the others, clamped", () => {
    expect(placeName(["a", "b", "c"], "x", 1)).toEqual(["a", "x", "b", "c"]);
    expect(placeName(["a", "b", "c"], "b", 0)).toEqual(["b", "a", "c"]);
    expect(placeName(["a", "b"], "x", 99)).toEqual(["a", "b", "x"]);
    expect(placeName(["a", "b"], "x", -3)).toEqual(["x", "a", "b"]);
  });
});
