import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiCallArgs, ApiCallResult, ServerInfo } from "@thoth/platform";
import { HostCallError } from "@thoth/platform/remote";
import { StdioTransport } from "@thoth/platform/stdio";
import { buildHarness, tempDir } from "../../../tests/ports/harness.ts";
import { generateToken } from "../src/auth.ts";
import { opaqueId } from "../src/ids.ts";
import { startTestEnv, type TestEnv } from "./helpers.ts";
import { startFakeIssuer, type FakeIssuer } from "./fakes.ts";
import { uuid } from "./support.ts";

/**
 * The desktop's Rust host (crates/thoth-host, module `remote`) against the real server and its test OIDC issuer,
 * through the `thoth-host-stdio` harness. The harness reports the sign-in URL as a `browser.open` event; the test
 * plays the browser (authorize -> issuer -> server callback -> the host's loopback). Every result, error and event
 * the harness produced is kept and searched for tokens at the end.
 */

let env: TestEnv;
let issuer: FakeIssuer;
let transport: StdioTransport;
let dataDir: string;
/** Everything the harness printed: results, error messages and events. */
const printed: string[] = [];
/** Secrets the test saw on the browser side (codes) or created (personal access tokens). */
const secrets: string[] = [];
let opened: ((url: string) => void) | undefined;
const extraServers: Server[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function call<T>(promise: Promise<T>): Promise<T> {
  try {
    const result = await promise;
    printed.push(JSON.stringify(result));
    return result;
  } catch (error) {
    printed.push(String(error instanceof HostCallError ? `${error.code}: ${error.message}` : error));
    throw error;
  }
}

const host = {
  add: (url: string) => call<ServerInfo>(transport.call("server.add", { url })),
  list: () => call<ServerInfo[]>(transport.call("server.list", {})),
  signOut: (server: string) => call<ServerInfo>(transport.call("server.signOut", { server })),
  useToken: (server: string, token: string) => call<ServerInfo>(transport.call("server.useToken", { server, token })),
  api: (args: ApiCallArgs, body?: string) => call<ApiCallResult>(transport.call("api.call", args, body === undefined ? undefined : new TextEncoder().encode(body))),
};

async function hostError(promise: Promise<unknown>): Promise<HostCallError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HostCallError);
  return error as HostCallError;
}

/** The next `browser.open` URL. */
function nextBrowserOpen(): Promise<string> {
  return new Promise((resolve) => {
    opened = resolve;
  });
}

/** Follows the server's and the issuer's redirects like a browser (with the binding cookie), up to the loopback callback. */
async function browseToCallback(url: string): Promise<URL> {
  const cookies = new Map<string, string>();
  let next = url;
  for (let hop = 0; hop < 6; hop++) {
    const target = new URL(next);
    // The host's loopback redirect (the server's own provider callback is /auth/callback/<provider>).
    if (target.pathname === "/callback" && target.hostname === "127.0.0.1") {
      const code = target.searchParams.get("code");
      if (code) secrets.push(code);
      return target;
    }
    const cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(next, { redirect: "manual", headers: cookie && next.startsWith(env.url) ? { cookie } : {} });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair!.indexOf("=");
      cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
    expect(res.status, await res.clone().text()).toBe(302);
    next = res.headers.get("location")!;
  }
  throw new Error("the sign-in did not come back to the loopback");
}

/** Runs `server.signIn`, plays the browser, and lets `tamper` change the callback URL. Returns the host's answer and the page the browser saw. */
async function signIn(server: string, tamper: (callback: URL) => void = () => undefined): Promise<{ result: Promise<ServerInfo>; page: { status: number; text: string } }> {
  const url = nextBrowserOpen();
  const result = call<ServerInfo>(transport.call("server.signIn", { server }));
  result.catch(() => undefined);
  const callback = await browseToCallback(await url);
  tamper(callback);
  const res = await fetch(callback, { redirect: "manual" });
  return { result, page: { status: res.status, text: await res.text() } };
}

beforeAll(async () => {
  issuer = await startFakeIssuer();
  // PUBLIC_URL must be the address the desktop adds: its iss and endpoints are checked against that origin.
  const port = await freePort();
  env = await startTestEnv({
    env: { PORT: String(port), SERVER_NAME: "Team notes", PUBLIC_URL: `http://127.0.0.1:${port}`, OIDC_GOOGLE_CLIENT_ID: issuer.clientId, OIDC_GOOGLE_CLIENT_SECRET: issuer.clientSecret, ACCESS_TOKEN_TTL_SECONDS: "900" },
    configure: (c) => {
      for (const p of c.signIn!.providers) if (p.kind === "oidc") p.issuer = issuer.url;
    },
  });
  dataDir = await tempDir("thoth-desktop-host-");
  transport = new StdioTransport({
    binary: await buildHarness(),
    dataDir,
    onHostEvent: (event, payload) => {
      printed.push(JSON.stringify({ event, payload }));
      if (event === "browser.open") opened?.((payload as { url: string }).url);
    },
  });
});

afterAll(async () => {
  await transport?.close();
  for (const s of extraServers) await new Promise<void>((resolve) => s.close(() => resolve()));
  await env?.close();
  await issuer?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("desktop host against the reference server", () => {
  it("adds, signs in, reads and writes, refreshes an expired token, and signs out (revoked on the server)", async () => {
    const info = await host.add(`${env.url}/`);
    expect(info).toMatchObject({ url: env.url, label: "Team notes", auth: "signed-out", providers: [{ id: "google", name: "Google" }] });
    const id = info.id;

    const { result, page } = await signIn(id);
    expect(page.status).toBe(200);
    expect(page.text).toContain("You can close this window");
    const signed = await result;
    expect(signed).toMatchObject({ id, auth: "browser", account: { displayName: "Ada Lovelace", email: "ada@example.org" } });
    const userId = signed.account!.id;

    const me = await host.api({ server: id, method: "GET", path: "/api/v1/me" });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body).id).toBe(userId);

    const ws = await env.workspace("Team", { members: { [userId]: "owner" } });
    const list = await host.api({ server: id, method: "GET", path: "/api/v1/workspaces", query: { limit: "10" } });
    expect(list.status).toBe(200);
    // The account's own first-run workspace, plus the one it was added to.
    expect(JSON.parse(list.body).items.map((w: { id: string }) => w.id)).toContain(ws);
    expect(JSON.parse(list.body).items).toHaveLength(2);

    const pageId = uuid();
    const path = `/api/v1/workspaces/${ws}/pages/${pageId}`;
    const put = await host.api({ server: id, method: "PUT", path, headers: { "if-none-match": "*", "content-type": "application/json" } }, JSON.stringify({ title: "From the desktop", markdown: "# Hello & welcome\n" }));
    expect(put.status, put.body).toBe(201);
    expect(put.headers.etag).toMatch(/^"/);
    expect(Object.keys(put.headers).every((h) => ["content-type", "etag", "location", "retry-after"].includes(h))).toBe(true);
    const got = await host.api({ server: id, method: "GET", path });
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body).markdown).toBe("# Hello & welcome\n");
    expect(got.headers.etag).toBe(put.headers.etag);

    // A stale write is the server's answer (412), not a host error.
    const stale = await host.api({ server: id, method: "PUT", path, headers: { "if-match": '"stale"', "content-type": "application/json" } }, JSON.stringify({ title: "x", markdown: "y" }));
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(stale.headers["content-type"]).toContain("problem+json");

    // Expire the session's access token on the server: the host refreshes once and retries.
    const sessionId = (await env.db.query<{ id: string }>("SELECT id FROM sessions WHERE user_id = $1 AND client_id = 'thoth-desktop'", [userId])).rows[0]!.id;
    await env.db.query("UPDATE access_tokens SET expires_at = now() - interval '1 second' WHERE session_id = $1", [sessionId]);
    const usedBefore = (await env.db.query("SELECT 1 FROM refresh_tokens WHERE session_id = $1 AND used_at IS NOT NULL", [sessionId])).rowCount;
    const again = await host.api({ server: id, method: "GET", path });
    expect(again.status).toBe(200);
    const usedAfter = (await env.db.query("SELECT 1 FROM refresh_tokens WHERE session_id = $1 AND used_at IS NOT NULL", [sessionId])).rowCount;
    expect(usedAfter).toBe((usedBefore ?? 0) + 1);
    const session = (await env.db.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM sessions WHERE id = $1", [sessionId])).rows[0]!;
    expect(session.revoked_at).toBeNull();

    const out = await host.signOut(id);
    expect(out.auth).toBe("signed-out");
    expect(out.account).toBeUndefined();
    const revoked = (await env.db.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM sessions WHERE id = $1", [sessionId])).rows[0]!;
    expect(revoked.revoked_at).not.toBeNull();
    expect((await host.api({ server: id, method: "GET", path: "/api/v1/me" })).status).toBe(401);
    expect((await host.list()).find((s) => s.id === id)?.auth).toBe("signed-out");
  });

  it("signs in with a personal access token on a server with no provider", async () => {
    const plain = await startTestEnv();
    try {
      const user = await plain.user("Grace");
      secrets.push(user.token);
      const info = await host.add(plain.url);
      expect(info.providers).toEqual([]);
      const refused = await hostError(transport.call("server.signIn", { server: info.id }));
      expect(refused.code).toBe("SIGN_IN_FAILED");
      expect((await hostError(transport.call("server.useToken", { server: info.id, token: generateToken() }))).code).toBe("SIGN_IN_FAILED");
      const signed = await host.useToken(info.id, user.token);
      expect(signed).toMatchObject({ auth: "token", account: { id: user.userId, displayName: "Grace" } });
      expect(JSON.stringify(signed)).not.toContain(user.token);
      const me = await host.api({ server: info.id, method: "GET", path: "/api/v1/me" });
      expect(JSON.parse(me.body).id).toBe(user.userId);
      await host.signOut(info.id);
      expect((await host.api({ server: info.id, method: "GET", path: "/api/v1/me" })).status).toBe(401);
    } finally {
      await plain.close();
    }
  });

  it("refuses a callback with the wrong state or the wrong iss, and never exchanges its code", async () => {
    const { id } = await host.add(env.url);
    for (const [name, tamper, message] of [
      ["state", (u: URL) => u.searchParams.set("state", randomBytes(32).toString("base64url")), "does not belong to this sign-in"],
      ["iss", (u: URL) => u.searchParams.set("iss", "https://evil.example.org"), "came from a different server"],
    ] as const) {
      const { result, page } = await signIn(id, tamper);
      expect(page.status, name).toBe(400);
      expect(page.text).toContain("Sign-in failed");
      const error = await hostError(result);
      expect(error.code, name).toBe("SIGN_IN_FAILED");
      expect(error.message).toContain(message);
    }
    // Neither code was redeemed: no desktop session exists besides the one signed out in the first test.
    const live = await env.db.query("SELECT 1 FROM sessions WHERE client_id = 'thoth-desktop' AND revoked_at IS NULL");
    expect(live.rowCount).toBe(0);
    // A clean sign-in still works afterwards.
    const { result } = await signIn(id);
    expect((await result).auth).toBe("browser");
    await host.signOut(id);
  });

  it("refuses sign-in endpoints on another origin", async () => {
    // Added as `localhost`, the server advertises its endpoints on 127.0.0.1: another origin.
    const { id } = await host.add(env.url.replace("127.0.0.1", "localhost"));
    let browserOpened = false;
    opened = () => {
      browserOpened = true;
    };
    const error = await hostError(transport.call("server.signIn", { server: id }));
    expect(error.code).toBe("SIGN_IN_FAILED");
    expect(error.message).toContain("are not on");
    expect(browserOpened).toBe(false);
  });

  it("refuses plain http to a non-loopback host and api.call outside /api/v1", async () => {
    for (const url of ["http://example.org", "http://192.168.1.10:8080", "ftp://127.0.0.1"]) expect((await hostError(transport.call("server.add", { url }))).code).toBe("BAD_ARGUMENT");
    const { id } = await host.add(env.url);
    for (const path of ["/auth/token", "/auth/revoke", "/api/v1/../auth/token", "/api/v1/%2e%2e/auth/token", "/api/v1//me", "/api/v1/me?x=1", "/internal/maintenance"]) {
      expect((await hostError(transport.call("api.call", { server: id, method: "GET", path }))).code, path).toBe("BAD_ARGUMENT");
    }
    expect((await hostError(transport.call("api.call", { server: id, method: "GET", path: "/api/v1/me", headers: { authorization: "Bearer x" } }))).code).toBe("BAD_ARGUMENT");
  });

  it("does not follow a redirect from the server, so the token goes nowhere else", async () => {
    const seenElsewhere: string[] = [];
    const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> => {
      const server = createServer(handler);
      extraServers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const elsewhere = await listen((req, res) => {
      seenElsewhere.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
      res.end("{}");
    });
    const pat = generateToken();
    secrets.push(pat);
    const redirecting = await listen((req, res) => {
      if (req.url === "/api/v1/capabilities") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ protocolVersion: "1.0", capabilities: [], limits: {}, server: { name: "redirector", version: "0" } }));
      if (req.url === "/api/v1/me" && req.headers.authorization === `Bearer ${pat}`) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: opaqueId("usr"), displayName: "R" }));
      return res.writeHead(302, { location: `${elsewhere}/api/v1/workspaces` }).end();
    });
    const { id } = await host.add(redirecting);
    await host.useToken(id, pat);
    const reply = await host.api({ server: id, method: "GET", path: "/api/v1/workspaces" });
    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBe(`${elsewhere}/api/v1/workspaces`);
    expect(seenElsewhere).toEqual([]);
  });

  it("never printed a token: no result, error or event of the harness, nor its server list, holds one", async () => {
    const list = await readFile(`${dataDir}/servers.json`, "utf8");
    const all = [...printed, list];
    expect(printed.length).toBeGreaterThan(20);
    for (const line of all) {
      expect(line).not.toMatch(/thoth_(at|rt|pat)_/);
      for (const secret of [...secrets, ...issuer.recorded.codes, ...issuer.recorded.accessTokens, ...issuer.recorded.idTokens]) expect(line.includes(secret)).toBe(false);
    }
  });
});
