import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AllSelection, TextSelection, EditorState, NodeSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { TEXT_COLORS, docToMarkdown, markdownToDoc, thothSchema, type TextColor } from "@thoth/editor";
import { en } from "../src/strings/en.ts";
import { th } from "../src/strings/th.ts";
import {
  MARK_STYLES,
  STYLE_SHORTCUTS,
  activeLinkHref,
  activeTextColor,
  applyEdit,
  isStyleActive,
  normalizeHref,
  setLink,
  setTextColor,
  shortcutLabel,
  toggleStyle,
  toolbarApplies,
  type Edit,
  type MarkStyle,
} from "../src/editor/text-styles.ts";

/**
 * The commands behind the selection toolbar and the shortcuts, on the real schema and the real serializer
 * (`docToMarkdown`, the call `PageEditor.markdown()` makes). The app-level path through `PageSession` is
 * covered in apps/desktop/test/text-styles.test.tsx.
 */

const schema = thothSchema();

interface Doc {
  state: EditorState;
  frontmatter: string;
}

/** A state over `source`, with the selection on the first occurrence of `select` (empty string: a caret at the start). */
function open(source: string, select = ""): Doc {
  const parsed = markdownToDoc(source);
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON(parsed.doc) });
  if (select) {
    let from = -1;
    // Text may be split into several nodes by marks: search the text of each block and map back to a position.
    state.doc.descendants((block, blockPos) => {
      if (from >= 0 || !block.isTextblock) return;
      let text = "";
      const starts: number[] = [];
      block.forEach((child, offset) => {
        if (!child.isText) return;
        for (let k = 0; k < child.text!.length; k++) starts.push(blockPos + 1 + offset + k);
        text += child.text;
      });
      const i = text.indexOf(select);
      if (i >= 0) from = starts[i]!;
    });
    if (from < 0) throw new Error(`"${select}" not in the document`);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + select.length)));
  }
  return { state, frontmatter: parsed.frontmatter };
}

const write = ({ state, frontmatter }: Doc) => docToMarkdown(state.doc.toJSON(), { frontmatter });
function run(doc: Doc, edit: Edit): Doc {
  const next = applyEdit(doc.state, edit);
  if (!next) throw new Error("the command changed nothing");
  return { ...doc, state: next };
}
const markdownAfter = (source: string, select: string, edit: Edit) => write(run(open(source, select), edit));

describe("toolbar commands write the Markdown ADR-0016 says", () => {
  const expected: Record<MarkStyle, string> = {
    bold: "a **bold** b\n",
    italic: "a *bold* b\n",
    underline: "a <u>bold</u> b\n",
    strike: "a ~~bold~~ b\n",
    inlineCode: "a `bold` b\n",
    highlight: "a ==bold== b\n",
  };

  for (const style of MARK_STYLES) {
    it(`${style}: applies and removes`, () => {
      const applied = run(open("a bold b\n", "bold"), toggleStyle(style));
      expect(write(applied)).toBe(expected[style]);
      expect(isStyleActive(applied.state, style)).toBe(true);
      const removed = run(applied, toggleStyle(style));
      expect(write(removed)).toBe("a bold b\n");
      expect(isStyleActive(removed.state, style)).toBe(false);
    });
  }

  it("removes a style from text that already has it in the file", () => {
    expect(markdownAfter("a ==bold== b\n", "bold", toggleStyle("highlight"))).toBe("a bold b\n");
    expect(markdownAfter("a <u>bold</u> b\n", "bold", toggleStyle("underline"))).toBe("a bold b\n");
  });

  it("styles part of a word and leaves the rest of the file's bytes alone", () => {
    const source = "# Title\n\nFirst  paragraph.\n\n* odd bullet\n\nSecond has lots   of space   \n";
    expect(markdownAfter(source, "paragraph", toggleStyle("highlight"))).toBe(source.replace("paragraph", "==paragraph=="));
  });

  it("switches the whole selection on when only part of it has the style", () => {
    const doc = open("**ab**cd\n", "abcd");
    expect(isStyleActive(doc.state, "bold")).toBe(false);
    expect(write(run(doc, toggleStyle("bold")))).toBe("**abcd**\n");
  });

  it("combines styles", () => {
    let doc = open("a bold b\n", "bold");
    doc = run(doc, toggleStyle("bold"));
    doc = run(doc, toggleStyle("highlight"));
    doc = run(doc, toggleStyle("underline"));
    const md = write(doc);
    expect(md).toContain("bold");
    expect(md).toMatch(/\*\*.*\*\*/);
    expect(md).toContain("==");
    expect(md).toContain("<u>");
    expect(markdownToDoc(md).doc).toBeTruthy();
    // And back off, one by one.
    doc = run(run(run(doc, toggleStyle("underline")), toggleStyle("highlight")), toggleStyle("bold"));
    expect(write(doc)).toBe("a bold b\n");
  });

  it("styles across paragraphs and list items", () => {
    expect(markdownAfter("one\n\ntwo\n", "one\n\ntwo".slice(0, 3), toggleStyle("italic"))).toBe("*one*\n\ntwo\n");
    let doc = open("one\n\ntwo\n");
    doc = { ...doc, state: doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, 1, doc.state.doc.content.size - 1))) };
    expect(write(run(doc, toggleStyle("highlight")))).toBe("==one==\n\n==two==\n");
  });

  it("leaves a wikilink inside the selection unstyled", () => {
    const md = markdownAfter("see [[Other Page]] now\n", "see ", toggleStyle("bold"));
    expect(md).toBe("**see** [[Other Page]] now\n");
    const doc = open("see [[Other Page]] now\n");
    const all = { ...doc, state: doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, 1, doc.state.doc.content.size - 1))) };
    expect(write(run(all, toggleStyle("bold")))).toBe("**see** [[Other Page]] **now**\n");
  });
});

describe("text colour", () => {
  for (const color of TEXT_COLORS) {
    it(`${color}: sets and clears with default`, () => {
      const set = run(open("a word b\n", "word"), setTextColor(color));
      expect(write(set)).toBe(`a <span data-color="${color}">word</span> b\n`);
      expect(activeTextColor(set.state)).toBe(color);
      const cleared = run(set, setTextColor(null));
      expect(write(cleared)).toBe("a word b\n");
      expect(activeTextColor(cleared.state)).toBeNull();
    });
  }

  it("replaces a colour instead of nesting", () => {
    const red = run(open("a word b\n", "word"), setTextColor("red"));
    expect(write(run(red, setTextColor("blue")))).toBe('a <span data-color="blue">word</span> b\n');
  });

  it("reads no colour from a selection with several", () => {
    const doc = open('<span data-color="red">a</span><span data-color="blue">b</span>\n', "ab");
    expect(activeTextColor(doc.state)).toBeNull();
    expect(write(run(doc, setTextColor("green")))).toBe('<span data-color="green">ab</span>\n');
  });

  it("refuses a name outside the palette", () => {
    expect(applyEdit(open("a word b\n", "word").state, setTextColor("pink" as TextColor))).toBeNull();
  });

  it("can nest with highlight and bold", () => {
    let doc = run(open("a word b\n", "word"), setTextColor("green"));
    doc = run(doc, toggleStyle("highlight"));
    const md = write(doc);
    expect(md).toContain('data-color="green"');
    expect(md).toContain("==");
    expect(write(run(run(doc, toggleStyle("highlight")), setTextColor(null)))).toBe("a word b\n");
  });
});

describe("link", () => {
  it("adds, reads and removes a link", () => {
    const linked = run(open("a word b\n", "word"), setLink("https://example.com/x"));
    expect(write(linked)).toBe("a [word](https://example.com/x) b\n");
    expect(isStyleActive(linked.state, "link")).toBe(true);
    expect(activeLinkHref(linked.state)).toBe("https://example.com/x");
    const removed = run(linked, setLink(null));
    expect(write(removed)).toBe("a word b\n");
    expect(activeLinkHref(removed.state)).toBeNull();
  });

  it("replaces the address of an existing link", () => {
    expect(markdownAfter("a [word](https://a.example) b\n", "word", setLink("https://b.example"))).toBe("a [word](https://b.example) b\n");
  });

  it("needs a selection", () => {
    expect(applyEdit(open("a word b\n").state, setLink("https://example.com"))).toBeNull();
  });

  it("accepts web, mail and phone addresses and page paths, and refuses code-running schemes", () => {
    expect(normalizeHref("  https://example.com/a?b=1#c ")).toBe("https://example.com/a?b=1#c");
    expect(normalizeHref("example.com")).toBe("https://example.com");
    expect(normalizeHref("www.example.com/x")).toBe("https://www.example.com/x");
    expect(normalizeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(normalizeHref("tel:+66123")).toBe("tel:+66123");
    expect(normalizeHref("notes/Plan.md")).toBe("notes/Plan.md");
    expect(normalizeHref("Plan.md#Goals")).toBe("Plan.md#Goals");
    expect(normalizeHref("#heading")).toBe("#heading");
    expect(normalizeHref("../Other page.md")).toBe("../Other page.md");
    expect(normalizeHref("")).toBe("");
    expect(normalizeHref("   ")).toBe("");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "//evil.example", "a\nb"]) {
      expect(normalizeHref(bad), bad).toBeNull();
    }
  });

  it("writes an address with spaces so it reads back as the same link", () => {
    const md = markdownAfter("a word b\n", "word", setLink("../Other page.md"));
    const reread = open(md, "word");
    expect(activeLinkHref(reread.state)).toBe("../Other page.md");
  });
});

describe("caret and selection rules", () => {
  it("a caret changes what is typed next, not the text", () => {
    const doc = open("a word b\n");
    const next = run(doc, toggleStyle("bold"));
    expect(write(next)).toBe("a word b\n");
    expect(isStyleActive(next.state, "bold")).toBe(true);
    expect(next.state.storedMarks?.map((m) => m.type.name)).toEqual(["bold"]);
    const colored = run(doc, setTextColor("red"));
    expect(activeTextColor(colored.state)).toBe("red");
  });

  it("the toolbar needs a non-empty text selection", () => {
    expect(toolbarApplies(open("a word b\n").state)).toBe(false);
    expect(toolbarApplies(open("a word b\n", "word").state)).toBe(true);
  });

  it("no style goes into a code block, and the toolbar stays away from it", () => {
    const source = "```js\nconst a = 1;\n```\n";
    const doc = open(source, "const");
    expect(toolbarApplies(doc.state)).toBe(false);
    for (const style of MARK_STYLES) expect(applyEdit(doc.state, toggleStyle(style))).toBeNull();
    expect(applyEdit(doc.state, setTextColor("red"))).toBeNull();
    expect(applyEdit(doc.state, setLink("https://example.com"))).toBeNull();
    // A selection that reaches into a code block hides the toolbar too.
    const both = open("text\n\n```js\ncode\n```\n");
    const wide = both.state.apply(both.state.tr.setSelection(TextSelection.create(both.state.doc, 1, both.state.doc.content.size - 1)));
    expect(toolbarApplies(wide)).toBe(false);
  });

  it("the toolbar stays away from raw blocks and node selections", () => {
    const source = "<div>\nraw\n</div>\n\ntext here\n";
    const doc = open(source);
    const html = doc.state.doc.firstChild!;
    expect(html.type.name).toBe("html");
    const picked = doc.state.apply(doc.state.tr.setSelection(NodeSelection.create(doc.state.doc, 0)));
    expect(toolbarApplies(picked)).toBe(false);
    const wide = doc.state.apply(doc.state.tr.setSelection(new AllSelection(doc.state.doc)));
    expect(toolbarApplies(wide)).toBe(false);
  });

  it("leaves a raw inline atom unstyled", () => {
    const doc = open("x <kbd>K</kbd> y\n");
    const all = doc.state.apply(doc.state.tr.setSelection(TextSelection.create(doc.state.doc, 1, doc.state.doc.content.size - 1)));
    const md = write(run({ ...doc, state: all }, toggleStyle("bold")));
    // The tags are raw HTML and stay as written; only the text between them takes the style.
    expect(md).toBe("**x** <kbd>**K**</kbd> **y**\n");
  });
});

describe("shortcut map", () => {
  const all = Object.entries(STYLE_SHORTCUTS).flatMap(([command, keys]) => keys.map((key) => ({ command, key })));

  it("has the keys ADR-0016 and the task name", () => {
    expect(STYLE_SHORTCUTS.bold).toEqual(["Mod-b"]);
    expect(STYLE_SHORTCUTS.italic).toEqual(["Mod-i"]);
    expect(STYLE_SHORTCUTS.underline).toEqual(["Mod-u"]);
    expect(STYLE_SHORTCUTS.strike).toEqual(["Mod-Shift-s"]);
    expect(STYLE_SHORTCUTS.inlineCode).toEqual(["Mod-e"]);
    expect(STYLE_SHORTCUTS.highlight).toEqual(["Mod-Shift-h"]);
    expect(STYLE_SHORTCUTS.link).toEqual(["Mod-Shift-k"]);
  });

  it("gives every command a key and no key to two commands", () => {
    for (const command of [...MARK_STYLES, "link", "toolbar"] as const) expect(STYLE_SHORTCUTS[command].length, command).toBeGreaterThan(0);
    const keys = all.map((a) => a.key.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never takes Mod+K (search and the palette), Mod+S (save) or the keys the editor and block menu use", () => {
    const taken = ["Mod-k", "Mod-s", "Mod-z", "Mod-y", "Mod-Shift-z", "Mod-Shift-e", "Mod-Alt-m", "Mod-f", "Mod-t", "Mod-w", "Mod-/", "Mod-Shift-Enter"];
    for (const { key } of all) expect(taken.map((t) => t.toLowerCase()), key).not.toContain(key.toLowerCase());
  });

  it("is written with Mod, so Cmd works on macOS and Ctrl elsewhere", () => {
    for (const style of [...MARK_STYLES, "link"] as const) expect(STYLE_SHORTCUTS[style][0]).toMatch(/^Mod-/);
  });

  it("reads as people write it", () => {
    expect(shortcutLabel("Mod-Shift-h")).toBe("Ctrl/Cmd+Shift+H");
    expect(shortcutLabel("Mod-b")).toBe("Ctrl/Cmd+B");
    expect(shortcutLabel("Alt-F10")).toBe("Alt+F10");
  });
});

describe("strings", () => {
  it("has the same keys in English and Thai, with every colour named", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(th.editor.styles)).toEqual(keys(en.editor.styles));
    expect(keys(th.editor.styles.colorNames)).toEqual(["default", ...TEXT_COLORS].sort());
    for (const lang of [en, th]) {
      const s = lang.editor.styles;
      for (const [key, value] of Object.entries(s)) {
        if (typeof value === "string") expect(value.trim(), `${lang.lang}.${key}`).not.toBe("");
      }
      expect(new Set(Object.values(s.colorNames)).size).toBe(9);
    }
    expect(th.editor.styles.bold).not.toBe(en.editor.styles.bold);
    expect(th.editor.styles.withShortcut("ตัวหนา", "Ctrl/Cmd+B")).toContain("Ctrl/Cmd+B");
  });
});

// ---------------------------------------------------------------------------
// WCAG AA for the colour tokens (ADR-0016 rule 1, Phase 3b AC 2)

const tokensPath = fileURLToPath(new URL("../../ui/src/tokens.css", import.meta.url));
const css = readFileSync(tokensPath, "utf8");

type Rgb = [number, number, number];
const hex = (value: string): Rgb => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as Rgb;
const luminance = ([r, g, b]: Rgb) => {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb => fg.map((c, i) => Math.round(c * alpha + bg[i]! * (1 - alpha))) as Rgb;

/** The declarations of the first rule whose selector line is `selector` (as written in tokens.css). */
function block(selector: string, from = 0): string {
  const start = css.indexOf(selector, from);
  if (start < 0) throw new Error(`no ${selector} in tokens.css`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced braces");
}
const prop = (body: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim();

describe("text colour tokens", () => {
  const light = block(":root {");
  const night = block('[data-theme="night"][data-theme]');
  const system = block('[data-theme="system"][data-theme]', css.indexOf("prefers-color-scheme: dark"));

  const surfaces = (body: string, ink: Rgb, bg: Rgb) => {
    const moon = prop(body, "--thoth-moon-soft") ?? prop(light, "--thoth-moon-soft")!;
    const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(moon);
    const mark = m ? over([Number(m[1]), Number(m[2]), Number(m[3])], Number(m[4]), bg) : hex(moon);
    const side = hex(prop(body, "--thoth-bg-sidebar") ?? prop(light, "--thoth-bg-sidebar")!);
    // A callout and a hovered row are the page with the ink at 4.5% / 5% on top.
    const tint = over(ink, ink[0] > 128 ? 0.05 : 0.045, bg);
    return { page: bg, sidebar: side, hover: tint, highlight: mark };
  };

  const themes: [string, string, Rgb, Rgb][] = [
    ["light", light, [20, 18, 16], hex(prop(light, "--thoth-bg")!)],
    ["night", night, [245, 243, 240], hex(prop(night, "--thoth-bg")!)],
    ["system dark", system, [245, 243, 240], hex(prop(system, "--thoth-bg")!)],
  ];

  for (const [name, body, ink, bg] of themes) {
    it(`${name}: all eight colours are declared and reach 4.5:1 on the page, sidebar, a callout and a highlight`, () => {
      const on = surfaces(body, ink, bg);
      for (const color of TEXT_COLORS) {
        const value = prop(body, `--thoth-text-${color}`);
        expect(value, `${name} --thoth-text-${color}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
        for (const [surface, rgb] of Object.entries(on)) {
          expect(contrast(hex(value!), rgb), `${name} ${color} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  it("light and dark values differ for every colour", () => {
    for (const color of TEXT_COLORS) expect(prop(light, `--thoth-text-${color}`), color).not.toBe(prop(night, `--thoth-text-${color}`));
  });

  it("the system theme repeats the night values", () => {
    for (const color of TEXT_COLORS) expect(prop(system, `--thoth-text-${color}`), color).toBe(prop(night, `--thoth-text-${color}`));
  });

  it("the editor stylesheet colours each name from its token and highlight from the accent only", () => {
    const editorCss = readFileSync(fileURLToPath(new URL("../src/editor.css", import.meta.url)), "utf8");
    for (const color of TEXT_COLORS) {
      expect(editorCss).toContain(`.text-color[data-color="${color}"] { color: var(--thoth-text-${color}); }`);
    }
    const mark = /\.prose mark \{([^}]*)\}/.exec(editorCss)?.[1] ?? "";
    expect(mark).toContain("var(--thoth-moon-soft)");
    expect(mark).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    const plainCss = readFileSync(fileURLToPath(new URL("../src/plain.css", import.meta.url)), "utf8");
    expect(/\.md-highlight \{([^}]*)\}/.exec(plainCss)?.[1] ?? "").toContain("var(--thoth-moon-soft)");
  });
});
