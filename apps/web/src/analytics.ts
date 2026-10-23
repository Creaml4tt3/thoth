/**
 * Analytics hooks (ADR-0015 rule 4). This bundle contains no analytics code: the website's consent layer may set
 * `window.thothAnalytics` (after the visitor accepts), and `track` forwards to it. Without it, nothing happens.
 *
 * Only these events exist, and their parameters are fixed values or a provider id. Page titles, page or workspace
 * ids, search text, names and email addresses are never passed: the types below allow no free text, and `track`
 * drops any parameter it does not know.
 */
export type ScreenName = "/app" | "/app/page" | "/app/signin";
export type ConflictChoice = "mine" | "theirs" | "both";

export type AnalyticsEvent =
  | { name: "screen_view"; params: { screen: ScreenName } }
  | { name: "sign_in"; params: { provider: string } }
  | { name: "page_open" }
  | { name: "page_save" }
  | { name: "page_create" }
  | { name: "conflict_shown" }
  | { name: "conflict_resolved"; params: { choice: ConflictChoice } }
  | { name: "search" };

/** What the site's consent layer provides. */
export interface ThothAnalytics {
  track(name: string, params: Record<string, string>): void;
}

declare global {
  interface Window {
    thothAnalytics?: ThothAnalytics;
  }
}

const SCREENS = new Set<string>(["/app", "/app/page", "/app/signin"]);
const CHOICES = new Set<string>(["mine", "theirs", "both"]);
/** Provider ids are short lowercase words (`google`, `github`, `oidc`); anything else is not sent. */
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;

/** The parameters actually sent for an event: only known keys, only allowed values. */
export function payload(event: AnalyticsEvent): Record<string, string> {
  switch (event.name) {
    case "screen_view":
      return SCREENS.has(event.params.screen) ? { screen: event.params.screen } : {};
    case "sign_in":
      return PROVIDER.test(event.params.provider) ? { provider: event.params.provider } : {};
    case "conflict_resolved":
      return CHOICES.has(event.params.choice) ? { choice: event.params.choice } : {};
    default:
      return {};
  }
}

export function track(event: AnalyticsEvent, target: { thothAnalytics?: ThothAnalytics | undefined } = typeof window === "undefined" ? {} : window): void {
  const sink = target.thothAnalytics;
  if (!sink || typeof sink.track !== "function") return;
  try {
    sink.track(event.name, payload(event));
  } catch {
    // Analytics must never break the app.
  }
}
