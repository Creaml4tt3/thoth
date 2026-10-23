import type { SignInConfig } from "../config.ts";

/** The two public clients (sign-in.md section 2). There is no dynamic registration. */
export type ClientId = "thoth-desktop" | "thoth-web";
export const DESKTOP: ClientId = "thoth-desktop";
export const WEB: ClientId = "thoth-web";

/** A known client: `thoth-web` exists only when `WEB_REDIRECT_URIS` is set. */
export function knownClient(config: SignInConfig, clientId: unknown): ClientId | null {
  if (clientId === DESKTOP) return DESKTOP;
  if (clientId === WEB && config.webRedirectUris.length > 0) return WEB;
  return null;
}

/**
 * RFC 8252 section 7.3 loopback redirect: `http://127.0.0.1:<port>/callback` or `http://[::1]:<port>/callback`, any port,
 * nothing else. `localhost` is refused (it can resolve elsewhere), as are https, other paths, queries and fragments.
 */
const LOOPBACK_REDIRECT = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/callback$/;

/** Exact-string redirect URI check for a client; no prefix matching, no wildcards. */
export function redirectAllowed(config: SignInConfig, client: ClientId, redirectUri: unknown): redirectUri is string {
  if (typeof redirectUri !== "string") return false;
  if (client === WEB) return config.webRedirectUris.includes(redirectUri);
  const match = LOOPBACK_REDIRECT.exec(redirectUri);
  return match !== null && Number(match[1]) <= 65_535;
}
