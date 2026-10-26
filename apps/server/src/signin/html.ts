import type { FastifyReply } from "fastify";

/** sign-in.md section 7: no script, no framing, no form posts, no referrer. */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/** Every interpolated value goes through this, attributes included (they are always double-quoted). */
export const escapeHtml = (value: string): string => value.replace(/[&<>"'`]/g, (c) => ESCAPES[c]!);

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}
h1{font-size:1.4rem;margin:0 0 1rem}p{margin:0 0 1rem;color:#444}
a.button{display:block;margin:.5rem 0;padding:.75rem 1rem;border:1px solid #d0d0d5;border-radius:.5rem;text-decoration:none;color:inherit;text-align:center}
a.button:hover{border-color:#e8590c}
@media (prefers-color-scheme:dark){body{background:#161618;color:#f2f2f2}p{color:#bbb}a.button{border-color:#444}}`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} - Thoth</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>
`;
}

export function sendHtml(reply: FastifyReply, status: number, html: string): FastifyReply {
  reply.code(status);
  for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) reply.header(name, value);
  reply.header("content-type", "text/html; charset=utf-8");
  return reply.send(html);
}

/** "Continue with Google / Continue with GitHub". `links` are full, already-built hrefs. */
export function chooserPage(links: { name: string; href: string }[]): string {
  const buttons = links.map((l) => `<a class="button" href="${escapeHtml(l.href)}">Continue with ${escapeHtml(l.name)}</a>`).join("\n");
  return page("Sign in to Thoth", `<p>Choose how to sign in.</p>\n${buttons}`);
}

/** A sign-in started from an invite page (ADR-0024) that cannot continue. `message` is fixed text, never request data. */
export function inviteErrorPage(title: string, message: string): string {
  return page(title, `<p>${escapeHtml(message)}</p>`);
}

/** A sign-in that cannot continue and cannot safely be sent back to the client. `message` is fixed text, never request data. */
export function errorPage(title: string, message: string): string {
  return page(title, `<p>${escapeHtml(message)}</p>\n<p>Close this window and start signing in again from the Thoth app.</p>`);
}
