// A file the system handed to a file window (ADR-0057), as the editor's PageStore: through the token only.
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import type { OpenedFiles } from "@thoth/platform";
import { openedFileStore } from "../src/features/opened/opened-store.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const failure = (code: string) => Object.assign(new Error(code), { code });

function fake(text: string): OpenedFiles & { calls: string[]; file: Uint8Array | null; copies: string[]; taken: Set<string> } {
  const files = {
    calls: [] as string[],
    file: encode(text) as Uint8Array | null,
    copies: [] as string[],
    taken: new Set<string>(),
    async stat() {
      return { name: "Note.md", folder: "Downloads", mtimeMs: 1_700_000_000_000, size: 0 };
    },
    async read(token: string) {
      files.calls.push(`read ${token}`);
      if (!files.file) throw failure("ENOENT");
      return files.file;
    },
    async write(token: string, bytes: Uint8Array, expectedHash: string) {
      files.calls.push(`write ${token} ${expectedHash.slice(0, 8)}`);
      if (!files.file || sha256Hex(files.file) !== expectedHash) throw failure("CONFLICT");
      files.file = bytes;
      return { hash: sha256Hex(bytes) };
    },
    async copy(_token: string, name: string) {
      if (files.taken.has(name)) throw failure("EEXIST");
      files.copies.push(name);
      return { name };
    },
  };
  return files;
}

describe("openedFileStore", () => {
  it("reads the file with its sha256 and writes on that hash", async () => {
    const files = fake("# Hi\n");
    const store = openedFileStore(files, "tok", "Note.md");
    const page = await store.read();
    expect(page).toMatchObject({ source: "# Hi\n", hash: sha256Hex(encode("# Hi\n")), editable: true });
    expect(page?.dates?.updated).toBe(1_700_000_000_000);
    const hash = await store.write("# Hi!\n", page!.hash);
    expect(hash).toBe(sha256Hex(encode("# Hi!\n")));
    expect(files.calls).toEqual(["read tok", `write tok ${page!.hash.slice(0, 8)}`]);
  });

  it("a stale write is a conflict", async () => {
    const files = fake("# Hi\n");
    const store = openedFileStore(files, "tok", "Note.md");
    const error = await store.write("x", "0".repeat(64)).catch((e: unknown) => e);
    expect(store.isConflict(error)).toBe(true);
    expect(store.isConflict(new Error("other"))).toBe(false);
  });

  it("a deleted file reads as missing, and is never created again", async () => {
    const files = fake("# Hi\n");
    const store = openedFileStore(files, "tok", "Note.md");
    files.file = null;
    expect(await store.read()).toBeNull();
    await expect(store.write("x", null)).rejects.toThrow();
  });

  it("not UTF-8 is read-only", async () => {
    const files = fake("");
    files.file = new Uint8Array([0xff, 0xfe, 0x41]);
    expect((await openedFileStore(files, "tok", "Note.md").read())?.editable).toBe(false);
  });

  it("keep both finds a free name next to the file", async () => {
    const files = fake("# Hi\n");
    const store = openedFileStore(files, "tok", "Note.md");
    const now = new Date(2026, 10, 26, 9, 30);
    const first = await store.writeCopy("mine", now);
    files.taken.add(first.label);
    const second = await store.writeCopy("mine", now);
    expect(second.label).not.toBe(first.label);
    expect(files.copies.every((name) => !name.includes("/") && name.endsWith(".md"))).toBe(true);
  });
});
