/**
 * How a shared attachment is sent (ADR-0023 rule 5). Raster images the page shows are `inline`; everything else,
 * SVG included (it can carry script), is a download. The bytes keep their stored Content-Type either way, with
 * `nosniff` and a sandbox CSP, so a browser never renders them as a page of the server's origin.
 */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export function inlineImageType(mime: string): boolean {
  return INLINE_IMAGE_TYPES.has(mime);
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
