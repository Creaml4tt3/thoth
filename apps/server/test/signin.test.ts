import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SignInConfig } from "../src/config.ts";
import { redirectAllowed } from "../src/signin/clients.ts";
import { chooserPage, errorPage, escapeHtml } from "../src/signin/html.ts";
import { TokenRejected, verifyIdToken, type Jwk } from "../src/signin/jwt.ts";
import { cookieValue } from "../src/signin/routes.ts";
import { pkceMatches, s256 } from "../src/signin/secrets.ts";

const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const ISS = "https://issuer.example";
const AUD = "client-1";
const NONCE = "n-0123456789";
const now = Math.floor(Date.now() / 1000);

function keyPair(type: "rsa" | "ec", kid: string): { privateKey: KeyObject; jwk: Jwk } {
  const { privateKey, publicKey } = type === "rsa" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, jwk: { ...(publicKey.export({ format: "jwk" }) as Jwk), kid } };
}

const rsa = keyPair("rsa", "r1");
const ec = keyPair("ec", "e1");

function token(claims: Record<string, unknown>, opts: { alg?: string; kid?: string; key?: KeyObject; hmacSecret?: string } = {}): string {
  const alg = opts.alg ?? "RS256";
  const header = { alg, typ: "JWT", ...(opts.kid === undefined ? { kid: "r1" } : opts.kid === "" ? {} : { kid: opts.kid }) };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify({ iss: ISS, aud: AUD, sub: "s1", iat: now, exp: now + 300, nonce: NONCE, ...claims }))}`;
  if (alg === "none") return `${input}.`;
  if (alg.startsWith("HS")) return `${input}.${createHmac("sha256", opts.hmacSecret ?? "secret").update(input).digest("base64url")}`;
  if (alg === "ES256") return `${input}.${sign("sha256", Buffer.from(input), { key: opts.key ?? ec.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  return `${input}.${sign("sha256", Buffer.from(input), opts.key ?? rsa.privateKey).toString("base64url")}`;
}

const keys = (set: Jwk[]) => async () => set;
const expectation = { issuer: ISS, clientId: AUD, nonce: NONCE };
const reason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(TokenRejected);
    return (error as TokenRejected).reason;
  }
  return "accepted";
};

describe("ID token verification (unit)", () => {
  it("accepts RS256 and ES256 tokens with every claim right", async () => {
    expect((await verifyIdToken(token({}), keys([rsa.jwk, ec.jwk]), expectation)).sub).toBe("s1");
    expect((await verifyIdToken(token({}, { alg: "ES256", kid: "e1" }), keys([rsa.jwk, ec.jwk]), expectation)).sub).toBe("s1");
  });

  it("refuses none, HS256 (even keyed with an 'oct' JWK), and an algorithm/key-type mismatch", async () => {
    // An unsigned token has an empty signature segment: refused as malformed before the algorithm is even looked at.
    expect(await reason(verifyIdToken(token({}, { alg: "none" }), keys([rsa.jwk]), expectation))).toBe("malformed");
    const noneWithJunk = `${token({}, { alg: "none" })}x`;
    expect(await reason(verifyIdToken(noneWithJunk, keys([rsa.jwk]), expectation))).toBe("unsupported algorithm");
    const oct = { kty: "oct", kid: "r1", k: b64u("secret") } as Jwk;
    expect(await reason(verifyIdToken(token({}, { alg: "HS256" }), keys([oct, rsa.jwk]), expectation))).toBe("unsupported algorithm");
    expect(await reason(verifyIdToken(token({}, { alg: "ES256", kid: "r1" }), keys([rsa.jwk]), expectation))).toBe("no matching key");
  });

  it("checks the claims", async () => {
    const set = keys([rsa.jwk]);
    expect(await reason(verifyIdToken(token({ iss: "https://other.example" }), set, expectation))).toBe("wrong issuer");
    expect(await reason(verifyIdToken(token({ aud: "other" }), set, expectation))).toBe("wrong audience");
    expect(await reason(verifyIdToken(token({ aud: [AUD, "other"] }), set, expectation))).toBe("wrong authorized party");
    expect(await reason(verifyIdToken(token({ aud: [AUD, "other"], azp: AUD }), set, expectation))).toBe("accepted");
    expect(await reason(verifyIdToken(token({ azp: "other" }), set, expectation))).toBe("wrong authorized party");
    expect(await reason(verifyIdToken(token({ exp: now - 61 }), set, expectation))).toBe("expired");
    expect(await reason(verifyIdToken(token({ exp: now - 30 }), set, expectation))).toBe("accepted"); // 60 s tolerance
    expect(await reason(verifyIdToken(token({ iat: now + 120 }), set, expectation))).toBe("issued in the future");
    expect(await reason(verifyIdToken(token({ nonce: "other" }), set, expectation))).toBe("wrong nonce");
    expect(await reason(verifyIdToken(token({ nonce: undefined }), set, expectation))).toBe("wrong nonce");
    expect(await reason(verifyIdToken(token({ sub: "" }), set, expectation))).toBe("missing subject");
    expect(await reason(verifyIdToken(token({ iss: "accounts.google.com" }), set, { ...expectation, issuerAliases: ["accounts.google.com"] }))).toBe("accepted");
  });

  it("refuses a tampered payload and a token signed by another key with the same kid", async () => {
    const good = token({});
    const [h, , s] = good.split(".");
    const forged = `${h}.${b64u(JSON.stringify({ iss: ISS, aud: AUD, sub: "admin", iat: now, exp: now + 300, nonce: NONCE }))}.${s}`;
    expect(await reason(verifyIdToken(forged, keys([rsa.jwk]), expectation))).toBe("bad signature");
    const other = keyPair("rsa", "r1");
    expect(await reason(verifyIdToken(token({}, { key: other.privateKey }), keys([rsa.jwk]), expectation))).toBe("bad signature");
  });

  it("refetches the key set exactly once on an unknown kid", async () => {
    const calls: boolean[] = [];
    const rotated = keyPair("rsa", "r2");
    const resolver = async (_h: unknown, refetch: boolean) => (calls.push(refetch), refetch ? [rotated.jwk] : [rsa.jwk]);
    expect((await verifyIdToken(token({}, { kid: "r2", key: rotated.privateKey }), resolver, expectation)).sub).toBe("s1");
    expect(calls).toEqual([false, true]);
    calls.length = 0;
    expect(await reason(verifyIdToken(token({}, { kid: "r9" }), resolver, expectation))).toBe("no matching key");
    expect(calls).toEqual([false, true]);
  });

  it("rejects malformed tokens without throwing anything but TokenRejected", async () => {
    for (const bad of ["", "a.b", "a.b.c.d", "!!.e30.x", `${b64u("{}")}.${b64u("{}")}.`, `${b64u('"str"')}.${b64u("{}")}.sig`]) expect(await reason(verifyIdToken(bad, keys([rsa.jwk]), expectation)), bad).not.toBe("accepted");
  });
});

describe("broker helpers", () => {
  it("PKCE S256 matches only the right, well-formed verifier", () => {
    const verifier = "a".repeat(43);
    expect(pkceMatches(verifier, s256(verifier))).toBe(true);
    expect(pkceMatches("b".repeat(43), s256(verifier))).toBe(false);
    expect(pkceMatches(undefined, s256(verifier))).toBe(false);
    expect(pkceMatches("short", s256("short"))).toBe(false);
    expect(pkceMatches(verifier, verifier)).toBe(false); // plain is never accepted
  });

  it("desktop redirect URIs: loopback IP literals with a port and /callback only", () => {
    const config = { webRedirectUris: ["https://app.example.org/app/callback"] } as SignInConfig;
    for (const ok of ["http://127.0.0.1:1/callback", "http://127.0.0.1:65535/callback", "http://[::1]:8080/callback"]) expect(redirectAllowed(config, "thoth-desktop", ok), ok).toBe(true);
    for (const bad of ["http://localhost:8080/callback", "http://127.0.0.1:65536/callback", "http://127.0.0.1:08080/callback", "http://127.0.0.1/callback", "https://127.0.0.1:8080/callback", "http://127.0.0.1:8080/callback/", "http://127.0.0.1:8080/Callback", "http://127.0.0.1.evil.example:8080/callback", "http://127.0.0.1:8080@evil.example/callback"])
      expect(redirectAllowed(config, "thoth-desktop", bad), bad).toBe(false);
    expect(redirectAllowed(config, "thoth-web", "https://app.example.org/app/callback")).toBe(true);
    expect(redirectAllowed(config, "thoth-web", "https://app.example.org/app/callback?x")).toBe(false);
  });

  it("cookies: one exact value, or nothing when absent, duplicated or malformed", () => {
    expect(cookieValue("a=1; thoth_signin=abc_-9; b=2", "thoth_signin")).toBe("abc_-9");
    expect(cookieValue("thoth_signin=a; thoth_signin=b", "thoth_signin")).toBeUndefined();
    expect(cookieValue("xthoth_signin=a", "thoth_signin")).toBeUndefined();
    expect(cookieValue("thoth_signin=a<b", "thoth_signin")).toBeUndefined();
    expect(cookieValue(undefined, "thoth_signin")).toBeUndefined();
  });

  it("HTML pages escape everything they interpolate", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&\``)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;");
    const html = chooserPage([{ name: "<img src=x>", href: `/auth/authorize?state="><script>` }]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/<script/i);
    expect(errorPage("T", "<b>")).toContain("&lt;b&gt;");
  });
});
