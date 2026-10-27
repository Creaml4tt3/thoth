// The Welcome pages a new, empty Private Space starts with (ADR-0032): their Markdown round-trips byte for byte, the
// Welcome page holds every block kind and text style the editor has, the Linking page every kind of link, the
// shortcuts page what the shortcut table says, and the set is written once, never over anything.
import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { decodeText, encodeText } from "@thoth/content";
import { docToMarkdown, markdownToDoc, stripSourceAttrs } from "@thoth/editor";
import { Vault } from "@thoth/local-store";
import { formatShortcut, shortcutById, type ShortcutId } from "@thoth/app-ui/keyboard/shortcuts.ts";
import { WELCOME, WELCOME_RECORD, seedWelcome } from "../src/features/onboarding/welcome.ts";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";

const DIR = new URL("../src/features/onboarding/welcome/", import.meta.url).pathname;

async function markdownIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdownIn(path)));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out.sort();
}

/** Every node type (`heading:2`, `callout:tip`, `list:ordered`) and mark in a document. */
function kinds(node: JSONContent, into = new Set<string>()): Set<string> {
  const attrs = node.attrs ?? {};
  if (node.type) into.add(node.type);
  if (node.type === "heading") into.add(`heading:${attrs["level"]}`);
  if (node.type === "callout") into.add(`callout:${attrs["kind"]}`);
  if (node.type === "list") into.add(attrs["ordered"] ? "list:ordered" : "list:bullet");
  for (const m of node.marks ?? []) into.add(m.type === "textColor" ? `textColor:${m.attrs?.["color"]}` : m.type);
  for (const c of node.content ?? []) kinds(c, into);
  return into;
}

const docOf = (text: string): JSONContent => markdownToDoc(text).doc as JSONContent;
const fileText = (lang: "en" | "th", path: string) => WELCOME[lang].files.find((f) => f.path === path)!.text;

describe("the Welcome pages' Markdown", () => {
  it("is kept in the repo, English and Thai side by side", async () => {
    const files = (await markdownIn(DIR)).map((p) => p.slice(DIR.length));
    expect(files).toEqual(["en/linking.md", "en/shortcuts.md", "en/welcome.md", "th/linking.md", "th/shortcuts.md", "th/welcome.md"]);
  });

  it("opens and saves to the same bytes, untouched and in the canonical form", async () => {
    for (const path of await markdownIn(DIR)) {
      const bytes = new Uint8Array(await readFile(path));
      const { text } = decodeText(bytes);
      const { doc, frontmatter } = markdownToDoc(text);
      expect(Buffer.from(encodeText(docToMarkdown(doc, { frontmatter }))), path).toEqual(Buffer.from(bytes));
      expect(docToMarkdown(stripSourceAttrs(doc), { frontmatter }), path).toBe(text);
    }
  });

  it("is what the app writes", async () => {
    expect(WELCOME.en.files.map((f) => f.path)).toEqual(["Welcome to Thoth.md", "thoth-welcome.svg", "Linking pages.md", "Getting started/Keyboard shortcuts.md"]);
    expect(WELCOME.th.files.map((f) => f.path)).toEqual(["ยินดีต้อนรับสู่ Thoth.md", "thoth-welcome.svg", "การลิงก์หน้า.md", "เริ่มต้นใช้งาน/แป้นพิมพ์ลัด.md"]);
    expect(WELCOME.en.open).toBe("Welcome to Thoth.md");
    expect(WELCOME.th.open).toBe("ยินดีต้อนรับสู่ Thoth.md");
    expect(fileText("en", "Welcome to Thoth.md")).toBe(await readFile(join(DIR, "en/welcome.md"), "utf8"));
    expect(fileText("th", "การลิงก์หน้า.md")).toBe(await readFile(join(DIR, "th/linking.md"), "utf8"));
    expect(fileText("en", "thoth-welcome.svg")).toBe(await readFile(join(DIR, "thoth-welcome.svg"), "utf8"));
  });

  it("the Welcome page has every block kind and text style, and nothing the editor keeps as raw source", () => {
    const want = [
      "heading:1", "heading:2", "heading:3", "list:bullet", "list:ordered", "taskList", "taskItem",
      "callout:toggle", "callout:note", "callout:tip", "callout:warning", "callout:danger", "callout:example",
      "blockquote", "code", "thematicBreak", "table", "tableHeader", "tableCell", "image",
      "bold", "italic", "underline", "strike", "inlineCode", "highlight", "textColor:blue", "link",
    ];
    for (const lang of ["en", "th"] as const) {
      const found = kinds(docOf(fileText(lang, WELCOME[lang].open)));
      for (const kind of want) expect(found, `${lang}: ${kind}`).toContain(kind);
      for (const raw of ["raw", "html", "math", "inlineRaw", "embed"]) expect(found, `${lang}: ${raw}`).not.toContain(raw);
      // The image is the one written next to the page.
      expect(fileText(lang, WELCOME[lang].open)).toContain("](thoth-welcome.svg)");
    }
  });

  it("the Linking page links to a page, a page in a folder, with an alias, to a heading, and embeds one", () => {
    const wikis = (lang: "en" | "th") => {
      const out: JSONContent[] = [];
      const walk = (n: JSONContent) => {
        if (n.type === "wikilink" || n.type === "embed") out.push(n);
        (n.content ?? []).forEach(walk);
      };
      walk(docOf(fileText(lang, WELCOME[lang].files[2]!.path)));
      return out.map((n) => ({ type: n.type, target: n.attrs?.["target"], fragment: n.attrs?.["fragment"] ?? null, label: n.attrs?.["label"] ?? null }));
    };
    const en = wikis("en");
    expect(en).toContainEqual({ type: "wikilink", target: "Welcome to Thoth", fragment: null, label: null });
    expect(en).toContainEqual({ type: "wikilink", target: "Getting started/Keyboard shortcuts", fragment: null, label: null });
    expect(en).toContainEqual({ type: "wikilink", target: "Welcome to Thoth", fragment: null, label: "the first page" });
    expect(en).toContainEqual({ type: "wikilink", target: "Welcome to Thoth", fragment: "Callouts", label: null });
    expect(en).toContainEqual({ type: "embed", target: "Getting started/Keyboard shortcuts", fragment: null, label: null });
    // The Thai page has the same kinds of link, to the Thai pages.
    expect(wikis("th").map((w) => [w.type, w.fragment !== null, w.label !== null])).toEqual(en.map((w) => [w.type, w.fragment !== null, w.label !== null]));
    expect(wikis("th").some((w) => w.target === "เริ่มต้นใช้งาน/แป้นพิมพ์ลัด")).toBe(true);
  });

  it("the shortcuts page says what the shortcut table binds, on macOS and on Windows and Linux", () => {
    const ids: ShortcutId[] = ["palette.open", "shortcuts.open", "page.new", "folder.new", "home.open", "sidebar.toggle", "page.favorite", "settings.open", "theme.cycle", "assistant.ask", "tab.new", "tab.close", "tab.next", "tab.jump", "tab.split", "tab.pin", "editor.save", "editor.mode", "editor.blockMenu", "editor.blockMove", "style.bold", "style.italic", "style.underline", "style.strike", "style.code", "style.highlight", "style.link"];
    for (const lang of ["en", "th"] as const) {
      const rows = fileText(lang, WELCOME[lang].files[3]!.path).split("\n").filter((l) => l.startsWith("| ") && l.includes("`"));
      const cells = rows.map((r) => r.split(" | ").slice(1).map((c) => c.replace(/^`|`( \|)?$/g, "")));
      const listed = new Set(cells.map(([mac, other]) => `${mac}\n${other}`));
      for (const id of ids) {
        const def = shortcutById(id)!;
        expect(listed, `${lang}: ${id}`).toContain(`${formatShortcut(def, "desktop", "mac")}\n${formatShortcut(def, "desktop", "other")}`);
      }
      expect(rows).toHaveLength(ids.length);
    }
  });
});

describe("writing the Welcome pages", () => {
  const dirs = tempDirs();
  let root: string;
  let vault: Vault;
  const open = async () => {
    const connection = await createNodePlatform({ vault: root }).openVault(root);
    vault = (await Vault.open({ fs: connection.fs, sql: connection.sql })).vault;
    return connection;
  };
  let close: () => Promise<void>;

  beforeEach(async () => {
    root = await dirs.dir();
    const connection = await open();
    close = async () => {
      await vault.close();
      await connection.close();
    };
  });
  afterEach(async () => {
    await close();
    await dirs.cleanup();
  });

  it("writes the set into an empty Private Space, the same bytes as the repo's files, and records it", async () => {
    expect(await seedWelcome(vault, "en")).toBe("Welcome to Thoth.md");
    for (const file of WELCOME.en.files) expect(await readFile(join(root, file.path), "utf8")).toBe(file.text);
    expect((await vault.listPages()).map((p) => p.path).sort()).toEqual(["Getting started/Keyboard shortcuts.md", "Linking pages.md", "Welcome to Thoth.md"]);
    expect(await vault.readRecord(WELCOME_RECORD)).toMatchObject({ version: 1, lang: "en" });
    // The Welcome page's image is found, its links resolve.
    expect((await vault.listAttachments()).map((a) => a.path)).toEqual(["thoth-welcome.svg"]);
    expect(await vault.unresolvedLinks()).toEqual([]);
  });

  it("writes the Thai set in Thai, and its links resolve too", async () => {
    expect(await seedWelcome(vault, "th")).toBe("ยินดีต้อนรับสู่ Thoth.md");
    expect((await vault.listPages()).map((p) => p.title).sort()).toEqual(["การลิงก์หน้า", "ยินดีต้อนรับสู่ Thoth", "แป้นพิมพ์ลัด"].sort());
    expect(await vault.unresolvedLinks()).toEqual([]);
  });

  it("only once: pages deleted afterwards do not come back", async () => {
    await seedWelcome(vault, "en");
    for (const page of await vault.listPages()) await rm(join(root, page.path));
    await vault.reconcile();
    expect(await vault.listPages()).toEqual([]);
    expect(await seedWelcome(vault, "en")).toBeNull();
    expect(await vault.listPages()).toEqual([]);
  });

  it("only for an empty Private Space", async () => {
    await writeFile(join(root, "Mine.md"), "# Mine\n");
    await vault.reconcile();
    expect(await seedWelcome(vault, "en")).toBeNull();
    expect((await vault.listPages()).map((p) => p.path)).toEqual(["Mine.md"]);
  });

  it("never overwrites: a file already there under one of the names is kept, the others are written", async () => {
    await writeFile(join(root, "thoth-welcome.svg"), "<svg>mine</svg>");
    await mkdir(join(root, "Getting started"));
    expect(await seedWelcome(vault, "en")).toBe("Welcome to Thoth.md");
    expect(await readFile(join(root, "thoth-welcome.svg"), "utf8")).toBe("<svg>mine</svg>");
    expect(await readFile(join(root, "Getting started/Keyboard shortcuts.md"), "utf8")).toBe(fileText("en", "Getting started/Keyboard shortcuts.md"));
  });
});
