import { useStrings } from "@thoth/app-ui/strings/index.ts";

/**
 * Privacy notice and cookie settings. The consent banner belongs to the site's `/analytics.js` (present only when
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
    </p>
  );
}
