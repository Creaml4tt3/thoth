import type { FastifyReply } from "fastify";
import { MARK } from "../mark.ts";

/** sign-in.md section 7: no script, no framing, no form posts, no referrer. */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/** Every interpolated value goes through this, attributes included (they are always double-quoted). */
export const escapeHtml = (value: string): string => value.replace(/[&<>"'`]/g, (c) => ESCAPES[c]!);

/** The website's look (Papyrus Black: paper in light, soft ink-black at night, Moon orange), inline only (no fetches). */
const STYLE = `*{box-sizing:border-box}html{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font:16px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",system-ui,sans-serif;-webkit-font-smoothing:antialiased;background:#fefaf3;color:#1f1b14}
main{width:100%;max-width:440px;padding:40px 36px 32px;border-radius:28px;background:#f8f0e2;border:1px solid rgb(60 45 20/.12)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:36px;font-weight:600;font-size:18px;letter-spacing:-.02em}.brand svg{width:26px;height:26px;color:#e8590c}
h1{margin:0 0 8px;font-size:34px;line-height:1.1;font-weight:600;letter-spacing:-.035em}p{margin:0 0 16px;color:#4e4638}
a.button{display:flex;align-items:center;justify-content:center;min-height:52px;margin:10px 0 0;padding:12px 24px;border-radius:999px;background:#ebe3d5;color:#1f1b14;font-weight:600;text-decoration:none;transition:background-color .18s ease}
a.button:first-of-type{background:#e8590c;color:#1f1b14}a.button:hover{background:#e2d8c6}a.button:first-of-type:hover{background:#f96927}
a.button:focus-visible{outline:2px solid #b64201;outline-offset:3px}
@media (prefers-color-scheme:dark){body{background:#0e0c0b;color:#e8e2d8}main{background:#1a1715;border-color:rgb(255 255 255/.08)}p{color:#cdc6ba}a.button{background:#2b2722;color:#e8e2d8}a.button:hover{background:#3a342a}a.button:first-of-type{color:#0e0c0b}a.button:first-of-type:hover{background:#ff8c5f}a.button:focus-visible{outline-color:#ff8c5f}}`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} - Thoth</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="brand">${MARK}<span>Thoth</span></div>
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
