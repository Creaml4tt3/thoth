/**
 * Images in pages (ADR-0028). The editor never puts an image's `src` into the DOM: it asks the page's space for the
 * bytes and shows them from a `blob:` URL. This module decides what a `src` points at and what may be loaded, and
 * names the files an added image is kept in. It has no filesystem and no network: the space is a set of functions
 * the app gives it (the desktop's vault, a workspace's authorised attachment download).
 *
 * - Private Space: a relative `src` is resolved against the page's folder, and must stay inside the vault. Absolute
 *   paths, `file:` addresses, other schemes and Thoth's own `.thoth/` folder are refused.
 * - Workspace: `thoth:attachment/<id>` (the link form transfers write) is loaded through the authorised download.
 *   A workspace page has no folder, so a relative `src` there is not found.
 * - `http(s)` images are never loaded: the editor shows their address as a link instead.
 * - Only image types (by extension, or by the attachment's stored type), at most 20 MB.
 */
import { basename, dirname, extname, isReservedPath, isSafeVaultPath, relativeLink, resolveRelative } from "@thoth/domain";

/** The largest image a page shows or accepts. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

const EXTENSION_FOR: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
};

/** The image MIME type for a file name, or null when it is not one of the image types a page shows. */
export function imageMimeType(name: string): string | null {
  return IMAGE_TYPES[extname(name)] ?? null;
}

/** True for a MIME type a page shows (a workspace attachment's stored type). */
export function isImageMimeType(type: string): boolean {
  return type.split(";")[0]!.trim().toLowerCase() in EXTENSION_FOR;
}

export type RefusedReason = "empty" | "outside" | "absolute" | "file" | "scheme" | "unsafe" | "no-folder";

/** Where an image's `src` points. */
export type ImageTarget =
  | { kind: "vault"; path: string }
  | { kind: "attachment"; id: string }
  | { kind: "remote"; url: string }
  | { kind: "refused"; reason: RefusedReason };

const ATTACHMENT_PREFIX = "thoth:attachment/";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * What `src` points at, seen from the page at vault path `page` (null: a workspace page, which has no folder).
 * Pure: nothing is read.
 */
export function resolveImageSrc(src: string, page: string | null): ImageTarget {
  const raw = src.trim();
  if (raw === "") return { kind: "refused", reason: "empty" };
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[a-z]:[\\/]/i.test(raw)) return { kind: "refused", reason: "absolute" };
  const scheme = SCHEME.exec(raw)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme === "http" || scheme === "https") {
      try {
        const url = new URL(raw);
        return url.hostname === "" ? { kind: "refused", reason: "scheme" } : { kind: "remote", url: url.href === raw ? raw : url.href };
      } catch {
        return { kind: "refused", reason: "scheme" };
      }
    }
    if (scheme === "file") return { kind: "refused", reason: "file" };
    if (raw.startsWith(ATTACHMENT_PREFIX) && UUID_V7.test(raw.slice(ATTACHMENT_PREFIX.length))) return { kind: "attachment", id: raw.slice(ATTACHMENT_PREFIX.length) };
    return { kind: "refused", reason: "scheme" };
  }
  // A local file: the query and fragment are not part of its name.
  const bare = raw.replace(/[?#].*$/s, "");
  const segments: string[] = [];
  for (const segment of bare.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return { kind: "refused", reason: "unsafe" };
    }
    // An escaped separator would name another path than the one written.
    if (/[/\\\u0000]/.test(decoded)) return { kind: "refused", reason: "unsafe" };
    segments.push(decoded);
  }
  if (page === null) return { kind: "refused", reason: "no-folder" };
  const path = resolveRelative(page, segments.join("/"));
  if (path === undefined) return { kind: "refused", reason: "outside" };
  if (!isSafeVaultPath(path) || isReservedPath(path)) return { kind: "refused", reason: "unsafe" };
  return { kind: "vault", path };
}

/** What a page's space did with an image's `src`. */
export type ImageLoad =
  | { state: "ready"; bytes: Uint8Array; mimeType: string }
  | { state: "remote"; url: string }
  | { state: "missing" | "refused" | "not-image" | "too-large" | "unreadable" };

/** A file to add to a page: from the picker, a paste or a drop. */
export interface ImageFile {
  name: string;
  bytes: Uint8Array;
  /** The type the browser or the picker reported, used when the name has no extension. */
  type?: string;
}

/** What a page's space offers for its images. */
export interface PageMedia {
  load(src: string): Promise<ImageLoad>;
  /** Keeps `file` for this page and returns how the page refers to it. Absent: the space cannot take files. */
  add?(file: ImageFile): Promise<{ src: string; alt: string }>;
}

/** The Private Space's files as the image code needs them; paths are vault paths. */
export interface ImageSpace {
  /** The file's size, or undefined when there is no such file. */
  size(path: string): Promise<number | undefined>;
  read(path: string): Promise<Uint8Array>;
  /** Creates the file; false when a file of that name is already there (it is never replaced). */
  create(path: string, bytes: Uint8Array): Promise<boolean>;
}

/** The `accept` list of a file input for images. */
export const IMAGE_ACCEPT = [...Object.keys(IMAGE_TYPES), ...new Set(Object.values(IMAGE_TYPES))].join(",");

/**
 * The browser's own file picker for one image (the web client, ADR-0028). Null when cancelled. A file over the cap
 * is refused before it is read.
 */
export function pickImageWithInput(doc: Document = document): Promise<ImageFile | null> {
  return new Promise((resolve, reject) => {
    const input = doc.createElement("input");
    input.type = "file";
    input.accept = IMAGE_ACCEPT;
    input.hidden = true;
    let settled = false;
    const done = (value: ImageFile | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      input.remove();
      if (error) reject(error);
      else resolve(value);
    };
    input.addEventListener("cancel", () => done(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return done(null);
      if (file.size > MAX_IMAGE_BYTES) return done(null, new ImageRejectedError("too-large", "The image is larger than 20 MB."));
      file.arrayBuffer().then(
        (buffer) => done({ name: file.name, bytes: new Uint8Array(buffer), type: file.type }),
        (error: unknown) => done(null, error),
      );
    });
    doc.body.append(input);
    input.click();
  });
}

/** Loads the image `src` of the page at `page` from a Private Space. */
export async function loadPageImage(space: ImageSpace, page: string, src: string): Promise<ImageLoad> {
  const target = resolveImageSrc(src, page);
  if (target.kind === "remote") return { state: "remote", url: target.url };
  if (target.kind !== "vault") return { state: target.kind === "refused" && target.reason === "no-folder" ? "missing" : "refused" };
  const mimeType = imageMimeType(target.path);
  if (!mimeType) return { state: "not-image" };
  let size: number | undefined;
  try {
    size = await space.size(target.path);
  } catch {
    return { state: "unreadable" };
  }
  if (size === undefined) return { state: "missing" };
  if (size > MAX_IMAGE_BYTES) return { state: "too-large" };
  try {
    const bytes = await space.read(target.path);
    if (bytes.length > MAX_IMAGE_BYTES) return { state: "too-large" };
    return { state: "ready", bytes, mimeType };
  } catch (error) {
    return { state: (error as { code?: unknown }).code === "ENOENT" ? "missing" : "unreadable" };
  }
}

/** An image the user tried to add that a page cannot take. */
export class ImageRejectedError extends Error {
  readonly reason: "not-image" | "too-large";
  constructor(reason: "not-image" | "too-large", message: string) {
    super(message);
    this.name = "ImageRejectedError";
    this.reason = reason;
  }
}

/** Checks a file to add and gives the name it is kept under (a plain file name, an image extension). */
export function imageFileName(file: ImageFile): string {
  if (file.bytes.length > MAX_IMAGE_BYTES) throw new ImageRejectedError("too-large", "The image is larger than 20 MB.");
  // Only the last part of whatever the name says, without characters a file name cannot hold.
  let name = basename(file.name.replace(/\\/g, "/"))
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "-")
    .trim();
  if (name === "" || name.startsWith(".") || isReservedPath(name)) name = "";
  const fromType = file.type ? EXTENSION_FOR[file.type.split(";")[0]!.trim().toLowerCase()] : undefined;
  if (name === "") {
    if (!fromType) throw new ImageRejectedError("not-image", "This file is not an image a page can show.");
    return `image${fromType}`;
  }
  if (imageMimeType(name)) return name;
  if (extname(name) === "" && fromType) return `${name}${fromType}`;
  throw new ImageRejectedError("not-image", "This file is not an image a page can show.");
}

/** How a page at `page` refers to the vault file `path`: a relative link, escaped so Markdown reads it back. */
export function imageSrcFor(page: string, path: string): string {
  return relativeLink(page, path)
    .split("/")
    .map((segment) => segment.replace(/[%\s()<>#?\\[\]]/gu, (ch) => (encodeURIComponent(ch) === ch ? `%${ch.charCodeAt(0).toString(16).toUpperCase()}` : encodeURIComponent(ch))))
    .join("/");
}

/** Alt text from a file name: the name without its extension, `-` and `_` read as spaces. */
export function altFromFileName(name: string): string {
  const stem = basename(name).replace(/\.[^.]+$/, "");
  return stem.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Copies `file` next to the page at `page` under its own name; when that name is taken, the first free one of
 * `name-2.png`, `name-3.png` … (a file is never replaced). Returns the `src` to write and an alt text.
 */
export async function addPageImage(space: ImageSpace, page: string, file: ImageFile): Promise<{ src: string; path: string; alt: string }> {
  const name = imageFileName(file);
  const dir = dirname(page);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = [name.slice(0, dot), name.slice(dot)];
  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    const path = dir === "" ? candidate : `${dir}/${candidate}`;
    if (await space.create(path, file.bytes)) return { src: imageSrcFor(page, path), path, alt: altFromFileName(name) };
  }
  throw new Error("Could not find a free name for the image.");
}
