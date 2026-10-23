import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";
import { safeEqual } from "./secrets.ts";

/** A JSON Web Key as published in a JWKS (RFC 7517). Only public members are read. */
export interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  key_ops?: string[];
}

/**
 * Asymmetric signature algorithms only. `none` and every `HS*` are refused: an HMAC "verified" with a key
 * from a public JWKS (or with the client secret) proves nothing about the issuer.
 */
const ALGORITHMS: Record<string, { kty: "RSA" | "EC"; hash: string; crv?: string; pss?: boolean }> = {
  RS256: { kty: "RSA", hash: "sha256" },
  RS384: { kty: "RSA", hash: "sha384" },
  RS512: { kty: "RSA", hash: "sha512" },
  PS256: { kty: "RSA", hash: "sha256", pss: true },
  PS384: { kty: "RSA", hash: "sha384", pss: true },
  PS512: { kty: "RSA", hash: "sha512", pss: true },
  ES256: { kty: "EC", hash: "sha256", crv: "P-256" },
  ES384: { kty: "EC", hash: "sha384", crv: "P-384" },
  ES512: { kty: "EC", hash: "sha512", crv: "P-521" },
};

/** Why a token was refused. The reason is safe to log: it never contains the token or a claim value. */
export class TokenRejected extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`ID token rejected: ${reason}`);
    this.name = "TokenRejected";
    this.reason = reason;
  }
}

export interface IdTokenExpectations {
  issuer: string;
  /** Other exact `iss` values the issuer is documented to use (Google: `accounts.google.com`). */
  issuerAliases?: readonly string[];
  clientId: string;
  nonce: string;
  /** Seconds since the epoch; defaults to now. */
  now?: number;
  /** Clock skew allowed for `exp` and `iat`, seconds. */
  toleranceSeconds?: number;
}

export interface IdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: unknown;
  name?: string;
  preferred_username?: string;
  [claim: string]: unknown;
}

/** Looks up the verification key for a header's `kid`; `null` when none matches (the caller may refetch the JWKS once). */
export type KeyResolver = (header: { kid?: string; alg: string }, refetch: boolean) => Promise<Jwk[]>;

const decodeSegment = (segment: string): unknown => {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new TokenRejected("malformed");
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new TokenRejected("malformed");
  }
};

/** A JWK usable with `alg`: right key type and curve, meant for signatures, and not pinned to another algorithm. */
function keyFits(jwk: Jwk, alg: string): boolean {
  const spec = ALGORITHMS[alg];
  if (!spec || jwk.kty !== spec.kty) return false;
  if (spec.crv !== undefined && jwk.crv !== spec.crv) return false;
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (jwk.key_ops !== undefined && !jwk.key_ops.includes("verify")) return false;
  return true;
}

function publicKeyOf(jwk: Jwk): KeyObject | null {
  try {
    // Only the public members are passed on, so a JWKS that (wrongly) carried private parts cannot make this a private key.
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const material: JsonWebKey = jwk.kty === "RSA" ? { kty: "RSA", n: str(jwk.n), e: str(jwk.e) } : { kty: "EC", crv: str(jwk.crv), x: str(jwk.x), y: str(jwk.y) };
    return createPublicKey({ key: material, format: "jwk" });
  } catch {
    return null;
  }
}

function signatureValid(alg: string, key: KeyObject, signingInput: string, signature: Buffer): boolean {
  const spec = ALGORITHMS[alg]!;
  if (spec.kty === "EC") return verifySignature(spec.hash, Buffer.from(signingInput, "ascii"), { key, dsaEncoding: "ieee-p1363" }, signature);
  if (spec.pss) return verifySignature(spec.hash, Buffer.from(signingInput, "ascii"), { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: -1 /* digest length */ }, signature);
  return verifySignature(spec.hash, Buffer.from(signingInput, "ascii"), key, signature);
}

/**
 * Verifies an OpenID Connect ID token (OIDC Core 3.1.3.7): compact JWS, asymmetric algorithm only, signature
 * against the issuer's JWKS (refetched once on an unknown `kid`, for key rotation), `iss` exactly, `aud`
 * containing the client ID (and `azp` equal to it when present or when there are several audiences), `exp`
 * and `iat` with tolerance, `nonce` in constant time, and a non-empty `sub`. Throws `TokenRejected`.
 */
export async function verifyIdToken(token: string, keys: KeyResolver, expect: IdTokenExpectations): Promise<IdTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new TokenRejected("malformed");
  const [h, p, s] = parts as [string, string, string];
  const header = decodeSegment(h) as { alg?: unknown; kid?: unknown; crit?: unknown; typ?: unknown };
  if (typeof header !== "object" || header === null) throw new TokenRejected("malformed");
  if (typeof header.alg !== "string" || !Object.hasOwn(ALGORITHMS, header.alg)) throw new TokenRejected("unsupported algorithm");
  if (header.crit !== undefined) throw new TokenRejected("unsupported critical header");
  const alg = header.alg;
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  if (header.kid !== undefined && kid === undefined) throw new TokenRejected("malformed");
  const signature = Buffer.from(s, "base64url");
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new TokenRejected("malformed");

  const candidates = (jwks: Jwk[]) => jwks.filter((k) => keyFits(k, alg) && (kid === undefined ? true : k.kid === kid));
  let found = candidates(await keys({ alg, ...(kid === undefined ? {} : { kid }) }, false));
  // Rotation: a token signed with a key we have not seen yet. One refetch, then give up.
  if (found.length === 0) found = candidates(await keys({ alg, ...(kid === undefined ? {} : { kid }) }, true));
  if (found.length === 0) throw new TokenRejected("no matching key");
  // Without a `kid`, only an unambiguous key set is accepted.
  if (kid === undefined && found.length !== 1) throw new TokenRejected("ambiguous key");
  const key = publicKeyOf(found[0]!);
  if (key === null) throw new TokenRejected("unusable key");
  let valid = false;
  try {
    valid = signatureValid(alg, key, `${h}.${p}`, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new TokenRejected("bad signature");

  // Claims are only read once the signature holds.
  const claims = decodeSegment(p) as Record<string, unknown>;
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) throw new TokenRejected("malformed");
  const now = expect.now ?? Math.floor(Date.now() / 1000);
  const tolerance = expect.toleranceSeconds ?? 60;
  if (typeof claims.iss !== "string" || (claims.iss !== expect.issuer && !(expect.issuerAliases ?? []).includes(claims.iss))) throw new TokenRejected("wrong issuer");
  const aud = claims.aud;
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) && aud.every((a) => typeof a === "string") ? (aud as string[]) : null;
  if (audiences === null || !audiences.includes(expect.clientId)) throw new TokenRejected("wrong audience");
  if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== expect.clientId) throw new TokenRejected("wrong authorized party");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp + tolerance <= now) throw new TokenRejected("expired");
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat - tolerance > now) throw new TokenRejected("issued in the future");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - tolerance > now)) throw new TokenRejected("not yet valid");
  if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, expect.nonce)) throw new TokenRejected("wrong nonce");
  if (typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 255) throw new TokenRejected("missing subject");
  return claims as IdTokenClaims;
}
