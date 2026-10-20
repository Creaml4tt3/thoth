import { describe, expect, it } from "vitest";
import {
  collisionKey,
  isStableId,
  newStableId,
  normalizeVaultPath,
  provisionalPageId,
  relativeLink,
  resolveRelative,
  sha256Hex,
  UnsafePathError,
} from "../src/index.ts";

describe("ids", () => {
  it("generates time-ordered UUIDv7 values", () => {
    const a = newStableId(1_700_000_000_000);
    const b = newStableId(1_700_000_000_001);
    expect(isStableId(a)).toBe(true);
    expect(a < b).toBe(true);
  });

  it("derives provisional IDs deterministically from the normalized path", () => {
    const nfd = "Notes/cafe\u0301.md";
    const nfc = "Notes/café.md";
    expect(provisionalPageId(nfd)).toBe(provisionalPageId(nfc));
    expect(provisionalPageId("a.md")).toMatch(/^local:[0-9a-f]{32}$/);
  });
});

describe("paths", () => {
  it.each([
    ["../escape.md", "parent directory segment"],
    ["a/../../b.md", "parent directory segment"],
    ["/etc/passwd", "absolute path"],
    ["C:/Windows", "drive letter"],
    ["a\\..\\b", "backslash separator"],
    ["a\0b", "NUL byte"],
  ])("rejects %j", (raw, reason) => {
    expect(() => normalizeVaultPath(raw)).toThrow(UnsafePathError);
    expect(() => normalizeVaultPath(raw)).toThrow(reason);
  });

  it("normalizes to NFC and strips empty segments", () => {
    expect(normalizeVaultPath("./A//b/cafe\u0301.md")).toBe("A/b/café.md");
  });

  it("keeps Thai and emoji names", () => {
    expect(normalizeVaultPath("บันทึก/🚀 แผน.md")).toBe("บันทึก/🚀 แผน.md");
  });

  it("computes case-insensitive collision keys", () => {
    expect(collisionKey("Notes/Readme.md")).toBe(collisionKey("notes/README.md"));
  });

  it("resolves and relativizes links", () => {
    expect(resolveRelative("a/b/c.md", "../d/e.md")).toBe("a/d/e.md");
    expect(resolveRelative("a.md", "../x.md")).toBeUndefined();
    expect(relativeLink("a/b/c.md", "a/d/e.md")).toBe("../d/e.md");
    expect(relativeLink("c.md", "a/e.md")).toBe("a/e.md");
    expect(relativeLink("a/c.md", "a/e.md")).toBe("e.md");
  });
});

describe("hash", () => {
  it("hashes strings and bytes identically", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });
});
