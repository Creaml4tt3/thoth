import { describe, expect, it } from "vitest";
import { createSessionPool } from "@thoth/app-ui/editor/session-pool.ts";
import type { EditorBridge } from "@thoth/app-ui/editor/page-session.ts";
import { createVault } from "../src/store.ts";
import { en } from "../src/vault/en.ts";
import { th } from "../src/vault/th.ts";

describe("the in-memory vault", () => {
  it("lists the sample pages with titles, and the Recipes folder", () => {
    const vault = createVault(en);
    expect(vault.summaries.map((s) => s.title).sort()).toEqual(["Book club", "Green curry", "Ideas", "Lemon cake", "Reading list", "Weekend plans"]);
    expect(vault.folders).toEqual(["Recipes"]);
    expect(createVault(th).titleOf(th.first)).toBe("แผนวันหยุด");
  });

  it("writes compare-and-swap like a file, and a stale write is a conflict", async () => {
    const store = createVault(en).storeFor("Ideas.md");
    const read = (await store.read())!;
    const hash = await store.write("# Ideas\n\nchanged\n", read.hash);
    expect((await store.read())!.source).toContain("changed");
    await expect(store.write("again", read.hash)).rejects.toSatisfy((e) => store.isConflict(e));
    expect(hash).not.toBe(read.hash);
  });

  it("gives the same store for the same page, and a fresh vault starts over", async () => {
    const vault = createVault(en);
    expect(vault.storeFor("Ideas.md")).toBe(vault.storeFor("Ideas.md"));
    const store = vault.storeFor("Ideas.md");
    await store.write("# Ideas\n\nx\n", (await store.read())!.hash);
    expect((await createVault(en).storeFor("Ideas.md").read())!.source).toBe(en.pages.find((p) => p.path === "Ideas.md")!.source);
  });

  it("keeps two editors on one key in step through the app's session pool", async () => {
    const vault = createVault(en);
    const store = vault.storeFor(en.first);
    const pool = createSessionPool({ autosaveMs: 0, now: () => new Date(), registerFlush: () => () => {}, syncMs: 0 });
    const editor = (): EditorBridge & { text: string } => {
      const e = { text: "", markdown: () => e.text, load: (s: string) => void (e.text = s), setEditable: () => undefined };
      return e;
    };
    const a = editor();
    const b = editor();
    const ma = pool.acquire("k", { store, editor: { current: a }, onWritten: () => undefined });
    const mb = pool.acquire("k", { store, editor: { current: b }, onWritten: () => undefined });
    await ma.session.save();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.text).toContain("Weekend plans");
    expect(b.text).toBe(a.text);
    a.text += "\nmore\n";
    ma.edited();
    await new Promise((r) => setTimeout(r, 10));
    expect(b.text).toContain("more");
    expect(mb.owner()).toBe(false);
    ma.release();
    mb.release();
  });
});
