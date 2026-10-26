import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Deps } from "../deps.ts";
import { ApiError } from "../errors.ts";
import { bodyOf, headerOf } from "../http.ts";
import { FORM_REFERRER_POLICY, INVITE_HEADERS, WORDS, donePage, invitePage, langOf, messagePage, readyPage, type Lang } from "../invite/html.ts";
import { acceptInviteIn, activeInviteById, memberRole, resolveInvite } from "../invites.ts";
import { clientIp, hit } from "../ratelimit.ts";
import { cookieValue, type SignInBroker } from "../signin/routes.ts";

/** How long a browser that signed in from an invite page may take to send the join form. */
const TICKET_TTL_SECONDS = 900;
const FORM_LIMIT = 4096;

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/** The join form's CSRF value: derived from the ticket cookie, so only the browser holding the cookie can know it. */
const csrfFor = (ticket: string) => sha256Hex(`thoth-invite-csrf\n${ticket}`);

function sameSecret(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

export interface InvitePages {
  /** The sign-in broker, once it is registered (absent on a server without sign-in providers). */
  useBroker(broker: SignInBroker | undefined): void;
  /** The broker's callback for a sign-in started here: give this browser a join ticket and send it to the form. */
  signedIn(request: FastifyRequest, reply: FastifyReply, account: { userId: string; inviteId: string }): Promise<FastifyReply>;
}

/**
 * ADR-0024 rule 3: the unauthenticated invite pages on the server origin.
 *
 * - `GET /i/<token>`: the invitation (workspace name, inviter's display name, role) and "Sign in with … to join".
 * - `GET /i/<token>/sign-in?provider=<id>`: starts a sign-in through the broker that comes back here, not to a client.
 * - `GET /i/accept`: for the browser holding a join ticket (an HttpOnly cookie set by that sign-in), the join form.
 * - `POST /i/accept`: the join itself, with the form's CSRF value and this origin's `Origin`. The ticket is single use.
 *
 * Every failure is the same 404 page; rate limits (per client IP) run before any lookup.
 */
export function registerInvitePages(app: FastifyInstance, deps: Deps): InvitePages {
  const { db, config } = deps;
  const enabled = config.capabilities.includes("invite-links");
  const signIn = config.signIn;
  // The web client lives where its sign-in returns to: `<origin><base path>callback`.
  const webClient = signIn?.webRedirectUris[0] ? new URL(".", signIn.webRedirectUris[0]).toString() : null;
  const secure = signIn?.publicUrl.startsWith("https:") ?? false;
  const ticketCookie = secure ? "__Host-thoth_join" : "thoth_join";
  const cookie = (value: string, maxAge: number) => `${ticketCookie}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  let broker: SignInBroker | undefined;

  const lang = (request: FastifyRequest): Lang => langOf(headerOf(request, "accept-language"));

  function html(reply: FastifyReply, status: number, body: string, extra: Record<string, string> = {}): FastifyReply {
    reply.code(status);
    for (const [name, value] of Object.entries({ ...INVITE_HEADERS, ...extra })) reply.header(name, value);
    return reply.header("content-type", "text/html; charset=utf-8").send(body);
  }

  /** The one answer for every invite address that does not work (in the browser's language). */
  const notFound = (request: FastifyRequest, reply: FastifyReply) => {
    const w = WORDS[lang(request)];
    return html(reply, 404, messagePage(lang(request), w.missingTitle, w.missingText));
  };

  /** Counts the request against the per-IP limit of its kind; a refusal is the 429 page. */
  async function limited(request: FastifyRequest, reply: FastifyReply, kind: "open" | "accept"): Promise<FastifyReply | null> {
    const limit = kind === "open" ? config.invite.opensPerIp : config.invite.acceptsPerIp;
    if (limit === undefined) return null;
    const decision = await hit(db, `invite-${kind}-ip:${clientIp(request.headers, request.socket.remoteAddress, config.trustProxy)}`, limit, config.rateLimit.windowSeconds);
    if (decision.allowed) return null;
    const w = WORDS[lang(request)];
    return html(reply, 429, messagePage(lang(request), w.busyTitle, w.busyText), { "retry-after": String(decision.retryAfterSeconds) });
  }

  /** The live, unused ticket the browser's cookie names, with the account it signed in as. */
  async function ticketOf(request: FastifyRequest): Promise<{ value: string; userId: string; inviteId: string; account: string } | null> {
    const value = cookieValue(headerOf(request, "cookie"), ticketCookie);
    if (value === undefined) return null;
    const { rows } = await db.query<{ user_id: string; invite_id: string; display_name: string }>(
      `SELECT t.user_id, t.invite_id, u.display_name FROM invite_tickets t JOIN users u ON u.id = t.user_id
        WHERE t.ticket_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
      [sha256Hex(value)],
    );
    const row = rows[0];
    return row ? { value, userId: row.user_id, inviteId: row.invite_id, account: row.display_name } : null;
  }

  const serverName = () => signIn?.publicUrl ?? config.publicUrl ?? "";

  // ------------------------------------------------------------------ the join form (after sign-in)

  app.get("/i/accept", async (request, reply) => {
    if (!enabled || signIn === undefined) return notFound(request, reply);
    const refused = await limited(request, reply, "open");
    if (refused) return refused;
    const ticket = await ticketOf(request);
    const invite = ticket ? await activeInviteById(db, ticket.inviteId) : null;
    if (!ticket || !invite) return notFound(request, reply);
    const l = lang(request);
    const role = await memberRole(db, invite.workspaceId, ticket.userId);
    if (role) return html(reply, 200, donePage(l, { workspace: invite.workspaceName, role, joined: false, webClient, server: serverName() }));
    return html(reply, 200, readyPage(l, { workspace: invite.workspaceName, role: invite.role, account: ticket.account, csrf: csrfFor(ticket.value) }), { "referrer-policy": FORM_REFERRER_POLICY });
  });

  app.post("/i/accept", async (request, reply) => {
    if (!enabled || signIn === undefined) return notFound(request, reply);
    const refused = await limited(request, reply, "accept");
    if (refused) return refused;
    const ticket = await ticketOf(request);
    if (!ticket) return notFound(request, reply);
    const l = lang(request);
    const w = WORDS[l];
    const stale = () => html(reply, 403, messagePage(l, w.staleTitle, w.staleText));
    // CSRF: the cookie is SameSite=Lax, the request must come from this origin, and the form must carry the value derived
    // from the cookie. "From this origin": `Origin` names it, or (a browser that sends `Origin: null`) the browser's own
    // Fetch Metadata says so; a page on another site can set neither.
    const origin = headerOf(request, "origin");
    const fromHere = origin === signIn.publicUrl || ((origin === undefined || origin === "null") && headerOf(request, "sec-fetch-site") === "same-origin");
    if (!fromHere) return stale();
    const type = (headerOf(request, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const body = bodyOf(request);
    if (type !== "application/x-www-form-urlencoded" || body.length > FORM_LIMIT) return stale();
    const form = new URLSearchParams(body.toString("utf8"));
    const csrf = form.getAll("csrf");
    if (csrf.length !== 1 || !sameSecret(csrf[0]!, csrfFor(ticket.value))) return stale();

    const invite = await activeInviteById(db, ticket.inviteId);
    if (!invite) return notFound(request, reply);
    try {
      const accepted = await db.tx(async (tx) => {
        // Single use: the ticket row is locked and burnt in the same transaction as the join (a refusal keeps it).
        const live = await tx.query("SELECT 1 FROM invite_tickets WHERE ticket_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE", [sha256Hex(ticket.value)]);
        if (live.rowCount === 0) throw new ApiError("not_found", "no such invite");
        const result = await acceptInviteIn(tx, ticket.inviteId, ticket.userId, config);
        await tx.query("UPDATE invite_tickets SET used_at = now() WHERE ticket_hash = $1", [sha256Hex(ticket.value)]);
        return result;
      });
      reply.header("set-cookie", cookie("", 0));
      return html(reply, 200, donePage(l, { workspace: accepted.name, role: accepted.role, joined: accepted.joined, webClient, server: serverName() }));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === "quota_exceeded") {
        return html(reply, 409, readyPage(l, { workspace: invite.workspaceName, role: invite.role, account: ticket.account, csrf: csrfFor(ticket.value), notice: { title: w.fullTitle, text: w.fullText(invite.workspaceName) } }), { "referrer-policy": FORM_REFERRER_POLICY });
      }
      if (error.code === "not_found") return notFound(request, reply);
      throw error;
    }
  });

  // ------------------------------------------------------------------ the invitation and the sign-in start

  app.get<{ Params: { token: string } }>("/i/:token", async (request, reply) => {
    if (!enabled) return notFound(request, reply);
    const refused = await limited(request, reply, "open");
    if (refused) return refused;
    const invite = await resolveInvite(db, request.params.token);
    if (!invite) return notFound(request, reply);
    const providers = broker?.providers ?? [];
    const token = encodeURIComponent(request.params.token);
    return html(
      reply,
      200,
      invitePage(lang(request), {
        workspace: invite.workspaceName,
        inviter: invite.inviterName,
        role: invite.role,
        signIn: providers.map((p) => ({ name: p.name, href: `/i/${token}/sign-in?provider=${encodeURIComponent(p.id)}` })),
      }),
    );
  });

  app.get<{ Params: { token: string }; Querystring: Record<string, string | string[] | undefined> }>("/i/:token/sign-in", async (request, reply) => {
    if (!enabled || broker === undefined) return notFound(request, reply);
    const refused = await limited(request, reply, "open");
    if (refused) return refused;
    const provider = request.query.provider;
    const invite = await resolveInvite(db, request.params.token);
    if (!invite || typeof provider !== "string") return notFound(request, reply);
    if (!(await broker.startInvite(reply, provider, invite.id))) return notFound(request, reply);
    return reply;
  });

  // Anything else under /i/ is the same 404 as an unknown token.
  app.get("/i/*", (request, reply) => notFound(request, reply));

  return {
    useBroker(next) {
      broker = next;
    },
    async signedIn(_request, reply, account) {
      const value = randomBytes(32).toString("base64url");
      await db.query("INSERT INTO invite_tickets (ticket_hash, invite_id, user_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))", [sha256Hex(value), account.inviteId, account.userId, TICKET_TTL_SECONDS]);
      reply.header("set-cookie", cookie(value, TICKET_TTL_SECONDS));
      reply.header("referrer-policy", "no-referrer");
      reply.header("location", `${signIn!.publicUrl}/i/accept`);
      return reply.code(302).send();
    },
  };
}
