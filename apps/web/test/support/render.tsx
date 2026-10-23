import "../../../../tests/helpers/jsdom-shims.ts";
import { cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect } from "vitest";
import { App } from "../../src/App.tsx";
import type { ThothAnalytics } from "../../src/analytics.ts";
import type { WebEnv } from "../../src/env.ts";
import { APP_ORIGIN, FakeWebServer, SERVER } from "./fake-web-server.ts";

configure({ asyncUtilTimeout: 5000 });

/** A browser the test controls: address bar, session storage, navigations, analytics sink. */
export interface FakeBrowser {
  env: WebEnv;
  server: FakeWebServer;
  user: ReturnType<typeof userEvent.setup>;
  /** Where the app tried to navigate (the sign-in redirect). */
  navigations: string[];
  session: Map<string, string>;
  local: Map<string, string>;
  /** Every analytics event the app sent. */
  events: { name: string; params: Record<string, string> }[];
  location: { pathname: string; search: string };
}

class MapStorage {
  readonly map: Map<string, string>;
  constructor(map: Map<string, string>) {
    this.map = map;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

export function fakeBrowser(server = new FakeWebServer(), options: { path?: string; languages?: string[]; session?: Map<string, string>; local?: Map<string, string>; autosaveMs?: number; pollMs?: number } = {}): FakeBrowser {
  const navigations: string[] = [];
  const events: FakeBrowser["events"] = [];
  const session = options.session ?? new Map<string, string>();
  const local = options.local ?? new Map<string, string>();
  const url = new URL(options.path ?? "/app/", APP_ORIGIN);
  const location = { pathname: url.pathname, search: url.search };
  const sink: ThothAnalytics = { track: (name, params) => void events.push({ name, params: { ...params } }) };
  const env: WebEnv = {
    server: SERVER,
    origin: APP_ORIGIN,
    basePath: "/app/",
    location,
    replaceUrl: (path) => {
      const next = new URL(path, APP_ORIGIN);
      location.pathname = next.pathname;
      location.search = next.search;
    },
    navigate: (target) => void navigations.push(target),
    fetch: server.fetch,
    sessionStorage: new MapStorage(session),
    localStorage: new MapStorage(local),
    languages: options.languages ?? ["en-US"],
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    sha256: async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    pollMs: options.pollMs ?? 0,
    autosaveMs: options.autosaveMs ?? 0,
    analyticsTarget: { thothAnalytics: sink },
  };
  return { env, server, user: userEvent.setup(), navigations, session, local, events, location };
}

export function open(browser: FakeBrowser) {
  return render(<App env={browser.env} />);
}

/** The full redirect sign-in: click the provider, come back to /app/callback as the server would. */
export async function signInThroughUi(browser: FakeBrowser, provider = "Google"): Promise<void> {
  const view = open(browser);
  await browser.user.click(await screen.findByRole("button", { name: `Sign in with ${provider}` }));
  await waitFor(() => expect(browser.navigations).toHaveLength(1));
  const back = new URL(browser.server.callbackUrl(browser.navigations[0]!));
  view.unmount();
  browser.location.pathname = back.pathname;
  browser.location.search = back.search;
  open(browser);
  await screen.findByRole("button", { name: "Sign out" });
}

export const editorBox = () => screen.findByRole("textbox", { name: /page content/i });
export { cleanup, screen, waitFor, within };
