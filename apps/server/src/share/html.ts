import { escapeHtml as esc } from "../signin/html.ts";
import { MARK } from "../mark.ts";

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
