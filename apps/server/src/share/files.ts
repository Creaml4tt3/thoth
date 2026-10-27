import { SHARE_FILE_HEADERS } from "./html.ts";

/**
 * How a shared attachment is sent (ADR-0023 rule 5, amended 2026-10-28). Images the page shows are `inline`: the
 * raster types and SVG. An SVG is shown only through `<img>`, where a browser runs none of its script and loads
 * nothing outside it; opened on its own it gets a CSP with `sandbox` (no `allow-scripts`, an opaque origin) and
 * `default-src 'none'` (only its inline styles apply). Everything else is a download. The bytes keep their stored
 * Content-Type, with `nosniff` and a sandbox CSP, so a browser never renders them as a page of the server's origin.
 */
const SVG = "image/svg+xml";
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", SVG]);
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export function inlineImageType(mime: string): boolean {
  return INLINE_IMAGE_TYPES.has(mime);
}

/** The headers of an attachment response, but its length and disposition. */
export function fileHeaders(mime: string): Record<string, string> {
  return { ...SHARE_FILE_HEADERS, "content-type": mime, ...(mime === SVG ? { "content-security-policy": SVG_CSP } : {}) };
}

/**
 * `inline` or `attachment`, with the file name both as a plain ASCII fallback (quotes, backslashes, control and
 * non-ASCII characters become `_`) and as RFC 5987 `filename*` (percent-encoded UTF-8). Nothing in the name can end
 * the quoted string or the header line.
 */
export function contentDisposition(kind: "inline" | "attachment", fileName: string | null | undefined): string {
  if (!fileName) return kind;
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
