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

/** Longest label shown, matching the reference server's `SERVER_NAME` limit and the desktop host. */
const MAX_LABEL = 64;

/**
 * The server's display name (`capabilities.server.name`) without control characters, trimmed and kept to 64
 * characters; its host name (without the port) when it sends none, as the desktop host does.
 */
export function serverLabel(capabilities: Capabilities, server: string): string {
  const name = [...(capabilities.server?.name ?? "").replace(/\p{Cc}/gu, "").trim()].slice(0, MAX_LABEL).join("").trimEnd();
  return name === "" ? new URL(server).hostname : name;
}

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
      label: serverLabel(capabilities, server),
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
    // An attachment's bytes (ADR-0028): as base64, the way the desktop host sends them.
    if (args.responseBytes && res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { status: res.status, headers, body: "", bodyBase64: btoa(binary) };
    }
    return { status: res.status, headers, body: await res.text() };
  }

  /**
   * Change hints of one workspace (ADR-0041) over `fetch`, not `EventSource`, so the bearer token stays in a header.
   * Only `event: changes` lines count; their payload is not read (a hint is not data, ADR-0004). A 401 renews the
   * token once, as `call` does; any other answer or a dropped stream ends it and the app polls.
   */
  events(server: string, workspace: string, on: { open(): void; hint(): void; end(): void }): () => void {
    const abort = new AbortController();
    let closed = false;
    const url = new URL(`/api/v1/workspaces/${encodeURIComponent(workspace)}/events`, this.deps.server);
    const connect = (token: string | null) =>
      this.deps.fetch(url, { headers: { accept: "text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, redirect: "error", credentials: "omit", cache: "no-store", signal: abort.signal });
    void (async () => {
      if (server !== SERVER_ID) throw new Error("Unknown server");
      const token = await this.deps.auth.token();
      let res = await connect(token);
      if (res.status === 401 && token) {
        const next = await this.deps.auth.renew(token).catch(() => null);
        if (next) res = await connect(next);
      }
      if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").startsWith("text/event-stream")) return;
      on.open();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value.replace(/\r\n?/g, "\n");
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.split("\n").some((line) => line.replace(/^event:\s?/, "") === "changes" && line.startsWith("event:"))) on.hint();
        }
        if (buffer.length > 65_536) return; // no frame is this long: not a stream to trust
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        if (!closed) on.end();
      });
    return () => {
      closed = true;
      abort.abort();
    };
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
