// Unlinked mentions (ADR-0050 rules 4 and 5): what counts as a mention, and linking one through compare-and-swap.
import { describe, expect, it } from "vitest";
import { findMentions, linkMention, mentionPattern, wikilinkFor, type MentionStore } from "../src/connections/mentions.ts";

const texts = (source: string, title: string) => findMentions(source, title).map((m) => m.text);

describe("findMentions", () => {
  it("finds the title in any case, in plain text, with its place and context", () => {
    const source = "---\ntitle: x\n---\n# Notes\n\nWe met about project atlas today.\n";
    const [m] = findMentions(source, "Project Atlas");
    expect(m).toMatchObject({ text: "project atlas", before: "We met about ", after: " today.", occurrence: 0, inTable: false });
    expect(source.slice(m!.start, m!.end)).toBe("project atlas");
  });

  it("adds an ellipsis only where the line goes on", () => {
    const long = `${"x ".repeat(40)}Atlas${" y".repeat(40)}`;
    const [m] = findMentions(long, "Atlas");
    expect(m!.before.startsWith("…")).toBe(true);
    expect(m!.after.endsWith("…")).toBe(true);
  });

  it("keeps word edges for scripts written with spaces", () => {
    expect(texts("Atlases and atlas, Atlas! (Atlas) xAtlas Atlas2", "Atlas")).toEqual(["atlas", "Atlas", "Atlas"]);
    expect(texts("Café au lait, cafés", "café")).toEqual(["Café"]);
  });

  it("finds Thai inside a run of text, with no spaces, but never splits a character", () => {
    expect(texts("ฉันใช้ทอธทุกวัน", "ทอธ")).toEqual(["ทอธ"]);
    // "การประชุม" then a tone mark would be a different character cluster: not a mention there.
    expect(texts("การประชุม่", "การประชุม")).toEqual([]);
    // A leading vowel (เ) belongs with the consonant after it.
    expect(texts("เทอธ", "ทอธ")).toEqual([]);
    expect(texts("ประชุมวันนี้ การประชุมทีม", "การประชุม")).toEqual(["การประชุม"]);
  });

  it("matches spaces loosely but never across a line break", () => {
    expect(texts("Project   Atlas and Project\tAtlas", "Project Atlas")).toEqual(["Project   Atlas", "Project\tAtlas"]);
    expect(texts("Project\nAtlas", "Project Atlas")).toEqual([]);
  });

  it("skips links, images, code, HTML and the frontmatter", () => {
    const source = [
      "---",
      "title: Atlas",
      "---",
      "[[Atlas]] [[Other|Atlas]] [Atlas](Atlas.md) ![Atlas](a.png) <https://atlas.example> `Atlas` <!-- Atlas -->",
      "",
      "```",
      "Atlas",
      "```",
      "",
      "Only this Atlas.",
    ].join("\n");
    expect(findMentions(source, "Atlas").map((m) => m.after)).toEqual(["."]);
  });

  it("does not look for titles shorter than three characters, and escapes the title", () => {
    expect(mentionPattern("AI")).toBeNull();
    expect(findMentions("AI and ai", "AI")).toEqual([]);
    expect(texts("C++ (draft) is C++ (draft)", "C++ (draft)")).toEqual(["C++ (draft)", "C++ (draft)"]);
  });

  it("counts occurrences of the same text and knows table cells", () => {
    const source = "| a | b |\n| - | - |\n| Atlas | Atlas |\n\nAtlas\n";
    const found = findMentions(source, "Atlas");
    expect(found.map((m) => [m.occurrence, m.inTable])).toEqual([[0, true], [1, true], [2, false]]);
    expect(findMentions(source, "Atlas", 2)).toHaveLength(2);
  });
});

describe("findMentions with aliases (ADR-0051 rule 12)", () => {
  it("looks for the title and every alias with the same rules, and says which name matched", () => {
    const source = "Met at bkk today. The Bangkok Office is busy; BKKs are not it.\n";
    const found = findMentions(source, ["Bangkok Office", "BKK"]);
    expect(found.map((m) => [m.text, m.name])).toEqual([
      ["bkk", "BKK"],
      ["Bangkok Office", "Bangkok Office"],
    ]);
  });

  it("finds a Thai alias inside Thai text", () => {
    const found = findMentions("วันนี้ไปสำนักงานกรุงเทพแล้วกลับบ้าน", ["Bangkok Office", "สำนักงานกรุงเทพ"]);
    expect(found.map((m) => [m.text, m.name])).toEqual([["สำนักงานกรุงเทพ", "สำนักงานกรุงเทพ"]]);
  });

  it("lists overlapping words once, under the longer name; short names are not looked for", () => {
    const found = findMentions("The Bangkok Office and Bangkok.", ["Bangkok", "Bangkok Office", "BK"]);
    expect(found.map((m) => [m.text, m.name])).toEqual([
      ["Bangkok Office", "Bangkok Office"],
      ["Bangkok", "Bangkok"],
    ]);
  });

  it("links an alias mention with the words as written, and finds it again by that name", async () => {
    const store = memoryStore("Intro.\n\nSee BKK soon.\n", ["Changed intro.\n\nSee BKK soon.\n"]);
    const [m] = findMentions(store.text, ["Bangkok Office", "BKK"]);
    expect(m!.name).toBe("BKK");
    expect(await linkMention(store, ["Bangkok Office", "BKK"], m!, (f) => wikilinkFor("Bangkok Office", f.text, f.inTable))).toBe("linked");
    expect(store.text).toBe("Changed intro.\n\nSee [[Bangkok Office|BKK]] soon.\n");
  });
});

describe("wikilinkFor", () => {
  it("adds a label only when the text differs, escaping the pipe in a table", () => {
    expect(wikilinkFor("Atlas", "Atlas", false)).toBe("[[Atlas]]");
    expect(wikilinkFor("Atlas", "atlas", false)).toBe("[[Atlas|atlas]]");
    expect(wikilinkFor("Atlas", "atlas", true)).toBe("[[Atlas\\|atlas]]");
  });
});

class Conflict extends Error {}
function memoryStore(initial: string, edits: string[] = []): MentionStore & { text: string; writes: number } {
  let hash = 0;
  const store = {
    text: initial,
    writes: 0,
    async read() {
      return { source: store.text, hash: String(hash) };
    },
    async write(source: string, expected: string) {
      // Someone else edits between our read and our write, once per queued edit.
      const edit = edits.shift();
      if (edit !== undefined) {
        store.text = edit;
        hash++;
      }
      if (expected !== String(hash)) throw new Conflict();
      store.text = source;
      store.writes++;
      hash++;
    },
    isConflict: (e: unknown) => e instanceof Conflict,
  };
  return store;
}

describe("linkMention", () => {
  const link = (m: { text: string; inTable: boolean }) => wikilinkFor("Atlas", m.text, m.inTable);

  it("replaces only the mention's characters", async () => {
    const store = memoryStore("See atlas here.\n");
    const [m] = findMentions(store.text, "Atlas");
    expect(await linkMention(store, "Atlas", m!, link)).toBe("linked");
    expect(store.text).toBe("See [[Atlas|atlas]] here.\n");
  });

  it("finds the mention again after the page changed, and retries once on a conflict", async () => {
    const store = memoryStore("See Atlas.\n", ["Intro.\n\nSee Atlas.\n"]);
    const [m] = findMentions(store.text, "Atlas");
    expect(await linkMention(store, "Atlas", m!, link)).toBe("linked");
    expect(store.text).toBe("Intro.\n\nSee [[Atlas]].\n");
  });

  it("writes nothing after a second conflict, or when the mention is gone", async () => {
    const busy = memoryStore("See Atlas.\n", ["A Atlas.\n", "B Atlas.\n"]);
    const [m] = findMentions(busy.text, "Atlas");
    expect(await linkMention(busy, "Atlas", m!, link)).toBe("changed");
    expect(busy.writes).toBe(0);
    expect(busy.text).toBe("B Atlas.\n");

    const gone = memoryStore("Nothing here.\n");
    expect(await linkMention(gone, "Atlas", { start: 4, text: "Atlas", occurrence: 0 }, link)).toBe("gone");
    expect(gone.writes).toBe(0);
  });
});
