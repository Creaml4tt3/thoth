// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { downloadInBrowser, markdownFileName } from "../src/download/download.ts";

describe("Download as Markdown", () => {
  it("names the file after the title: one .md name a system accepts", () => {
    expect(markdownFileName("Plan")).toBe("Plan.md");
    expect(markdownFileName("Plan.md")).toBe("Plan.md");
    expect(markdownFileName("Road: map?")).toBe("Road  map.md");
    expect(markdownFileName("../a/b")).toBe("a b.md");
    expect(markdownFileName("  ")).toBe("Untitled.md");
    expect(markdownFileName("...")).toBe("Untitled.md");
    expect(markdownFileName("x".repeat(300))).toBe(`${"x".repeat(120)}.md`);
    expect(markdownFileName("แผนงาน")).toBe("แผนงาน.md");
  });

  it("the browser's download: a Markdown blob through a link that is gone after the click", async () => {
    const urls: Blob[] = [];
    vi.stubGlobal("URL", { ...URL, createObjectURL: (blob: Blob) => (urls.push(blob), "blob:test"), revokeObjectURL: vi.fn() });
    const clicked: { name: string; href: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ name: this.download, href: this.getAttribute("href") ?? "" });
    });
    expect(downloadInBrowser("Plan.md", "# Plan\n")).toBe(true);
    expect(clicked).toEqual([{ name: "Plan.md", href: "blob:test" }]);
    expect(urls[0]!.type).toBe("text/markdown;charset=utf-8");
    expect(await urls[0]!.text()).toBe("# Plan\n");
    expect(document.querySelector("a[download]")).toBeNull();
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});
