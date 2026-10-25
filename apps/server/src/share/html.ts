import { escapeHtml as esc } from "../signin/html.ts";

/**
 * The shared page's HTML shell (ADR-0023 rule 5). No script anywhere; the only stylesheet and fonts are the server's
 * own (`/assets/share/`). Nothing about the workspace, its members or pages outside the shared subtree is written.
 */

/** No script at all: there is no script-src, so the default `'none'` applies. */
export const SHARE_CSP = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Headers on every share response, the 404 and the 429 included. */
export const SHARE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": SHARE_CSP,
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

/** Attachment bytes: never rendered as a page of this origin, never embedded elsewhere. */
export const SHARE_FILE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "sandbox; default-src 'none'",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

/** The Moon Ibis mark (design/brand/mark.svg), inline: an SVG element, not a script and not a fetch. */
const MARK = `<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false"><defs><mask id="thoth-mark"><circle cx="256" cy="256" r="224" fill="#fff"/><path d="M430.4 396.5 C428.9 354.3 390.7 304.0 360.1 276.3 C336.9 255.6 310.3 238.4 282.4 224.9 C275.6 221.6 268.9 218.3 261.9 215.5 C255.8 213.1 246.8 210.9 241.4 207.6 C235.6 204.0 229.6 194.5 224.4 189.4 C212.6 178.1 198.3 169.9 182.3 166.5 C141.0 157.8 101.4 183.0 87.4 222.0 C84.0 231.5 82.6 241.3 82.1 251.4 C80.8 277.6 91.8 303.3 105.0 325.3 C112.3 337.6 120.6 349.4 127.2 362.1 C137.1 381.0 142.3 405.1 132.1 425.0 C129.8 429.3 126.8 433.0 123.6 436.7 L118.9 443.1 A232 232 0 0 0 198.8 480.8 L200.8 473.1 C201.3 466.6 201.9 460.1 201.7 453.6 C200.5 425.6 190.0 397.9 176.0 373.9 C171.9 366.8 167.8 359.8 163.6 352.8 C151.8 333.7 138.3 313.2 140.8 289.7 C142.8 270.2 159.5 257.2 177.8 253.6 C188.5 251.5 200.0 252.0 210.8 252.8 C275.3 257.5 330.2 282.6 376.4 328.0 C403.0 354.2 406.5 372.3 430.4 396.5Z" fill="#000"/><path d="M195.4 210.3 A11.4 11.4 0 1 1 172.6 210.3 A11.4 11.4 0 1 1 195.4 210.3Z" fill="#fff"/></mask></defs><circle cx="256" cy="256" r="224" fill="currentColor" mask="url(#thoth-mark)"/></svg>`;

function shell(title: string, bar: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/share/share.css">
</head>
<body>
<header class="bar">${bar}</header>
${main}
</body>
</html>
`;
}

export interface SharedPageView {
  title: string;
  /** Address of the shared page (the root of the link). */
  home: string;
  /** From the shared page down to the parent of this one; empty on the shared page itself. */
  crumbs: { href: string; title: string }[];
  /** Rendered, already-safe body HTML. */
  body: string;
  opensWithTitle: boolean;
  updatedAt: Date;
  children: { href: string; title: string }[];
}

const UNTITLED = "Untitled";

export function sharedPageHtml(view: SharedPageView): string {
  const title = view.title.trim() || UNTITLED;
  const bar = `<a class="brand" href="${esc(view.home)}">${MARK}<span>Thoth</span></a><span class="badge">Shared page · read-only</span>`;
  const crumbs =
    view.crumbs.length === 0
      ? ""
      : `<nav class="crumbs" aria-label="Breadcrumb"><ol>${view.crumbs.map((c) => `<li><a href="${esc(c.href)}">${esc(c.title.trim() || UNTITLED)}</a></li>`).join("")}</ol></nav>\n`;
  const heading = view.opensWithTitle ? "" : `<h1 class="title">${esc(title)}</h1>\n`;
  const day = view.updatedAt.toISOString().slice(0, 10);
  const pages =
    view.children.length === 0
      ? ""
      : `<nav class="pages" aria-labelledby="pages-inside"><h2 id="pages-inside">Pages inside</h2><ul>\n${view.children.map((c) => `<li><a href="${esc(c.href)}">${esc(c.title.trim() || UNTITLED)}</a></li>`).join("\n")}\n</ul></nav>\n`;
  const main = `<main>
${crumbs}<article>
${heading}${view.body}</article>
<p class="updated">Updated <time datetime="${day}">${day}</time></p>
${pages}</main>
<footer><p>A read-only page shared from Thoth. Whoever has this address can read it.</p></footer>`;
  return shell(title, bar, main);
}

const plainBar = `<span class="brand">${MARK}<span>Thoth</span></span>`;

/** The one answer to every share address that does not work: unknown, expired, revoked, out of scope or switched off. */
export const NOT_FOUND_HTML = shell("Page not found", plainBar, `<main class="missing">
<h1>This page is not available</h1>
<p>The link may be mistyped, may have expired, or may have been turned off by the people who shared it.</p>
</main>`);

export const TOO_MANY_HTML = shell("Too many requests", plainBar, `<main class="missing">
<h1>Too many requests</h1>
<p>This page was opened too often in a short time. Wait a little and try again.</p>
</main>`);
