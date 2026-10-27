import { escapeHtml as esc } from "./signin/html.ts";
import { MARK } from "./share/html.ts";

/**
 * The page the website's no-JavaScript support form gets back (ADR-0033): thanks, or what to fix, and a link back to
 * the support page it came from. Plain HTML, no script, the share pages' stylesheet, light and dark, English or Thai.
 */
export const FEEDBACK_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

export type FeedbackLang = "en" | "th";

const WORDS = {
  en: {
    thanksTitle: "Thank you",
    thanks: "Your message has reached us. If you left an email address, we may write back.",
    fixTitle: "Your message was not sent",
    fix: "Please go back and check:",
    busyTitle: "Too many messages",
    busy: "Please wait a few minutes and send it again, or write to us by email.",
    back: "Back to Support",
    fields: { kind: "the kind of message", message: "the message (1 to 5000 characters)", email: "the email address", context: "the app details" } as Record<string, string>,
  },
  th: {
    thanksTitle: "ขอบคุณ",
    thanks: "เราได้รับข้อความของคุณแล้ว หากคุณให้อีเมลไว้ เราอาจตอบกลับทางอีเมล",
    fixTitle: "ยังไม่ได้ส่งข้อความ",
    fix: "โปรดกลับไปตรวจสอบ:",
    busyTitle: "ส่งข้อความมากเกินไป",
    busy: "โปรดรอสักครู่แล้วส่งอีกครั้ง หรือเขียนถึงเราทางอีเมล",
    back: "กลับไปหน้าช่วยเหลือ",
    fields: { kind: "ประเภทของข้อความ", message: "ข้อความ (1 ถึง 5000 ตัวอักษร)", email: "อีเมล", context: "ข้อมูลแอป" } as Record<string, string>,
  },
} as const;

function shell(lang: FeedbackLang, title: string, body: string, back: string | null): string {
  const link = back ? `\n<div class="invite-actions"><a class="button primary" href="${esc(back)}">${esc(WORDS[lang].back)}</a></div>` : "";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
<title>${esc(title)} · Thoth</title>
<link rel="stylesheet" href="/assets/share/share.css">
</head>
<body>
<header class="bar"><span class="brand">${MARK}<span translate="no">Thoth</span></span></header>
<main class="invite">
<section class="invite-card" aria-labelledby="feedback-title">
<h1 id="feedback-title">${esc(title)}</h1>
${body}${link}
</section>
</main>
</body>
</html>
`;
}

export function thanksPage(lang: FeedbackLang, back: string | null): string {
  const w = WORDS[lang];
  return shell(lang, w.thanksTitle, `<p class="invite-lede" role="status">${esc(w.thanks)}</p>`, back);
}

/** `fields`: the top-level fields that were refused (`kind`, `message`, `email`, `context`). */
export function fixPage(lang: FeedbackLang, fields: string[], back: string | null): string {
  const w = WORDS[lang];
  const items = [...new Set(fields)].map((f) => `<li>${esc(w.fields[f] ?? f)}</li>`).join("");
  return shell(lang, w.fixTitle, `<div role="alert"><p>${esc(w.fix)}</p><ul>${items}</ul></div>`, back);
}

export function busyPage(lang: FeedbackLang, back: string | null): string {
  const w = WORDS[lang];
  return shell(lang, w.busyTitle, `<p role="alert">${esc(w.busy)}</p>`, back);
}
