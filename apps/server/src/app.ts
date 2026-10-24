import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from "fastify";
import { API_BASE_PATH } from "@thoth/workspace-protocol";
import type { Deps } from "./deps.ts";
import { isUnavailable } from "./db.ts";
import { ApiError, problemReply } from "./errors.ts";
import { corsHeaders, isPreflight } from "./cors.ts";
import { send } from "./http.ts";
import { clientIp, hit } from "./ratelimit.ts";
import { registerMaintenanceRoutes } from "./routes/maintenance.ts";
import { registerAttachmentRoutes } from "./routes/attachments.ts";
import { registerCoreRoutes } from "./routes/core.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerSearchRoutes } from "./routes/search.ts";
import { registerTransferRoutes } from "./routes/transfers.ts";
import { authErrorReply, isAuthCorsPath, isAuthPath, registerSignInRoutes } from "./signin/routes.ts";
import type { CapabilityId } from "@thoth/workspace-protocol";

/** Everything that could carry a credential or content is removed from log lines. */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["idempotency-key"]',
  "res.headers['set-cookie']",
  "headers.authorization",
  "authorization",
  "token",
  "*.token",
  "*.authorization",
  "databaseUrl",
  "*.databaseUrl",
  "connectionString",
  "cronSecret",
  "*.cronSecret",
  // Sign-in: OAuth parameters and provider credentials, wherever a handler might put them.
  // `code` and `state` are common words (an error's `code`), so only where OAuth parameters would sit.
  "code",
  "state",
  "query.code",
  "query.state",
  "params.code",
  "params.state",
  "form.code",
  "form.state",
  "refresh_token",
  "*.refresh_token",
  "access_token",
  "*.access_token",
  "id_token",
  "*.id_token",
  "code_verifier",
  "*.code_verifier",
  "nonce",
  "*.nonce",
  "client_secret",
  "*.client_secret",
  "clientSecret",
  "*.clientSecret",
  "signIn.providers[*].clientSecret",
  "*.signIn.providers[*].clientSecret",
];

export interface BuildOptions {
  /** Pino destination, so tests can capture log output. */
  logStream?: { write(line: string): void };
}

/** Route capability gate: a route of an unlisted capability is 501, never a pretend success. */
const CAPABILITY_ROUTES: { capability: CapabilityId; test: (method: string, path: string) => boolean }[] = [
  { capability: "attachments", test: (_m, p) => /^\/workspaces\/[^/]+\/attachments(\/[^/]+)?$/.test(p) },
  { capability: "search", test: (m, p) => m === "POST" && /^\/workspaces\/[^/]+\/search$/.test(p) },
  { capability: "events.sse", test: (m, p) => m === "GET" && /^\/workspaces\/[^/]+\/events$/.test(p) },
  { capability: "page-order", test: (m, p) => m === "POST" && /^\/workspaces\/[^/]+\/pages\/[^/]+\/move$/.test(p) },
  { capability: "transfers", test: (_m, p) => /^\/workspaces\/[^/]+\/transfers$/.test(p) || /^\/transfers\/[^/]+(\/(commit|abort))?$/.test(p) },
];

export function buildApp(deps: Deps, options: BuildOptions = {}): FastifyInstance {
  const { config } = deps;
  const capabilities = new Set<string>(config.capabilities);
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: LOG_REDACT_PATHS, censor: "[redacted]" },
      // The default request serializer logs method, url, host and remote address; headers only via the redact paths above.
      serializers: {
        req: (req: { method?: string; url?: string; id?: string }) => ({ method: req.method, url: (req.url ?? "").split("?")[0], id: req.id }),
      },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    requestIdHeader: false,
    bodyLimit: 1_048_576,
    routerOptions: { maxParamLength: 512 },
    trustProxy: false,
  } as FastifyServerOptions);

  const templates: { method: string; pattern: RegExp }[] = [];
  app.addHook("onRoute", (route) => {
    const pattern = new RegExp(`^${route.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]+/g, "[^/]+")}/?$`);
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) templates.push({ method, pattern });
  });

  // Every body is kept as raw bytes: idempotency fingerprints hash the exact bytes, and JSON is parsed by handlers.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  const { rateLimit } = config;
  const limitedByIp = rateLimit.perIp !== undefined;
  const limitedByAccount = rateLimit.perAccount !== undefined;

  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    const path = request.url.split("?")[0] ?? "";
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    // CORS headers go on every reply (also errors and 404/405) for an allowed origin; others get none and the browser blocks them.
    const preflight = isPreflight(request.method, request.headers);
    // Sign-in: only the fetch()ed endpoints (token, revoke) are CORS resources; authorize and callbacks are navigations.
    const auth = isAuthPath(path);
    const corsPath = !auth || isAuthCorsPath(path);
    if (corsPath) for (const [name, value] of Object.entries(corsHeaders(config.corsOrigins, origin, preflight))) reply.header(name, value);
    // A preflight carries no credentials by design: answered here, before authentication and rate limiting.
    if (preflight && config.corsOrigins.length > 0 && (path === API_BASE_PATH || path.startsWith(`${API_BASE_PATH}/`) || (auth && corsPath && config.signIn !== undefined))) return reply.code(204).send();
    // /auth/* is rate limited per IP like /api/v1, and needs no bearer credential (it is how one is obtained).
    if (auth) {
      if (limitedByIp && config.signIn !== undefined) await enforce(`ip:${clientIp(request.headers, request.socket.remoteAddress, config.trustProxy)}`, rateLimit.perIp!);
      return;
    }
    if (!path.startsWith(`${API_BASE_PATH}/`)) return;
    const route = path.slice(API_BASE_PATH.length);
    if (limitedByIp) await enforce(`ip:${clientIp(request.headers, request.socket.remoteAddress, config.trustProxy)}`, rateLimit.perIp!);
    if (route === "/capabilities") return;
    const gate = CAPABILITY_ROUTES.find((c) => c.test(request.method, route));
    request.principal = null;
    // Authenticate first: an unauthenticated caller learns nothing, not even which capabilities exist.
    const principal = await deps.authenticator.authenticate({ headers: request.headers });
    if (!principal) throw new ApiError("unauthenticated", "a valid bearer credential is required");
    request.principal = principal;
    if (limitedByAccount) await enforce(`acct:${principal.id}`, rateLimit.perAccount!);
    if (gate && !capabilities.has(gate.capability)) throw new ApiError("capability_not_supported", `capability ${gate.capability} is not supported`);
  });

  /** One upsert per check. A denied request is 429 with the seconds until the window ends. */
  async function enforce(key: string, limit: number): Promise<void> {
    const decision = await hit(deps.db, key, limit, rateLimit.windowSeconds);
    if (!decision.allowed) throw new ApiError("rate_limited", "too many requests; retry after the time in the Retry-After header", {}, { "retry-after": String(decision.retryAfterSeconds) });
  }

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (config.signIn !== undefined && isAuthPath(path)) {
      // OAuth endpoints answer OAuth JSON or an HTML page, never a problem document; nothing about the request is logged.
      if (error instanceof ApiError) return authErrorReply(path, error, reply);
      const code = (error as FastifyError).code;
      if (typeof code === "string" && code.startsWith("FST_ERR_CTP_")) return authErrorReply(path, new ApiError("validation_failed", "the request body is malformed"), reply);
      if (isUnavailable(error)) {
        request.log.error({ err: { code: (error as { code?: string }).code } }, "database unavailable");
        return authErrorReply(path, new ApiError("service_unavailable", "unavailable", {}, { "retry-after": "2" }), reply);
      }
      request.log.error({ err: { name: error.name } }, "sign-in: unhandled error");
      return authErrorReply(path, new ApiError("internal_error", "unexpected server failure"), reply);
    }
    let apiError: ApiError;
    if (error instanceof ApiError) apiError = error;
    else {
      const code = (error as FastifyError).code;
      if (code === "FST_ERR_CTP_BODY_TOO_LARGE") apiError = new ApiError("payload_too_large", "the request body exceeds the limit advertised in /capabilities");
      else if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" && request.method === "POST" && /\/attachments$/.test(request.url.split("?")[0] ?? "")) apiError = new ApiError("unsupported_media_type", "Content-Type must be a valid media type");
      else if (code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH" || code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || code === "FST_ERR_CTP_EMPTY_JSON_BODY") apiError = new ApiError("validation_failed", "the request body is malformed");
      else if (isUnavailable(error)) {
        request.log.error({ err: { message: error.message, code: (error as { code?: string }).code } }, "database unavailable");
        apiError = new ApiError("service_unavailable", "the server is temporarily unable to handle the request", {}, { "retry-after": "2" });
      } else {
        request.log.error({ err: { message: error.message, stack: error.stack } }, "unhandled error");
        apiError = new ApiError("internal_error", "unexpected server failure");
      }
    }
    send(reply, problemReply(apiError, request.id));
  });

  // 404 for an unknown path; 405 with Allow when the path exists for other methods.
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const allowed = methodsFor(templates, path).filter((m) => m !== "HEAD");
    if (allowed.length > 0) return send(reply, problemReply(new ApiError("method_not_allowed", "method not allowed", {}, { allow: allowed.join(", ") }), request.id));
    return send(reply, problemReply(new ApiError("not_found", "no such route"), request.id));
  });

  registerCoreRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerAttachmentRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerTransferRoutes(app, deps);
  registerMaintenanceRoutes(app, deps);
  registerSignInRoutes(app, deps);
  return app;
}

/** Methods registered for a concrete path, by matching it against the registered `:param` templates. */
function methodsFor(templates: { method: string; pattern: RegExp }[], path: string): string[] {
  return [...new Set(templates.filter((t) => t.pattern.test(path)).map((t) => t.method))].sort();
}
