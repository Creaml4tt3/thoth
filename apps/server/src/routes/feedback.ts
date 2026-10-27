import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_BASE_PATH, FeedbackRequestSchema } from "@thoth/workspace-protocol";
import type { Deps } from "../deps.ts";
import { ApiError, zodFailure } from "../errors.ts";
import { enforceFeedbackLimits, feedbackIpHash, storeFeedback } from "../feedback.ts";
import { FEEDBACK_PAGE_HEADERS, busyPage, fixPage, thanksPage, type FeedbackLang } from "../feedback-html.ts";
import { bodyOf, headerOf, parseJsonBody } from "../http.ts";
import { clientIp } from "../ratelimit.ts";

const FORM_TYPE = "application/x-www-form-urlencoded";
const FORM_LIMIT = 32 * 1024;

/**
 * `POST /api/v1/feedback` (ADR-0033). JSON from the apps; form-encoded from the website's no-JavaScript form, which
 * gets an HTML page back. Authentication is optional and done by the onRequest hook (`request.principal`), which also
 * answers 501 when the capability is off. Order: parse and validate, honeypot, rate limits, store. Nothing is stored
 * for a refused request.
 */
export function registerFeedbackRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, config } = deps;

  app.post(`${API_BASE_PATH}/feedback`, async (request, reply) => {
    const type = (headerOf(request, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type === FORM_TYPE) return form(request, reply);
    if (type !== "application/json") throw new ApiError("unsupported_media_type", "Content-Type must be application/json");
    const parsed = FeedbackRequestSchema.safeParse(parseJsonBody(request));
    if (!parsed.success) throw zodFailure(parsed.error);
    if (parsed.data.website) return reply.code(204).send();
    await accept(request, parsed.data);
    return reply.code(204).send();
  });

  async function accept(request: FastifyRequest, input: Parameters<typeof storeFeedback>[1]): Promise<void> {
    const ipHash = await feedbackIpHash(db, clientIp(request.headers, request.socket.remoteAddress, config.trustProxy));
    const accountId = request.principal?.id ?? null;
    await enforceFeedbackLimits(db, ipHash, accountId);
    await storeFeedback(db, input, { accountId, ipHash });
  }

  /** The website's plain form POST: only from an origin the server allows, and an HTML page in its language back. */
  async function form(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const origin = headerOf(request, "origin");
    const allowed = origin !== undefined && (config.corsOrigins.includes(origin) || origin === config.publicUrl);
    if (!allowed) throw new ApiError("forbidden", "the feedback form must be sent from a site this server allows");
    const raw = bodyOf(request);
    if (raw.length > FORM_LIMIT) throw new ApiError("payload_too_large", "the form is too large");
    const fields = new URLSearchParams(raw.toString("utf8"));
    const text = (name: string) => {
      const value = fields.get(name);
      return value === null || value.trim() === "" ? undefined : value;
    };
    const lang: FeedbackLang = text("language") === "th" ? "th" : "en";
    // A path on the origin the form came from, never another site (`//host` is a host, not a path).
    const path = text("return");
    const back = path !== undefined && /^\/(?![/\\])[A-Za-z0-9/_.-]*$/.test(path) ? `${origin}${path}` : null;
    const page = (status: number, html: string, headers: Record<string, string> = {}) => {
      reply.code(status);
      for (const [name, value] of Object.entries({ ...FEEDBACK_PAGE_HEADERS, ...headers })) reply.header(name, value);
      return reply.header("content-type", "text/html; charset=utf-8").send(html);
    };

    const context = Object.fromEntries((["client", "version", "os", "language"] as const).flatMap((k) => (text(k) === undefined ? [] : [[k, text(k)!]])));
    const candidate = {
      kind: fields.get("kind") ?? undefined,
      // The message is kept as typed (a blank one is refused by the schema).
      message: fields.get("message") ?? "",
      ...(text("email") === undefined ? {} : { email: text("email")!.trim() }),
      ...(Object.keys(context).length === 0 ? {} : { context }),
      ...(text("website") === undefined ? {} : { website: text("website") }),
    };
    const parsed = FeedbackRequestSchema.safeParse(candidate);
    if (!parsed.success) return page(400, fixPage(lang, parsed.error.issues.map((i) => String(i.path[0] ?? "message")), back));
    if (parsed.data.website) return page(200, thanksPage(lang, back));
    try {
      await accept(request, parsed.data);
    } catch (error) {
      if (error instanceof ApiError && error.code === "rate_limited") return page(429, busyPage(lang, back), error.headers);
      throw error;
    }
    return page(200, thanksPage(lang, back));
  }
}
