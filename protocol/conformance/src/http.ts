import { buildRequestPath, getRoute, validateResponse, validateUnroutedProblem, type ObservedResponse } from "@thoth/workspace-protocol";

export interface CallInit {
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  /** JSON request body. */
  json?: unknown;
  /** Raw request body (sent as given, with the Content-Type header from `headers`). */
  body?: Uint8Array | string;
  /** `token` (default for non-public routes), `none`, or `bad` (a syntactically valid but unknown credential). */
  auth?: "token" | "none" | "bad";
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  contentType: string | null;
  /** Parsed JSON body or undefined. */
  body: unknown;
  bytes: Uint8Array;
  /** Registry validation issues. Empty means the response conforms to the contract. */
  issues: string[];
}

export interface Violation {
  operation: string;
  status: number;
  issues: string[];
}

export interface Client {
  call(operationId: string, init?: CallInit): Promise<ApiResponse>;
  /** A request to a path that matches no route. Validated as a generic problem response. */
  unrouted(method: string, path: string, init?: CallInit): Promise<ApiResponse>;
  /** Opens a streaming GET for a route (SSE). The caller aborts the controller. */
  stream(operationId: string, init: CallInit, controller: AbortController): Promise<{ response: Response; issues: string[] }>;
  /**
   * A GET outside /api/v1 without any credential, for the public pages of a capability (`public-share`: `/s/<token>`).
   * Not validated against the route registry; the check asserts what it needs.
   */
  publicGet(path: string, accept: string): Promise<{ status: number; headers: Headers; text: string }>;
  redact(text: string): string;
  violations: Violation[];
  /** Number of HTTP responses received and validated so far. */
  stats: { responses: number };
}

const BAD_TOKEN = "thoth-conformance-invalid-credential";

export function createClient(options: { baseUrl: string; token: string; fetch?: typeof fetch }): Client {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const violations: Violation[] = [];
  const stats = { responses: 0 };

  const redact = (text: string): string => (options.token ? text.split(options.token).join("[redacted]") : text);

  function buildHeaders(init: CallInit, isPublic: boolean): Headers {
    const headers = new Headers({ accept: "application/json, application/problem+json" });
    const auth = init.auth ?? (isPublic ? "none" : "token");
    if (auth === "token") headers.set("authorization", `Bearer ${options.token}`);
    else if (auth === "bad") headers.set("authorization", `Bearer ${BAD_TOKEN}`);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
    return headers;
  }

  function buildUrl(path: string, query: CallInit["query"]): string {
    const qs = Object.entries(query ?? {})
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return `${base}${path}${qs ? `?${qs}` : ""}`;
  }

  function requestBody(init: CallInit): string | Uint8Array<ArrayBuffer> | undefined {
    if (init.json !== undefined) return JSON.stringify(init.json);
    if (init.body === undefined) return undefined;
    if (typeof init.body === "string") return init.body;
    return new Uint8Array(init.body);
  }

  async function execute(method: string, url: string, headers: Headers, body: string | Uint8Array<ArrayBuffer> | undefined, label: string): Promise<{ status: number; headers: Headers; contentType: string | null; bytes: Uint8Array; body: unknown; unparseable: boolean }> {
    let res: Response;
    try {
      res = await doFetch(url, { method, headers, ...(body === undefined ? {} : { body }), redirect: "manual" });
    } catch (error) {
      throw new Error(redact(`network error calling ${label}: ${error instanceof Error ? error.message : String(error)}`));
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let parsed: unknown;
    let unparseable = false;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        unparseable = true;
      }
    }
    return { status: res.status, headers: res.headers, contentType: res.headers.get("content-type"), bytes, body: parsed, unparseable };
  }

  return {
    violations,
    stats,
    redact,
    async call(operationId, init = {}) {
      const route = getRoute(operationId);
      const path = buildRequestPath(route, init.params);
      const raw = await execute(route.method.toUpperCase(), buildUrl(path, init.query), buildHeaders(init, route.public), requestBody(init), operationId);
      stats.responses++;
      const observed: ObservedResponse = { status: raw.status, contentType: raw.contentType, body: raw.body, bodyUnparseable: raw.unparseable };
      const issues = validateResponse(route, observed).map((i) => redact(i));
      if (issues.length) violations.push({ operation: operationId, status: raw.status, issues });
      return { status: raw.status, headers: raw.headers, contentType: raw.contentType, body: raw.body, bytes: raw.bytes, issues };
    },
    async unrouted(method, path, init = {}) {
      const raw = await execute(method, buildUrl(path, init.query), buildHeaders(init, false), requestBody(init), `${method} unrouted path`);
      stats.responses++;
      const observed: ObservedResponse = { status: raw.status, contentType: raw.contentType, body: raw.body, bodyUnparseable: raw.unparseable };
      const issues = raw.status >= 400 ? validateUnroutedProblem(observed).map((i) => redact(i)) : [`expected an error response, got HTTP ${raw.status}`];
      if (issues.length) violations.push({ operation: `${method} ${path}`, status: raw.status, issues });
      return { status: raw.status, headers: raw.headers, contentType: raw.contentType, body: raw.body, bytes: raw.bytes, issues };
    },
    async publicGet(path, accept) {
      if (!path.startsWith("/") || path.startsWith("//")) throw new Error("publicGet takes a path on the server's origin");
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, { method: "GET", headers: { accept }, redirect: "manual" });
      } catch (error) {
        throw new Error(redact(`network error calling GET ${path}: ${error instanceof Error ? error.message : String(error)}`));
      }
      stats.responses++;
      return { status: res.status, headers: res.headers, text: await res.text() };
    },
    async stream(operationId, init, controller) {
      const route = getRoute(operationId);
      const path = buildRequestPath(route, init.params);
      const headers = buildHeaders(init, route.public);
      headers.set("accept", "text/event-stream");
      let response: Response;
      try {
        response = await doFetch(buildUrl(path, init.query), { method: "GET", headers, signal: controller.signal });
      } catch (error) {
        throw new Error(redact(`network error calling ${operationId}: ${error instanceof Error ? error.message : String(error)}`));
      }
      const issues = response.status === 200 ? validateResponse(route, { status: 200, contentType: response.headers.get("content-type"), body: undefined }) : [`expected HTTP 200, got ${response.status}`];
      return { response, issues: issues.map((i) => redact(i)) };
    },
  };
}
