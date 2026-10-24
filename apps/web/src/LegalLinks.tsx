import { useStrings } from "@thoth/app-ui/strings/index.ts";

/** The author, credited as on the website's footer (owner, 2026-10-24). */
export const AUTHOR = { name: "Teekayu Poongkawabutr", alias: "Creaml4tt3", url: "https://creaml4tt3.me/" } as const;

/**
 * Privacy notice, cookie settings and the copyright line. The consent banner belongs to the site's `/analytics.js` (present only when
 * the deploy has a GA4 ID); its `data-consent-open` handler opens it, so without analytics the button is hidden.
 */
export function LegalLinks() {
  const t = useStrings();
  const analytics = typeof window !== "undefined" && window.thothAnalytics !== undefined;
  return (
    <p className="web-legal">
      <a href={t.lang === "th" ? "/th/privacy/" : "/privacy/"}>{t.web.privacy}</a>
      {analytics && (
        <button type="button" className="link-button" data-consent-open="">
          {t.web.cookieSettings}
        </button>
      )}
      <span className="web-copyright">
        © {new Date().getFullYear()} <a href={AUTHOR.url}>{AUTHOR.name}</a>
        {t.web.knownAs} {AUTHOR.alias}
      </span>
    </p>
  );
}
