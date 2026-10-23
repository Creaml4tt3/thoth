import { describe, expect, it } from "vitest";
import { AuthSession, CallbackError, type AuthDeps } from "../src/auth.ts";

const SERVER = "https://api.example.org";
const SIGN_IN = { authorizationEndpoint: `${SERVER}/auth/authorize`, tokenEndpoint: `${SERVER}/auth/token`, revocationEndpoint: `${SERVER}/auth/revoke`, providers: [{ id: "google", name: "Google" }] };

/** An AuthSession over a scripted token endpoint. `answer` decides each token response. */
function session(answer: () => Promise<Response>) {
  const storage = new Map<string, string>();
  const calls: string[] = [];
  let navigated = "";
  const deps: AuthDeps = {
    server: SERVER,
    signIn: SIGN_IN,
    redirectUri: "https://web.example.org/app/callback",
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      return answer();
    }) as typeof fetch,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v), removeItem: (k) => void storage.delete(k) },
    navigate: (url) => {
      navigated = url;
    },
    random: (n) => new Uint8Array(n).fill(7),
    sha256: async () => new Uint8Array(32),
    now: () => 1_000_000,
    setTimer: () => 0,
    clearTimer: () => undefined,
  };
  return { auth: new AuthSession(deps), calls, navigated: () => navigated };
}

const granted = () => new Response(JSON.stringify({ access_token: "thoth_at_test_only_0000", token_type: "Bearer", expires_in: 900 }), { status: 200 });

describe("AuthSession", () => {
  it("refuses a callback whose iss is not the server, and never exchanges its code", async () => {
    const { auth, calls, navigated } = session(async () => granted());
    await auth.begin("google");
    const state = new URL(navigated()).searchParams.get("state")!;
    const query = new URLSearchParams({ code: "c0de", state, iss: "https://evil.example.org" });
    await expect(auth.complete(query)).rejects.toBeInstanceOf(CallbackError);
    expect(calls).toHaveLength(0);
  });

  it("runs concurrent refreshes as one token request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { auth, calls } = session(async () => {
      await gate;
      return granted();
    });
    const all = Promise.all([auth.refresh(), auth.refresh(), auth.token(), auth.renew("thoth_at_old_0000000")]);
    release();
    expect(await all).toEqual([true, true, "thoth_at_test_only_0000", "thoth_at_test_only_0000"]);
    expect(calls.filter((body) => body.includes("grant_type=refresh_token"))).toHaveLength(1);
  });
});
