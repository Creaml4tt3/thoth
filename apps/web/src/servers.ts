/**
 * The web client's side of the shared workspace state: a `Servers` port with exactly one server, the one fixed at
 * build time. `call` is `fetch` with the in-memory access token; a 401 refreshes once from the cookie and retries,
 * as the desktop's host does. Only `/api/v1/` paths are sent, and redirects are never followed, so the bearer
 * token cannot be carried anywhere else.
 */
import type { ApiCallArgs, ApiCallResult, ServerInfo, Servers } from "@thoth/platform";
import type { Capabilities } from "@thoth/workspace-protocol";
import type { AuthSession } from "./auth.ts";

export const SERVER_ID = "trial";

const SAFE_PATH = /^\/api\/v1\/[A-Za-z0-9._~%/-]*$/;
const RESPONSE_HEADERS = ["content-type", "etag", "location", "retry-after"];

export interface WebServersDeps {
  server: string;
  capabilities: Capabilities;
  auth: AuthSession;
  fetch: typeof fetch;
  /** The signed-in account, from `GET /me`. */
  account(): ServerInfo["account"] | undefined;
}

export class WebServers implements Servers {
  private readonly deps: WebServersDeps;

  constructor(deps: WebServersDeps) {
    this.deps = deps;
  }

  info(): ServerInfo {
    const { capabilities, server, auth } = this.deps;
    const account = this.deps.account();
    return {
      id: SERVER_ID,
      url: server,
      label: capabilities.server?.name ?? new URL(server).host,
      auth: auth.status === "signed-out" ? "signed-out" : "browser",
      ...(account && auth.status !== "signed-out" ? { account } : {}),
      providers: capabilities.signIn?.providers ?? [],
      ...(capabilities.limits ? { limits: capabilities.limits as Record<string, number> } : {}),
    };
  }

  async list(): Promise<ServerInfo[]> {
    return [this.info()];
  }

  async call(args: ApiCallArgs, body?: Uint8Array): Promise<ApiCallResult> {
    if (args.server !== SERVER_ID) throw new Error("Unknown server");
    if (!SAFE_PATH.test(args.path) || args.path.includes("..") || args.path.includes("//")) throw new Error("Refused path");
    const url = new URL(args.path, this.deps.server);
    if (url.origin !== this.deps.server) throw new Error("Refused path");
    if (args.query) url.search = new URLSearchParams(args.query).toString();

    const send = async (token: string | null): Promise<Response> => {
      const headers: Record<string, string> = { ...(args.headers ?? {}) };
      if (token) headers["authorization"] = `Bearer ${token}`;
      return this.deps.fetch(url, {
        method: args.method,
        headers,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        ...(body === undefined ? {} : { body: body as BodyInit }),
      });
    };

    const token = await this.deps.auth.token();
    let res = await send(token);
    if (res.status === 401 && token) {
      const next = await this.deps.auth.renew(token).catch(() => null);
      if (next) res = await send(next);
    }
    const headers: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = res.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return { status: res.status, headers, body: await res.text() };
  }

  // The web client has one fixed server: there is nothing to add, remove or sign in to through this port.
  add(): Promise<ServerInfo> {
    return Promise.reject(new Error("The web client connects only to its own server."));
  }
  remove(): Promise<void> {
    return Promise.reject(new Error("The web client connects only to its own server."));
  }
  signIn(): Promise<ServerInfo> {
    return Promise.reject(new Error("Sign in from the sign-in page."));
  }
  cancelSignIn(): Promise<void> {
    return Promise.resolve();
  }
  useToken(): Promise<ServerInfo> {
    return Promise.reject(new Error("Personal access tokens are not used in the browser."));
  }
  async signOut(): Promise<ServerInfo> {
    await this.deps.auth.signOut();
    return this.info();
  }
}
