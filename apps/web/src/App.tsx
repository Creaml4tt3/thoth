import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LegalLinks } from "./LegalLinks.tsx";
import { WorkspaceClient } from "@thoth/workspace-client";
import type { Capabilities, Me } from "@thoth/workspace-protocol";
import { STRINGS, StringsContext, pickLang, useStrings, type Lang } from "@thoth/app-ui/strings/index.ts";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import { AuthSession, CallbackError, Unreachable, type CallbackFailure } from "./auth.ts";
import { SetLangContext } from "./LanguageSwitch.tsx";
import { ThemeStoreContext, webThemeStore } from "./ThemeSwitch.tsx";
import { SignInView } from "./SignInView.tsx";
import { WorkspaceApp } from "./WorkspaceApp.tsx";
import { track } from "./analytics.ts";
import type { WebEnv } from "./env.ts";
import { SERVER_ID, WebServers } from "./servers.ts";

const LANG_KEY = "thoth.web.lang";

type Boot =
  | { phase: "loading" }
  | { phase: "unreachable" }
  | { phase: "ready"; capabilities: Capabilities; auth: AuthSession | null; failure: CallbackFailure | "unreachable" | null };

function initialLang(env: WebEnv): Lang {
  const saved = env.localStorage?.getItem(LANG_KEY);
  return saved === "en" || saved === "th" ? saved : pickLang(env.languages);
}

/** Capabilities without a credential: the server's name, limits and sign-in endpoints. */
async function loadCapabilities(env: WebEnv): Promise<Capabilities> {
  const client = new WorkspaceClient(async (req) => {
    const url = new URL(req.path, env.server);
    const res = await env.fetch(url, { method: req.method, credentials: "omit", redirect: "error", cache: "no-store" });
    return { status: res.status, headers: {}, body: await res.text() };
  });
  return client.getCapabilities();
}

/** True when every sign-in endpoint is on `server` (an origin). */
export function sameOrigin(signIn: NonNullable<Capabilities["signIn"]>, server: string): boolean {
  return [signIn.authorizationEndpoint, signIn.tokenEndpoint, signIn.revocationEndpoint].every((endpoint) => {
    try {
      return new URL(endpoint).origin === server;
    } catch {
      return false;
    }
  });
}

export function App({ env }: { env: WebEnv }) {
  const [lang, setLangState] = useState<Lang>(() => initialLang(env));
  const [themeStore] = useState(() => webThemeStore(env));
  const strings = STRINGS[lang];
  const setLang = useCallback(
    (next: Lang) => {
      setLangState(next);
      try {
        env.localStorage?.setItem(LANG_KEY, next);
      } catch {
        // private mode: the choice lasts for this visit
      }
    },
    [env],
  );
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const callbackPath = `${env.basePath}callback`;

  useEffect(() => {
    let live = true;
    let auth: AuthSession | null = null;
    (async () => {
      let capabilities: Capabilities;
      try {
        capabilities = await loadCapabilities(env);
      } catch {
        if (live) setBoot({ phase: "unreachable" });
        return;
      }
      // Sign-in endpoints off the server's origin are ignored, as on the desktop: a code or cookie never goes elsewhere.
      const signIn = capabilities.signIn && sameOrigin(capabilities.signIn, env.server) ? capabilities.signIn : undefined;
      if (!signIn) {
        if (live) setBoot({ phase: "ready", capabilities, auth: null, failure: null });
        return;
      }
      auth = new AuthSession({ server: env.server, signIn, redirectUri: `${env.origin}${callbackPath}`, fetch: env.fetch, storage: env.sessionStorage, navigate: env.navigate, random: env.random, sha256: env.sha256, now: env.now, setTimer: env.setTimer, clearTimer: env.clearTimer });
      let failure: CallbackFailure | "unreachable" | null = null;
      // `/app/callback/` too: the website's host adds a trailing slash to paths without a file extension.
      if (env.location.pathname === callbackPath || env.location.pathname === `${callbackPath}/`) {
        const query = new URLSearchParams(env.location.search);
        // The code and state leave the address bar (and the history) before anything else happens.
        env.replaceUrl(env.basePath);
        try {
          const { provider } = await auth.complete(query);
          track({ name: "sign_in", params: { provider } }, env.analyticsTarget);
        } catch (error) {
          failure = error instanceof CallbackError ? error.reason : error instanceof Unreachable ? "unreachable" : "generic";
        }
      } else {
        // A returning visitor: the refresh cookie (if any) signs them in without a click.
        try {
          await auth.refresh();
        } catch {
          failure = "unreachable";
        }
      }
      if (live) setBoot({ phase: "ready", capabilities, auth, failure });
    })();
    return () => {
      live = false;
      auth?.dispose();
    };
  }, [env, attempt, callbackPath]);

  let body;
  if (boot.phase === "loading") {
    body = (
      <div className="boot" role="status">
        <Mark size={32} />
        <span className="muted">{strings.web.loading}</span>
      </div>
    );
  } else if (boot.phase === "unreachable") {
    body = (
      <div className="boot">
        <Mark size={32} />
        <p role="alert">{strings.web.unreachable}</p>
        <Button variant="primary" small onClick={() => setAttempt((n) => n + 1)}>
          {strings.web.tryAgain}
        </Button>
        <LegalLinks />
      </div>
    );
  } else {
    body = <Ready env={env} capabilities={boot.capabilities} auth={boot.auth} failure={boot.failure} restart={() => setAttempt((n) => n + 1)} />;
  }

  return (
    <StringsContext.Provider value={strings}>
      <ThemeStoreContext.Provider value={themeStore}>
        <SetLangContext.Provider value={setLang}>{body}</SetLangContext.Provider>
      </ThemeStoreContext.Provider>
    </StringsContext.Provider>
  );
}

/** After boot: the sign-in page, or the workspaces of the signed-in session. */
function Ready({ env, capabilities, auth, failure, restart }: { env: WebEnv; capabilities: Capabilities; auth: AuthSession | null; failure: CallbackFailure | "unreachable" | null; restart(): void }) {
  const t = useStrings();
  const status = useSyncExternalStore(auth?.subscribe ?? noSubscribe, auth?.getStatus ?? signedOutStatus);
  const signedIn = status === "signed-in";
  const [account, setAccount] = useState<Me | null>(null);
  const accountRef = useRef<Me | null>(null);
  accountRef.current = account;

  // One directory per signed-in session. It outlives a session that ends on its own (a refused refresh), so the
  // open page and its unsaved text stay on screen under a "signed out" banner; only Sign out drops it.
  const [directory, setDirectory] = useState<ServerDirectory | null>(null);
  useEffect(() => {
    if (!auth || !signedIn || directory) return;
    const servers = new WebServers({ server: env.server, capabilities, auth, fetch: env.fetch, account: () => (accountRef.current ? { id: accountRef.current.id, displayName: accountRef.current.displayName } : undefined) });
    setDirectory(new ServerDirectory(servers, { pollMs: env.pollMs }));
  }, [auth, signedIn, directory, env, capabilities]);

  useEffect(() => {
    if (!directory) return;
    void directory.start();
    directory
      .client(SERVER_ID)
      .getMe()
      .then(setAccount)
      .catch(() => undefined);
    return () => directory.dispose();
  }, [directory]);

  const signOut = useCallback(async () => {
    try {
      await auth?.signOut();
    } finally {
      setDirectory(null);
      setAccount(null);
    }
  }, [auth]);

  if (auth && directory) {
    return <WorkspaceApp env={env} directory={directory} capabilities={capabilities} account={account} signOut={signOut} signInAgain={restart} />;
  }
  const error = failure === null ? null : failure === "unreachable" ? t.web.unreachable : t.web.signInFailed[failure];
  return <SignInView env={env} signIn={auth ? capabilities.signIn : undefined} limits={capabilities.limits as Record<string, number> | undefined} error={error} begin={(provider) => auth?.begin(provider) ?? Promise.resolve()} />;
}

const noSubscribe = () => () => undefined;
const signedOutStatus = () => "signed-out" as const;
