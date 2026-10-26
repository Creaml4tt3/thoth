import { escapeHtml as esc } from "../signin/html.ts";
import { MARK } from "../share/html.ts";

/**
 * The invite pages (ADR-0024 rule 3): plain HTML, no script anywhere, the share pages' stylesheet and fonts, light and
 * dark by `prefers-color-scheme`, readable on a phone, in English or Thai. Before sign-in a page names only the
 * workspace, the inviter's display name and the role. Every interpolated value is escaped.
 */

/** The share pages' CSP (ADR-0023) with one change: the join form posts to this origin. */
export const INVITE_CSP = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const INVITE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": INVITE_CSP,
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

export type Lang = "en" | "th";
export type InviteRole = "editor" | "viewer" | "owner";

/** The browser's first choice between English and Thai (`Accept-Language`); English when it names neither first. */
export function langOf(acceptLanguage: string | undefined): Lang {
  if (!acceptLanguage) return "en";
  const ranked = acceptLanguage
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().toLowerCase().split(";");
      const q = Number(params.find((p) => p.trim().startsWith("q="))?.trim().slice(2) ?? "1");
      return { tag, q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => x.q > 0 && (x.tag.startsWith("th") || x.tag.startsWith("en")))
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return ranked[0]?.tag.startsWith("th") ? "th" : "en";
}

interface Words {
  badge: string;
  footer: string;
  joinTitle(ws: string): string;
  /** HTML: names already escaped. */
  invited(inviter: string, ws: string, role: InviteRole): string;
  roleHint(role: InviteRole): string;
  signInWith(provider: string): string;
  afterSignIn: string;
  desktopTitle: string;
  desktop: string;
  noWebSignIn: string;
  signedInAs(name: string): string;
  joinAs(ws: string, role: InviteRole): string;
  join: string;
  notYou: string;
  joinedTitle(ws: string): string;
  joinedText(role: InviteRole): string;
  memberTitle(ws: string): string;
  memberText(role: InviteRole): string;
  open: string;
  openDesktop(server: string): string;
  fullTitle: string;
  fullText(ws: string): string;
  tryAgain: string;
  staleTitle: string;
  staleText: string;
  missingTitle: string;
  missingText: string;
  busyTitle: string;
  busyText: string;
}

const EN: Words = {
  badge: "Invitation",
  footer: "An invitation to a Thoth workspace. Whoever has this address can use it until it expires or is used up.",
  joinTitle: (ws) => `Join ${ws}`,
  invited: (inviter, ws, role) => `${inviter} invited you to join <strong>${ws}</strong> on Thoth as ${role === "editor" ? "an editor" : role === "owner" ? "an owner" : "a viewer"}.`,
  roleHint: (role) => (role === "viewer" ? "Viewers can read the workspace's pages." : "Editors can read and edit the workspace's pages."),
  signInWith: (provider) => `Sign in with ${provider} to join`,
  afterSignIn: "After signing in you choose Join workspace. Nothing changes before that.",
  desktopTitle: "Using the Thoth desktop app?",
  desktop: "Open Settings → Servers, choose “Join with an invite link” and paste this page's address.",
  noWebSignIn: "This server has no sign-in in the browser. Join from the Thoth desktop app: open Settings → Servers, choose “Join with an invite link” and paste this page's address.",
  signedInAs: (name) => `Signed in as ${name}`,
  joinAs: (ws, role) => `Join <strong>${ws}</strong> as ${role === "editor" ? "an editor" : "a viewer"}?`,
  join: "Join workspace",
  notYou: "Not you? Close this window: nothing has changed.",
  joinedTitle: (ws) => `You joined ${ws}`,
  joinedText: (role) => `You are ${role === "editor" ? "an editor" : role === "owner" ? "an owner" : "a viewer"} of this workspace now.`,
  memberTitle: (ws) => `You are already a member of ${ws}`,
  memberText: (role) => `Your role stays ${role}. Nothing was changed.`,
  open: "Open in Thoth",
  openDesktop: (server) => `In the Thoth desktop app, add ${server} in Settings → Servers and sign in: the workspace shows in the sidebar.`,
  fullTitle: "This workspace is full",
  fullText: (ws) => `${ws} has as many members as it may have. Ask the person who invited you to make room, then try again.`,
  tryAgain: "Try again",
  staleTitle: "This form has expired",
  staleText: "Open the invite link again and sign in once more.",
  missingTitle: "This invite is not available",
  missingText: "The link may be mistyped, may have expired or been used up, or may have been turned off by the people who sent it.",
  busyTitle: "Too many requests",
  busyText: "This page was opened too often in a short time. Wait a little and try again.",
};

// REVIEW: Thai wording of the invite pages (native reviewer).
const TH: Words = {
  badge: "คำเชิญ",
  footer: "คำเชิญเข้าร่วมเวิร์กสเปซใน Thoth ผู้ที่มีที่อยู่นี้ใช้ได้จนกว่าจะหมดอายุหรือใช้ครบ",
  joinTitle: (ws) => `เข้าร่วม ${ws}`,
  invited: (inviter, ws, role) => `${inviter} เชิญคุณเข้าร่วม <strong>${ws}</strong> บน Thoth ในฐานะ${role === "editor" ? "ผู้แก้ไข" : role === "owner" ? "เจ้าของ" : "ผู้ดู"}`,
  roleHint: (role) => (role === "viewer" ? "ผู้ดูอ่านหน้าในเวิร์กสเปซได้" : "ผู้แก้ไขอ่านและแก้ไขหน้าในเวิร์กสเปซได้"),
  signInWith: (provider) => `ลงชื่อเข้าใช้ด้วย ${provider} เพื่อเข้าร่วม`,
  afterSignIn: "หลังลงชื่อเข้าใช้ คุณจะกด เข้าร่วมเวิร์กสเปซ เอง ก่อนหน้านั้นจะไม่มีอะไรเปลี่ยน",
  desktopTitle: "ใช้แอป Thoth บนเดสก์ท็อปอยู่หรือเปล่า",
  desktop: "เปิด การตั้งค่า → เซิร์ฟเวอร์ เลือก “เข้าร่วมด้วยลิงก์เชิญ” แล้ววางที่อยู่ของหน้านี้",
  noWebSignIn: "เซิร์ฟเวอร์นี้ไม่มีการลงชื่อเข้าใช้ผ่านเบราว์เซอร์ เข้าร่วมจากแอป Thoth บนเดสก์ท็อปได้: เปิด การตั้งค่า → เซิร์ฟเวอร์ เลือก “เข้าร่วมด้วยลิงก์เชิญ” แล้ววางที่อยู่ของหน้านี้",
  signedInAs: (name) => `ลงชื่อเข้าใช้เป็น ${name}`,
  joinAs: (ws, role) => `เข้าร่วม <strong>${ws}</strong> ในฐานะ${role === "editor" ? "ผู้แก้ไข" : "ผู้ดู"}ไหม`,
  join: "เข้าร่วมเวิร์กสเปซ",
  notYou: "ไม่ใช่คุณใช่ไหม ปิดหน้าต่างนี้ได้เลย ยังไม่มีอะไรเปลี่ยน",
  joinedTitle: (ws) => `คุณเข้าร่วม ${ws} แล้ว`,
  joinedText: (role) => `ตอนนี้คุณเป็น${role === "editor" ? "ผู้แก้ไข" : role === "owner" ? "เจ้าของ" : "ผู้ดู"}ของเวิร์กสเปซนี้`,
  memberTitle: (ws) => `คุณเป็นสมาชิกของ ${ws} อยู่แล้ว`,
  memberText: (role) => `บทบาทของคุณยังเป็น ${role === "editor" ? "ผู้แก้ไข" : role === "owner" ? "เจ้าของ" : "ผู้ดู"} ไม่มีอะไรเปลี่ยน`,
  open: "เปิดใน Thoth",
  openDesktop: (server) => `ในแอป Thoth บนเดสก์ท็อป เพิ่ม ${server} ใน การตั้งค่า → เซิร์ฟเวอร์ แล้วลงชื่อเข้าใช้ เวิร์กสเปซจะแสดงในแถบด้านข้าง`,
  fullTitle: "เวิร์กสเปซนี้เต็มแล้ว",
  fullText: (ws) => `${ws} มีสมาชิกครบจำนวนที่รับได้แล้ว ขอให้ผู้ที่เชิญคุณเพิ่มที่ว่าง แล้วลองอีกครั้ง`,
  tryAgain: "ลองอีกครั้ง",
  staleTitle: "แบบฟอร์มนี้หมดอายุแล้ว",
  staleText: "เปิดลิงก์เชิญอีกครั้งแล้วลงชื่อเข้าใช้ใหม่",
  missingTitle: "คำเชิญนี้ใช้ไม่ได้",
  missingText: "ลิงก์อาจพิมพ์ผิด หมดอายุ ใช้ครบแล้ว หรือถูกปิดโดยผู้ที่ส่งมา",
  busyTitle: "มีคำขอมากเกินไป",
  busyText: "หน้านี้ถูกเปิดบ่อยเกินไปในเวลาสั้น ๆ รอสักครู่แล้วลองอีกครั้ง",
};

export const WORDS: Readonly<Record<Lang, Words>> = { en: EN, th: TH };

/**
 * The join form's page (`/i/accept`, no token in its address) lets the browser name this origin on the form's POST,
 * which the server checks; every other invite page sends no referrer at all.
 */
export const FORM_REFERRER_POLICY = "same-origin";

function shell(lang: Lang, title: string, main: string, referrer = "no-referrer"): string {
  const w = WORDS[lang];
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="${referrer}">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
<title>${esc(title)} · Thoth</title>
<link rel="stylesheet" href="/assets/share/share.css">
</head>
<body>
<header class="bar"><span class="brand">${MARK}<span translate="no">Thoth</span></span><span class="badge">${esc(w.badge)}</span></header>
<main class="invite">
${main}
</main>
<footer class="invite-footer"><p>${esc(w.footer)}</p></footer>
</body>
</html>
`;
}

const card = (title: string, body: string) => `<section class="invite-card" aria-labelledby="invite-title">
<h1 id="invite-title">${esc(title)}</h1>
${body}
</section>`;

export interface InviteView {
  workspace: string;
  inviter: string;
  role: "editor" | "viewer";
  /** One link per sign-in provider (`/i/<token>/sign-in?provider=<id>`); empty when the server has no web sign-in. */
  signIn: { name: string; href: string }[];
}

/** The page a signed-out visitor sees at `/i/<token>`. */
export function invitePage(lang: Lang, view: InviteView): string {
  const w = WORDS[lang];
  const actions =
    view.signIn.length === 0
      ? `<p class="invite-note">${esc(w.noWebSignIn)}</p>`
      : `<div class="invite-actions">${view.signIn.map((p) => `<a class="button primary" href="${esc(p.href)}">${esc(w.signInWith(p.name))}</a>`).join("")}</div>
<p class="invite-note">${esc(w.afterSignIn)}</p>`;
  const desktop = view.signIn.length === 0 ? "" : `\n<section class="invite-aside" aria-labelledby="invite-desktop"><h2 id="invite-desktop">${esc(w.desktopTitle)}</h2><p>${esc(w.desktop)}</p></section>`;
  return shell(lang, w.joinTitle(view.workspace), `${card(w.joinTitle(view.workspace), `<p class="invite-lede">${w.invited(esc(view.inviter), esc(view.workspace), view.role)}</p>
<p class="invite-role">${esc(w.roleHint(view.role))}</p>
${actions}`)}${desktop}`);
}

/** After sign-in: who is signed in, and the join form (a POST with the CSRF value, never a GET side effect). */
export function readyPage(lang: Lang, view: { workspace: string; role: "editor" | "viewer"; account: string; csrf: string; notice?: { title: string; text: string } }): string {
  const w = WORDS[lang];
  const notice = view.notice ? `<div class="invite-alert" role="alert"><p><strong>${esc(view.notice.title)}</strong></p><p>${esc(view.notice.text)}</p></div>\n` : "";
  return shell(lang, w.joinTitle(view.workspace), card(w.joinTitle(view.workspace), `${notice}<p class="invite-who">${esc(w.signedInAs(view.account))}</p>
<p class="invite-lede">${w.joinAs(esc(view.workspace), view.role)}</p>
<p class="invite-role">${esc(w.roleHint(view.role))}</p>
<form method="post" action="/i/accept"><input type="hidden" name="csrf" value="${esc(view.csrf)}"><button type="submit" class="button primary">${esc(view.notice ? w.tryAgain : w.join)}</button></form>
<p class="invite-note">${esc(w.notYou)}</p>`), FORM_REFERRER_POLICY);
}

/** Joined, or already a member: where to go next. */
export function donePage(lang: Lang, view: { workspace: string; role: InviteRole; joined: boolean; webClient: string | null; server: string }): string {
  const w = WORDS[lang];
  const title = view.joined ? w.joinedTitle(view.workspace) : w.memberTitle(view.workspace);
  const open = view.webClient ? `<div class="invite-actions"><a class="button primary" href="${esc(view.webClient)}">${esc(w.open)}</a></div>\n` : "";
  return shell(lang, title, card(title, `<p class="invite-lede" role="status">${esc(view.joined ? w.joinedText(view.role) : w.memberText(view.role))}</p>
${open}<p class="invite-note">${esc(w.openDesktop(view.server))}</p>`));
}

/** A plain message page: not found, too many requests, an expired form. */
export function messagePage(lang: Lang, title: string, text: string): string {
  return shell(lang, title, `<section class="invite-card missing-card" aria-labelledby="invite-title">
<h1 id="invite-title">${esc(title)}</h1>
<p>${esc(text)}</p>
</section>`);
}
