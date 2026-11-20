// The Board's undo history: the order of undo and redo, redo cleared by a new action, and awaited, one at a time.
import { describe, expect, it } from "vitest";
import { createHistory } from "../src/board/history.ts";

const log: string[] = [];
const entry = (name: string) => ({ undo: () => void log.push(`undo ${name}`), redo: () => void log.push(`redo ${name}`) });

describe("createHistory", () => {
  it("undoes newest first and redoes in the original order", async () => {
    log.length = 0;
    const h = createHistory();
    expect(h.canUndo()).toBe(false);
    await h.undo(); // nothing to undo: no-op
    h.push(entry("a"));
    h.push(entry("b"));
    await h.undo();
    await h.undo();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);
    await h.redo();
    await h.redo();
    await h.redo(); // nothing left
    expect(log).toEqual(["undo b", "undo a", "redo a", "redo b"]);
  });

  it("a new action clears redo", async () => {
    log.length = 0;
    const h = createHistory();
    h.push(entry("a"));
    await h.undo();
    expect(h.canRedo()).toBe(true);
    h.push(entry("b"));
    expect(h.canRedo()).toBe(false);
    await h.redo();
    expect(log).toEqual(["undo a"]);
  });

  it("awaits each step and runs repeated calls one after another (key repeat)", async () => {
    const seen: string[] = [];
    const h = createHistory();
    const slow = (name: string) => ({
      undo: async () => {
        seen.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 5));
        seen.push(`end ${name}`);
      },
      redo() {},
    });
    h.push(slow("a"));
    h.push(slow("b"));
    await Promise.all([h.undo(), h.undo()]);
    expect(seen).toEqual(["start b", "end b", "start a", "end a"]);
  });

  it("a step that fails stays where it was and the next call still runs", async () => {
    const h = createHistory();
    let fail = true;
    h.push({
      undo: () => {
        if (fail) throw new Error("disk");
      },
      redo() {},
    });
    await expect(h.undo()).rejects.toThrow("disk");
    expect(h.canUndo()).toBe(true);
    fail = false;
    await h.undo();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);
  });
});

describe("createHistory, a push while a step is in flight", () => {
  it("keeps the new entry undoable and still moves the stepped entry to redo", async () => {
    const seen: string[] = [];
    const h = createHistory();
    let release!: () => void;
    h.push({ undo: () => new Promise<void>((r) => (release = () => { seen.push("undo a"); r(); })), redo: () => void seen.push("redo a") });
    const undoing = h.undo();
    await Promise.resolve();
    await Promise.resolve();
    h.push({ undo: () => void seen.push("undo b"), redo: () => void seen.push("redo b") });
    release();
    await undoing;
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(true);
    await h.undo();
    expect(seen).toEqual(["undo a", "undo b"]);
    await h.redo();
    await h.redo();
    expect(seen).toEqual(["undo a", "undo b", "redo b", "redo a"]);
  });
});
