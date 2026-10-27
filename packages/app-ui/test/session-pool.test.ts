// One page session per page per window (ADR-0030 rule 10): two editors on one page save once, with no conflict.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorBridge, PageStore } from "../src/editor/page-session.ts";
import { createSessionPool, type SessionPool } from "../src/editor/session-pool.ts";

class Conflict extends Error {}

/** A page in memory with compare-and-swap writes, like a file. */
function memoryStore(initial: string) {
  let source = initial;
  let version = 1;
  const writes: string[] = [];
  const store: PageStore = {
    kind: "file",
    read: async () => ({ source, hash: `h${version}`, editable: true }),
    write: async (next, expected) => {
      if (expected !== `h${version}`) throw new Conflict("stale");
      source = next;
      version += 1;
      writes.push(next);
      return `h${version}`;
    },
    writeCopy: async () => ({ ref: "copy", label: "copy" }),
    isConflict: (e) => e instanceof Conflict,
  };
  return {
    store,
    writes,
    disk: () => source,
    /** Someone else changes the file. */
    change(next: string) {
      source = next;
      version += 1;
    },
  };
}

function fakeEditor(): EditorBridge & { text: string; loads: number; editable: boolean } {
  const ed = {
    text: "",
    loads: 0,
    editable: true,
    markdown: () => ed.text,
    load(s: string) {
      ed.text = s;
      ed.loads += 1;
    },
    setEditable(e: boolean) {
      ed.editable = e;
    },
  };
  return ed;
}

let flushers: Set<() => Promise<boolean>>;
let pool: SessionPool;
const flushAll = async () => (await Promise.all([...flushers].map((f) => f()))).every(Boolean);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  flushers = new Set();
  pool = createSessionPool({
    autosaveMs: 0,
    now: () => new Date(0),
    syncMs: 20,
    registerFlush: (f) => {
      flushers.add(f);
      return () => void flushers.delete(f);
    },
  });
});
afterEach(() => vi.useRealTimers());

async function twoEditors(text = "# A\n") {
  const page = memoryStore(text);
  const a = fakeEditor();
  const b = fakeEditor();
  const ma = pool.acquire("file\nroot\nA.md", { store: page.store, editor: { current: a }, onWritten: () => undefined });
  await settle();
  const mb = pool.acquire("file\nroot\nA.md", { store: page.store, editor: { current: b }, onWritten: () => undefined });
  await settle();
  return { page, a, b, ma, mb };
}

describe("two editors on one page", () => {
  it("share one session, and the second starts with the page", async () => {
    const { a, b, ma, mb } = await twoEditors();
    expect(mb.session).toBe(ma.session);
    expect(a.text).toBe("# A\n");
    expect(b.text).toBe("# A\n");
    expect(flushers.size).toBe(1);
    expect(pool.size()).toBe(1);
  });

  it("an edit in one reaches the other, and is saved once, with no conflict", async () => {
    const { page, a, b, ma, mb } = await twoEditors();
    a.text = "# A\n\nfrom the left\n";
    ma.edited();
    await new Promise((r) => setTimeout(r, 40));
    expect(b.text).toBe(a.text);
    // Then the right one is edited, after it got focus.
    mb.focused();
    b.text = "# A\n\nfrom the left\n\nand the right\n";
    mb.edited();
    expect(await flushAll()).toBe(true);
    expect(page.writes).toEqual(["# A\n\nfrom the left\n\nand the right\n"]);
    expect(ma.session.getState().conflict).toBeNull();
    // A second flush writes nothing more.
    expect(await flushAll()).toBe(true);
    expect(page.writes.length).toBe(1);
  });

  it("focus brings the other's last edit at once, before the delay", async () => {
    const { a, b, ma, mb } = await twoEditors();
    a.text = "# A\n\ntyped\n";
    ma.edited();
    mb.focused();
    expect(b.text).toBe("# A\n\ntyped\n");
    expect(mb.owner()).toBe(true);
    expect(ma.owner()).toBe(false);
  });

  it("a change on disk reaches both editors", async () => {
    const { page, a, b, ma } = await twoEditors();
    page.change("# A\n\nchanged elsewhere\n");
    await ma.session.checkDisk();
    expect(a.text).toBe("# A\n\nchanged elsewhere\n");
    expect(b.text).toBe("# A\n\nchanged elsewhere\n");
    expect(ma.session.getState().conflict).toBeNull();
  });

  it("only one of them shows the conflict dialog", async () => {
    const { page, a, ma, mb } = await twoEditors();
    a.text = "# A\n\nmine\n";
    ma.edited();
    page.change("# A\n\ntheirs\n");
    await ma.session.checkDisk();
    expect(ma.session.getState().conflict).not.toBeNull();
    expect([ma.owner(), mb.owner()]).toEqual([true, false]);
  });

  it("an editor that leaves with an edit gives it to the other, which saves it", async () => {
    const { page, a, b, ma } = await twoEditors();
    a.text = "# A\n\nlast words\n";
    ma.edited();
    ma.release();
    expect(b.text).toBe("# A\n\nlast words\n");
    expect(await flushAll()).toBe(true);
    expect(page.writes).toEqual(["# A\n\nlast words\n"]);
  });
});

describe("the last editor", () => {
  it("leaving flushes what it showed and lets the session go", async () => {
    const page = memoryStore("# A\n");
    const a = fakeEditor();
    const ma = pool.acquire("k", { store: page.store, editor: { current: a }, onWritten: () => undefined });
    await settle();
    a.text = "# A\n\nedited\n";
    ma.edited();
    ma.release();
    a.text = "gone"; // the editor is torn down after this; what it showed was read at once
    await settle();
    await settle();
    expect(page.writes).toEqual(["# A\n\nedited\n"]);
    expect(pool.size()).toBe(0);
    expect(flushers.size).toBe(0);
  });

  it("an editor that comes back before that flush ends joins the session with the text", async () => {
    const page = memoryStore("# A\n");
    const a = fakeEditor();
    const ma = pool.acquire("k", { store: page.store, editor: { current: a }, onWritten: () => undefined });
    await settle();
    a.text = "# A\n\nedited\n";
    ma.edited();
    ma.release();
    const b = fakeEditor();
    const mb = pool.acquire("k", { store: page.store, editor: { current: b }, onWritten: () => undefined });
    expect(mb.session).toBe(ma.session);
    expect(b.text).toBe("# A\n\nedited\n");
    await settle();
    await settle();
    expect(page.writes).toEqual(["# A\n\nedited\n"]);
    // Typing on: the next save is on the hash that flush wrote, so no conflict.
    b.text = "# A\n\nedited\n\nmore\n";
    mb.edited();
    expect(await flushAll()).toBe(true);
    expect(page.writes.at(-1)).toBe("# A\n\nedited\n\nmore\n");
    expect(mb.session.getState().conflict).toBeNull();
    expect(pool.size()).toBe(1);
  });

  it("different pages have different sessions", async () => {
    const one = memoryStore("# A\n");
    const two = memoryStore("# B\n");
    const ma = pool.acquire("a", { store: one.store, editor: { current: fakeEditor() }, onWritten: () => undefined });
    const mb = pool.acquire("b", { store: two.store, editor: { current: fakeEditor() }, onWritten: () => undefined });
    expect(ma.session).not.toBe(mb.session);
    expect(flushers.size).toBe(2);
  });
});
