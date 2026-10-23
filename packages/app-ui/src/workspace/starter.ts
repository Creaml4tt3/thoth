/**
 * The starter server: the owner's hosted demo, suggested in Settings → Servers
 * (owner, 2026-10-24). It is only a suggestion. Thoth never contacts it until
 * the user adds it, and any other server can be added by its address.
 *
 * When the demo moves to its own domain, change `url` here too
 * (docs/deploy/trial.md, "Moving to a bought domain").
 */
export interface StarterServer {
  /** The server's origin, as `server.add` normalizes it. */
  url: string;
  name: string;
  /** What a user of this server needs to know, in a sentence or two. */
  caution: string;
}

export const STARTER_SERVER: StarterServer = {
  url: "https://api.thoth.creaml4tt3.me",
  name: "Thoth demo server",
  caution: "A free demo for trying Thoth, with limits. Accounts unused for 90 days are deleted, and the demo may be reset, so keep anything important in your Private Space.",
};

/** True when `url` (a normalized origin from the host) is the starter server. */
export function isStarter(starter: StarterServer | null, url: string): boolean {
  if (!starter) return false;
  try {
    return new URL(starter.url).origin === url;
  } catch {
    return false;
  }
}
