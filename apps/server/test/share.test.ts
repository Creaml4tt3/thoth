/**
 * ADR-0023 share links, the parts that need no database: tokens, the Markdown-to-HTML renderer and its sanitising,
 * the Content-Disposition header, the configuration keys.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// The token check must go through crypto.timingSafeEqual (constant time); the spy proves it does.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const crypto = await import("node:crypto");
const { generateShareToken, hashShareToken, shareTokenMatches, SHARE_TOKEN_PATTERN } = await import("../src/share/tokens.ts");
const { renderShareMarkdown } = await import("../src/share/render.ts");
const { contentDisposition, inlineImageType } = await import("../src/share/files.ts");
const { loadConfig, ConfigError } = await import("../src/config.ts");

const BASE = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("share tokens", () => {
  it("are at least 128 bits from the CSPRNG, URL-safe, and distinct", () => {
    const spy = vi.spyOn(crypto, "randomBytes");
    const tokens = Array.from({ length: 200 }, () => generateShareToken());
    expect(new Set(tokens).size).toBe(200);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(t).toMatch(SHARE_TOKEN_PATTERN);
      expect(Buffer.from(t, "base64url").length * 8).toBeGreaterThanOrEqual(128);
    }
    spy.mockRestore();
  });

  it("are stored as their SHA-256 hash", () => {
    const t = generateShareToken();
    expect(hashShareToken(t)).toBe(createHash("sha256").update(t).digest("hex"));
  });

  it("are compared in constant time (crypto.timingSafeEqual), also against a stored hash of another length", () => {
    const equal = vi.mocked(crypto.timingSafeEqual);
    equal.mockClear();
    const t = generateShareToken();
    expect(shareTokenMatches(t, hashShareToken(t))).toBe(true);
    expect(shareTokenMatches(generateShareToken(), hashShareToken(t))).toBe(false);
    expect(shareTokenMatches(t, "abc")).toBe(false);
    expect(shareTokenMatches(t, null)).toBe(false);
    expect(equal).toHaveBeenCalledTimes(4);
  });
});

describe("the share renderer", () => {
  const PAGE = "0190d6a2-0c1a-7c3e-8d1f-000000000001";
  const OUT = "0190d6a2-0c1a-7c3e-8d1f-000000000002";
  const IMG = "0190d6a2-0c1a-7c3e-8d1f-0000000000a1";
  const SVG = "0190d6a2-0c1a-7c3e-8d1f-0000000000a2";
  const PDF = "0190d6a2-0c1a-7c3e-8d1f-0000000000a3";
  const ctx = {
    page: (id: string) => (id === PAGE ? { href: "/s/T/p/" + id, title: "Inside" } : null),
    attachment: (id: string) => ({ [IMG]: { href: `/s/T/a/${IMG}`, inline: true, name: "pic.png" }, [SVG]: { href: `/s/T/a/${SVG}`, inline: false, name: "x.svg" }, [PDF]: { href: `/s/T/a/${PDF}`, inline: false, name: "doc.pdf" } })[id] ?? null,
  };
  const render = (md: string) => renderShareMarkdown(md, ctx).html;

  it("escapes raw HTML, blocks and inline, and never passes a tag or an attribute through", () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\nx <a href="javascript:1" onclick="y">a</a> <style>p{}</style>\n');
    expect(html).not.toMatch(/<(script|img|a|style)\b/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("drops dangerous link schemes and marks external links nofollow", () => {
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", " javascript:x", "java\tscript:x"]) {
      const html = render(`[click](<${href}>)`);
      expect(html, href).toBe("<p>click</p>\n");
    }
    expect(render("[x](https://example.org/a?b=1&c=2)")).toBe('<p><a href="https://example.org/a?b=1&amp;c=2" rel="noopener noreferrer nofollow">x</a></p>\n');
    expect(render("[m](mailto:a@example.org)")).toBe('<p><a href="mailto:a@example.org" rel="noopener noreferrer nofollow">m</a></p>\n');
    expect(render("<https://example.org>")).toBe('<p><a href="https://example.org" rel="noopener noreferrer nofollow">https://example.org</a></p>\n');
    // Relative paths would resolve on the server's origin; they stay text.
    expect(render("[rel](other.md) [abs](/api/v1/me)")).toBe("<p>rel abs</p>\n");
  });

  it("links pages inside the subtree and keeps others as text, never looking up their titles", () => {
    expect(render(`[[thoth:page/${PAGE}]] [[thoth:page/${PAGE}|label]] [in](thoth:page/${PAGE})`)).toBe(`<p><a href="/s/T/p/${PAGE}">Inside</a> <a href="/s/T/p/${PAGE}">label</a> <a href="/s/T/p/${PAGE}">in</a></p>\n`);
    expect(render(`[[thoth:page/${OUT}|Secret]] [[thoth:page/${OUT}]] [x](thoth:page/${OUT}) [[Some page]] [[Some page|shown]] ![[thoth:page/${OUT}]]`)).toBe("<p>Secret a page that is not shared x Some page shown a page that is not shared</p>\n");
  });

  it("shows inline pictures, links SVG and other files for download, and never loads an outside image", () => {
    expect(render(`![a "pic"](thoth:attachment/${IMG})`)).toBe(`<p><img src="/s/T/a/${IMG}" alt="a &quot;pic&quot;"></p>\n`);
    expect(render(`![[thoth:attachment/${IMG}|100]]`)).toBe(`<p><img src="/s/T/a/${IMG}" alt="pic.png"></p>\n`);
    expect(render(`![](thoth:attachment/${SVG}) ![[thoth:attachment/${PDF}|doc.pdf]]`)).toBe(`<p><a href="/s/T/a/${SVG}" download>x.svg</a> <a href="/s/T/a/${PDF}" download>doc.pdf</a></p>\n`);
    expect(render("![tracker](https://evil.example/p.gif)")).toBe('<p><a href="https://evil.example/p.gif" rel="noopener noreferrer nofollow">tracker</a></p>\n');
    expect(render(`![gone](thoth:attachment/0190d6a2-0c1a-7c3e-8d1f-0000000000ff)`)).toBe("<p>gone</p>\n");
  });

  it("collects the attachments a page uses (the ones it may serve)", () => {
    const { attachmentIds } = renderShareMarkdown(`![a](thoth:attachment/${IMG})\n\n[[thoth:attachment/${PDF}]]\n\n\`thoth:attachment/${SVG}\`\n`, ctx);
    expect([...attachmentIds].sort()).toEqual([IMG, PDF].sort());
  });

  it("renders the Markdown a Thoth page holds", () => {
    expect(render("---\ntitle: x\n---\n# Head\n\nText")).toBe("<h1>Head</h1>\n<p>Text</p>\n");
    expect(render("**b** _i_ ~~s~~ `c` ==m== <u>u</u> <span data-color=\"blue\">c</span> <span data-color=\"evil\">e</span>")).toBe('<p><strong>b</strong> <em>i</em> <del>s</del> <code>c</code> <mark>m</mark> <u>u</u> <span class="tc tc-blue">c</span> &lt;span data-color=&quot;evil&quot;&gt;e&lt;/span&gt;</p>\n');
    expect(render("<u>open")).toBe("<p><u>open</u></p>\n");
    expect(render("close</u>")).toBe("<p>close&lt;/u&gt;</p>\n");
    expect(render("- [x] done\n- [ ] open\n")).toBe('<ul class="tasks">\n<li><input type="checkbox" disabled checked aria-label="Done"> done</li>\n<li><input type="checkbox" disabled aria-label="Not done"> open</li>\n</ul>\n');
    expect(render("1. one\n2. two\n")).toBe("<ol>\n<li>one</li>\n<li>two</li>\n</ol>\n");
    expect(render("3. three\n")).toBe('<ol start="3">\n<li>three</li>\n</ol>\n');
    expect(render("> quote\n")).toBe("<blockquote>\n<p>quote</p>\n</blockquote>\n");
    expect(render("```ts\nlet a = 1 < 2;\n```\n")).toBe('<pre><code class="language-ts">let a = 1 &lt; 2;\n</code></pre>\n');
    expect(render('```"><script>\nx\n```\n')).toBe('<pre><code>x\n</code></pre>\n');
    expect(render("| a | b |\n| :- | -: |\n| 1 | 2 |\n")).toBe('<div class="table" tabindex="0"><table>\n<thead>\n<tr><th class="left">a</th><th class="right">b</th></tr>\n</thead>\n<tbody>\n<tr><td class="left">1</td><td class="right">2</td></tr>\n</tbody>\n</table></div>\n');
    expect(render("a\\\nb\n\n---\n")).toBe("<p>a<br>\nb</p>\n<hr>\n");
    expect(render("[ref][r]\n\n[r]: https://example.org\n")).toBe('<p><a href="https://example.org" rel="noopener noreferrer nofollow">ref</a></p>\n');
    expect(render("x[^1]\n\n[^1]: note\n")).toContain('<section class="footnotes">');
  });
});

describe("attachment headers", () => {
  it("serves only raster images inline, never SVG", () => {
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) expect(inlineImageType(t), t).toBe(true);
    for (const t of ["image/svg+xml", "text/html", "application/pdf", "image/png; x", "IMAGE/SVG+XML", "application/octet-stream"]) expect(inlineImageType(t), t).toBe(false);
  });

  it("writes a Content-Disposition that cannot break out of its quotes or the header", () => {
    expect(contentDisposition("inline", 'a"b\\c\r\nd.png')).toBe(`inline; filename="a_b_c__d.png"; filename*=UTF-8''a%22b%5Cc%0D%0Ad.png`);
    expect(contentDisposition("attachment", "ภาพ.png")).toBe(`attachment; filename="___.png"; filename*=UTF-8''%E0%B8%A0%E0%B8%B2%E0%B8%9E.png`);
    expect(contentDisposition("attachment", null)).toBe("attachment");
    expect(contentDisposition("attachment", "")).toBe("attachment");
  });
});

describe("the stylesheet and fonts", () => {
  it("are the same bytes from the files and from the module the Vercel bundle embeds", async () => {
    const files = await import("../src/share/assets.ts");
    const inlined = await import(`data:text/javascript;base64,${Buffer.from(files.inlineShareAssetsModule()).toString("base64")}`);
    for (const name of Object.keys(files.SHARE_ASSET_TYPES)) {
      const a = files.shareAsset(name)!;
      const b = inlined.shareAsset(name);
      expect(b.type, name).toBe(a.type);
      expect(Buffer.compare(b.bytes, a.bytes), name).toBe(0);
    }
    for (const bad of ["../package.json", "share.css/..", "nothing.css", "__proto__", "constructor"]) {
      expect(files.shareAsset(bad), bad).toBeNull();
      expect(inlined.shareAsset(bad), bad).toBeNull();
    }
  });
});

describe("configuration", () => {
  it("lists public-share by default and drops it with PUBLIC_SHARE=off", () => {
    expect(loadConfig(BASE).capabilities).toContain("public-share");
    expect(loadConfig({ ...BASE, PUBLIC_SHARE: "off" }).capabilities).not.toContain("public-share");
    expect(() => loadConfig({ ...BASE, PUBLIC_SHARE: "maybe" })).toThrow(ConfigError);
  });

  it("sets no share limits by default, the trial's limits in the trial, and explicit values win", () => {
    expect(loadConfig(BASE).share).toEqual({ maxLinksPerWorkspace: undefined, viewsPerLink: undefined, viewsPerIp: undefined });
    expect(loadConfig({ ...BASE, THOTH_PROFILE: "trial" }).share).toEqual({ maxLinksPerWorkspace: 20, viewsPerLink: 300, viewsPerIp: 120 });
    expect(loadConfig({ ...BASE, THOTH_PROFILE: "trial", MAX_SHARE_LINKS_PER_WORKSPACE: "unlimited", SHARE_VIEWS_PER_LINK: "5", SHARE_VIEWS_PER_IP: "6" }).share).toEqual({ maxLinksPerWorkspace: undefined, viewsPerLink: 5, viewsPerIp: 6 });
    expect(() => loadConfig({ ...BASE, SHARE_VIEWS_PER_IP: "0" })).toThrow(ConfigError);
  });
});
