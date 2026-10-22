import { describe, expect, it } from "vitest";
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, CORS_EXPOSE_HEADERS, corsHeaders, isPreflight } from "../src/cors.ts";
import { bearerMatches } from "../src/maintenance.ts";
import { clientIp } from "../src/ratelimit.ts";

const ALLOWED = ["https://app.example.org", "http://localhost:5173"];

describe("CORS header logic", () => {
  it("echoes a listed origin with credentials and Vary: Origin", () => {
    const h = corsHeaders(ALLOWED, "https://app.example.org", false);
    expect(h["access-control-allow-origin"]).toBe("https://app.example.org");
    expect(h["access-control-allow-credentials"]).toBe("true");
    expect(h.vary).toBe("Origin");
    expect(h["access-control-expose-headers"]).toBe(CORS_EXPOSE_HEADERS);
    for (const name of ["ETag", "Location", "Retry-After", "WWW-Authenticate"]) expect(CORS_EXPOSE_HEADERS).toContain(name);
  });
  it("answers a preflight with the allowed methods and headers", () => {
    const h = corsHeaders(ALLOWED, "http://localhost:5173", true);
    expect(h["access-control-allow-methods"]).toBe(CORS_ALLOW_METHODS);
    expect(h["access-control-allow-headers"]).toBe(CORS_ALLOW_HEADERS);
    for (const m of ["GET", "POST", "PUT", "DELETE"]) expect(CORS_ALLOW_METHODS).toContain(m);
    for (const n of ["Authorization", "Content-Type", "If-Match", "If-None-Match", "Idempotency-Key"]) expect(CORS_ALLOW_HEADERS).toContain(n);
  });
  it("gives an unlisted origin no CORS header (only Vary), and a missing origin none either", () => {
    for (const origin of ["https://evil.example", "https://app.example.org.evil.example", "https://APP.example.org", "http://app.example.org", "https://app.example.org:443", "null", undefined]) {
      const h = corsHeaders(ALLOWED, origin, false);
      expect(Object.keys(h).filter((k) => k.startsWith("access-control-")), String(origin)).toEqual([]);
      expect(h.vary).toBe("Origin");
    }
  });
  it("sends nothing at all when no origin is configured", () => {
    expect(corsHeaders([], "https://app.example.org", false)).toEqual({});
    expect(corsHeaders([], "https://app.example.org", true)).toEqual({});
  });
  it("recognizes a preflight only with Origin and Access-Control-Request-Method", () => {
    expect(isPreflight("OPTIONS", { origin: "https://a", "access-control-request-method": "PUT" })).toBe(true);
    expect(isPreflight("OPTIONS", { origin: "https://a" })).toBe(false);
    expect(isPreflight("GET", { origin: "https://a", "access-control-request-method": "PUT" })).toBe(false);
  });
});

describe("client IP", () => {
  it("ignores forwarding headers unless TRUST_PROXY is set", () => {
    expect(clientIp({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" }, "10.0.0.1", false)).toBe("10.0.0.1");
    expect(clientIp({}, undefined, false)).toBe("unknown");
  });
  it("trusts x-real-ip, then the LAST x-forwarded-for entry, when TRUST_PROXY is set", () => {
    expect(clientIp({ "x-real-ip": "5.6.7.8", "x-forwarded-for": "1.1.1.1" }, "10.0.0.1", true)).toBe("5.6.7.8");
    expect(clientIp({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }, "10.0.0.1", true)).toBe("1.2.3.4");
    expect(clientIp({}, "10.0.0.1", true)).toBe("10.0.0.1");
  });
});

describe("maintenance bearer comparison", () => {
  const secret = "0123456789abcdef-secret";
  it("accepts only the exact secret as a Bearer credential", () => {
    expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true);
    expect(bearerMatches(`bearer ${secret}`, secret)).toBe(true);
    for (const bad of [undefined, "", secret, "Bearer ", "Bearer wrong", `Bearer ${secret}x`, `Basic ${secret}`, `Bearer ${secret.slice(1)}`]) expect(bearerMatches(bad, secret), String(bad)).toBe(false);
  });
});
