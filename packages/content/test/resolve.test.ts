import { describe, expect, it } from "vitest";
import { LinkResolver } from "../src/index.ts";

const files = [
  "Projects/Thoth/Overview.md",
  "Projects/Thoth/Architecture.md",
  "Archive/Overview.md",
  "Inbox/Welcome.md",
  "Assets/diagram.svg",
  "Notes/README.md",
  "Notes/readme.md",
];
const resolver = new LinkResolver(files, [{ path: "Inbox/Welcome.md", aliases: ["Start Here"] }]);
const wiki = (target: string, from = "Inbox/Welcome.md") =>
  resolver.resolve(from, { syntax: "wikilink", target, external: false });
const md = (target: string, from = "Projects/Thoth/Overview.md") =>
  resolver.resolve(from, { syntax: "markdown-link", target, external: false });

describe("LinkResolver", () => {
  it("resolves unique basenames and aliases", () => {
    expect(wiki("Architecture")).toEqual({ state: "resolved", path: "Projects/Thoth/Architecture.md" });
    expect(wiki("start here")).toEqual({ state: "resolved", path: "Inbox/Welcome.md" });
    expect(wiki("diagram.svg")).toEqual({ state: "resolved", path: "Assets/diagram.svg" });
  });

  it("reports duplicate titles as ambiguous instead of guessing", () => {
    expect(wiki("Overview")).toEqual({
      state: "ambiguous",
      candidates: ["Archive/Overview.md", "Projects/Thoth/Overview.md"],
    });
  });

  it("disambiguates by path and path suffix", () => {
    expect(wiki("Archive/Overview")).toEqual({ state: "resolved", path: "Archive/Overview.md" });
    expect(wiki("Thoth/Overview")).toEqual({ state: "resolved", path: "Projects/Thoth/Overview.md" });
  });

  it("does not collapse case-sensitive path collisions", () => {
    expect(wiki("Notes/README")).toEqual({ state: "resolved", path: "Notes/README.md" });
    expect(wiki("Notes/ReadMe")).toEqual({ state: "ambiguous", candidates: ["Notes/README.md", "Notes/readme.md"] });
  });

  it("resolves markdown links relative to the source file", () => {
    expect(md("Architecture.md")).toEqual({ state: "resolved", path: "Projects/Thoth/Architecture.md" });
    expect(md("../../Assets/diagram.svg")).toEqual({ state: "resolved", path: "Assets/diagram.svg" });
    expect(md("../../../escape.md")).toEqual({ state: "unresolved" });
    expect(md("Missing.md")).toEqual({ state: "unresolved" });
  });

  it("treats external URLs as external", () => {
    expect(resolver.resolve("a.md", { syntax: "markdown-link", target: "https://x", external: true })).toEqual({
      state: "external",
    });
  });
});
