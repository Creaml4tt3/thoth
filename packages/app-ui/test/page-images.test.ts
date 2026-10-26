/**
 * Images in pages (ADR-0028): where an image's `src` points, what may be loaded, and how an added image is named.
 * The space is a set of plain functions here; the desktop and web wiring is tested in the apps.
 */
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, addPageImage, imageMimeType, imageSrcFor, loadPageImage, resolveImageSrc, type ImageSpace } from "../src/editor/media.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("resolveImageSrc", () => {
  it("resolves a relative src against the page's own folder", () => {
    expect(resolveImageSrc("bird-uric-acid.svg", "Birds/Uric acid.md")).toEqual({ kind: "vault", path: "Birds/bird-uric-acid.svg" });
    expect(resolveImageSrc("./img/a.png", "Notes.md")).toEqual({ kind: "vault", path: "img/a.png" });
  });

  it("follows `..` while it stays inside the vault, and refuses it once it leaves", () => {
    expect(resolveImageSrc("../attachments/0f3a/photo.png", "Notion/Page.md")).toEqual({ kind: "vault", path: "attachments/0f3a/photo.png" });
    expect(resolveImageSrc("../photo.png", "Page.md")).toEqual({ kind: "refused", reason: "outside" });
    expect(resolveImageSrc("a/../../../etc/passwd.png", "x/Page.md")).toEqual({ kind: "refused", reason: "outside" });
  });

  it("decodes %20 and other escapes, and ignores a query or fragment", () => {
    expect(resolveImageSrc("my%20photo.png", "Notes.md")).toEqual({ kind: "vault", path: "my photo.png" });
    expect(resolveImageSrc("caf%C3%A9.png?v=2#x", "Notes.md")).toEqual({ kind: "vault", path: "café.png" });
    // An escaped slash or backslash would make another path than the one written: refused.
    expect(resolveImageSrc("..%2F..%2Fsecret.png", "a/Notes.md")).toEqual({ kind: "refused", reason: "unsafe" });
    expect(resolveImageSrc("a%5Cb.png", "Notes.md")).toEqual({ kind: "refused", reason: "unsafe" });
    expect(resolveImageSrc("bad%E0%A4%A.png", "Notes.md")).toEqual({ kind: "refused", reason: "unsafe" });
  });

  it("refuses absolute paths, file: addresses, other schemes and Thoth's own folder", () => {
    expect(resolveImageSrc("/Users/me/photo.png", "Notes.md")).toEqual({ kind: "refused", reason: "absolute" });
    expect(resolveImageSrc("//host/share/photo.png", "Notes.md")).toEqual({ kind: "refused", reason: "absolute" });
    expect(resolveImageSrc("C:\\photos\\a.png", "Notes.md")).toEqual({ kind: "refused", reason: "absolute" });
    expect(resolveImageSrc("file:///etc/hosts", "Notes.md")).toEqual({ kind: "refused", reason: "file" });
    expect(resolveImageSrc("FILE:/x.png", "Notes.md")).toEqual({ kind: "refused", reason: "file" });
    expect(resolveImageSrc("javascript:alert(1)", "Notes.md")).toEqual({ kind: "refused", reason: "scheme" });
    expect(resolveImageSrc("data:image/svg+xml,<svg/>", "Notes.md")).toEqual({ kind: "refused", reason: "scheme" });
    expect(resolveImageSrc(".thoth/index.sqlite", "Notes.md")).toEqual({ kind: "refused", reason: "unsafe" });
    expect(resolveImageSrc("", "Notes.md")).toEqual({ kind: "refused", reason: "empty" });
  });

  it("keeps remote addresses as addresses (they are never fetched)", () => {
    expect(resolveImageSrc("https://example.com/a.png", "Notes.md")).toEqual({ kind: "remote", url: "https://example.com/a.png" });
    expect(resolveImageSrc("http://example.com/a.png", null)).toEqual({ kind: "remote", url: "http://example.com/a.png" });
  });

  it("reads the workspace attachment link form, and has no folder for a relative src in a workspace page", () => {
    const id = "01920000-0000-7000-8000-000000000001";
    expect(resolveImageSrc(`thoth:attachment/${id}`, null)).toEqual({ kind: "attachment", id });
    expect(resolveImageSrc("thoth:attachment/not-an-id", null)).toEqual({ kind: "refused", reason: "scheme" });
    expect(resolveImageSrc("photo.png", null)).toEqual({ kind: "refused", reason: "no-folder" });
  });
});

describe("imageMimeType", () => {
  it("knows image types only, by extension", () => {
    expect(imageMimeType("a.PNG")).toBe("image/png");
    expect(imageMimeType("a.jpeg")).toBe("image/jpeg");
    expect(imageMimeType("a.svg")).toBe("image/svg+xml");
    expect(imageMimeType("favicon.ico")).toBe("image/x-icon");
    for (const ext of ["gif", "webp", "avif", "bmp", "jpg"]) expect(imageMimeType(`a.${ext}`)).toMatch(/^image\//);
    expect(imageMimeType("page.html")).toBeNull();
    expect(imageMimeType("notes.pdf")).toBeNull();
    expect(imageMimeType("noext")).toBeNull();
  });
});

/** An in-memory space: paths to bytes, with a log of what was read. */
function memorySpace(files: Record<string, Uint8Array> = {}): ImageSpace & { files: Map<string, Uint8Array>; reads: string[] } {
  const map = new Map(Object.entries(files));
  const reads: string[] = [];
  return {
    files: map,
    reads,
    async size(path) {
      return map.get(path)?.length;
    },
    async read(path) {
      reads.push(path);
      const bytes = map.get(path);
      if (!bytes) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return bytes;
    },
    async create(path, bytes) {
      if ([...map.keys()].some((k) => k.toLowerCase() === path.toLowerCase())) return false;
      map.set(path, bytes);
      return true;
    },
  };
}

describe("loadPageImage", () => {
  it("returns the bytes and the MIME type of an image next to the page", async () => {
    const space = memorySpace({ "Birds/bird.svg": new TextEncoder().encode("<svg/>"), "Birds/a.png": PNG });
    expect(await loadPageImage(space, "Birds/Page.md", "bird.svg")).toEqual({ state: "ready", bytes: new TextEncoder().encode("<svg/>"), mimeType: "image/svg+xml" });
    expect(await loadPageImage(space, "Birds/Page.md", "a.png")).toMatchObject({ state: "ready", mimeType: "image/png" });
  });

  it("says missing for a file that is not there, and never reads outside the rules", async () => {
    const space = memorySpace({ "secret.png": PNG });
    expect(await loadPageImage(space, "Page.md", "gone.png")).toEqual({ state: "missing" });
    expect(await loadPageImage(space, "a/Page.md", "../../secret.png")).toEqual({ state: "refused" });
    expect(await loadPageImage(space, "Page.md", "/secret.png")).toEqual({ state: "refused" });
    expect(await loadPageImage(space, "Page.md", "file:///secret.png")).toEqual({ state: "refused" });
    expect(space.reads).toEqual([]);
  });

  it("does not fetch a remote image", async () => {
    const space = memorySpace();
    expect(await loadPageImage(space, "Page.md", "https://example.com/a.png")).toEqual({ state: "remote", url: "https://example.com/a.png" });
    expect(space.reads).toEqual([]);
  });

  it("refuses files that are not images, and images over the size cap, without reading them", async () => {
    const space = memorySpace({ "page.html": new Uint8Array([60]), "big.png": new Uint8Array(MAX_IMAGE_BYTES + 1), "ok.png": new Uint8Array(MAX_IMAGE_BYTES) });
    expect(await loadPageImage(space, "Page.md", "page.html")).toEqual({ state: "not-image" });
    expect(await loadPageImage(space, "Page.md", "big.png")).toEqual({ state: "too-large" });
    expect(space.reads).toEqual([]);
    expect(await loadPageImage(space, "Page.md", "ok.png")).toMatchObject({ state: "ready" });
  });

  it("says unreadable when the read fails for another reason", async () => {
    const space = memorySpace({ "a.png": PNG });
    space.read = async () => {
      throw new Error("EACCES");
    };
    expect(await loadPageImage(space, "Page.md", "a.png")).toEqual({ state: "unreadable" });
  });
});

describe("addPageImage", () => {
  it("copies the file next to the page under its own name and returns a relative src", async () => {
    const space = memorySpace();
    expect(await addPageImage(space, "Birds/Page.md", { name: "bird.png", bytes: PNG })).toEqual({ src: "bird.png", path: "Birds/bird.png", alt: "bird" });
    expect(space.files.get("Birds/bird.png")).toEqual(PNG);
  });

  it("never replaces a file: the next free name is name-2, name-3 …", async () => {
    const space = memorySpace({ "bird.png": PNG, "Bird-2.png": PNG });
    const added = await addPageImage(space, "Page.md", { name: "bird.png", bytes: new Uint8Array([1]) });
    expect(added).toEqual({ src: "bird-3.png", path: "bird-3.png", alt: "bird" });
    expect(space.files.get("bird.png")).toEqual(PNG);
  });

  it("writes an escaped src for names Markdown cannot hold bare, and a readable alt text", async () => {
    const space = memorySpace();
    const added = await addPageImage(space, "Page.md", { name: "my photo (1)_final.jpeg", bytes: PNG });
    expect(added.path).toBe("my photo (1)_final.jpeg");
    expect(added.src).toBe("my%20photo%20%281%29_final.jpeg");
    expect(added.alt).toBe("my photo (1) final");
    // The src written resolves back to the file.
    expect(resolveImageSrc(added.src, "Page.md")).toEqual({ kind: "vault", path: "my photo (1)_final.jpeg" });
  });

  it("refuses a file that is not an image or is over the cap, and a name that is not a plain file name", async () => {
    const space = memorySpace();
    await expect(addPageImage(space, "Page.md", { name: "page.html", bytes: PNG })).rejects.toThrow(/not an image/i);
    await expect(addPageImage(space, "Page.md", { name: "big.png", bytes: new Uint8Array(MAX_IMAGE_BYTES + 1) })).rejects.toThrow(/20 MB/);
    const odd = await addPageImage(space, "Page.md", { name: "../../evil.png", bytes: PNG });
    expect(odd.path).toBe("evil.png");
    const hidden = await addPageImage(space, "Page.md", { name: ".thoth", bytes: PNG, type: "image/png" });
    expect(hidden.path).toBe("image.png");
    expect(space.files.size).toBe(2);
  });

  it("names a pasted image without a name from its type", async () => {
    const space = memorySpace();
    expect((await addPageImage(space, "Page.md", { name: "", bytes: PNG, type: "image/png" })).path).toBe("image.png");
    expect((await addPageImage(space, "Page.md", { name: "image.png", bytes: PNG, type: "image/png" })).path).toBe("image-2.png");
  });
});

describe("imageSrcFor", () => {
  it("is the relative link from the page, escaped", () => {
    expect(imageSrcFor("a/b/Page.md", "a/img/x y.png")).toBe("../img/x%20y.png");
    expect(imageSrcFor("Page.md", "pic#1.png")).toBe("pic%231.png");
  });
});
