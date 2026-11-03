import { describe, expect, it } from "vitest";
import type { Capabilities } from "@thoth/workspace-protocol";
import type { AuthSession } from "../src/auth.ts";
import { WebServers, serverLabel } from "../src/servers.ts";

const SERVER = "https://api.example.org";
const caps = (server?: Capabilities["server"]): Capabilities => ({ protocolVersion: "1.0", capabilities: [], ...(server ? { server } : {}) });

describe("server label", () => {
  it("is the server's name, trimmed", () => {
    expect(serverLabel(caps({ name: "Thoth demo server", version: "1" }), SERVER)).toBe("Thoth demo server");
    expect(serverLabel(caps({ name: "  Team notes \n" }), SERVER)).toBe("Team notes");
  });

  it("falls back to the host name (no port) when the server sends no usable name", () => {
    expect(serverLabel(caps(), SERVER)).toBe("api.example.org");
    expect(serverLabel(caps({ name: "" }), SERVER)).toBe("api.example.org");
    expect(serverLabel(caps({ name: " \u0007 " }), SERVER)).toBe("api.example.org");
    expect(serverLabel(caps(), "http://127.0.0.1:8080")).toBe("127.0.0.1");
  });

  it("drops control characters and keeps at most 64 characters, like the desktop host", () => {
    expect(serverLabel(caps({ name: "Team\u0007 notes" }), SERVER)).toBe("Team notes");
    expect(serverLabel(caps({ name: "ก".repeat(80) }), SERVER)).toBe("ก".repeat(64));
  });

  it("is what WebServers reports", () => {
    const auth = { status: "signed-out" } as unknown as AuthSession;
    const servers = new WebServers({ server: SERVER, capabilities: caps(), auth, fetch, account: () => undefined });
    expect(servers.info().label).toBe("api.example.org");
  });
});

describe("change hints over fetch (ADR-0041)", () => {
  const auth = { status: "signed-in", token: async () => "tok_a", renew: async () => "tok_b" } as unknown as AuthSession;
  const sse = (chunks: string[], status = 200) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });
    return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
  };
  const run = (fetchImpl: typeof fetch) =>
    new Promise<{ opened: boolean; hints: number; ended: boolean }>((resolve) => {
      const seen = { opened: false, hints: 0, ended: false };
      new WebServers({ server: SERVER, capabilities: caps(), auth, fetch: fetchImpl, account: () => undefined }).events("trial", "ws_1", {
        open: () => void (seen.opened = true),
        hint: () => void seen.hints++,
        end: () => resolve({ ...seen, ended: true }),
      });
    });

  it("sends the token in a header, counts only `changes` events (also split across chunks), and ends with the stream", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const result = await run((async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
      return sse([": connected\n\n", "event: chan", "ges\ndata: {}\n\n: keep-alive\n\n", "event: other\ndata: x\n\nevent: changes\r\ndata: {}\r\n\r\n"]);
    }) as typeof fetch);
    expect(result).toEqual({ opened: true, hints: 2, ended: true });
    expect(seen).toEqual([{ url: `${SERVER}/api/v1/workspaces/ws_1/events`, auth: "Bearer tok_a" }]);
  });

  it("renews once on 401, and ends without opening on a refusal (the app polls)", async () => {
    const tokens: (string | null)[] = [];
    const renewed = await run((async (_url: URL, init: RequestInit) => {
      const token = new Headers(init.headers).get("authorization");
      tokens.push(token);
      return token === "Bearer tok_b" ? sse(["event: changes\ndata: {}\n\n"]) : new Response("", { status: 401 });
    }) as typeof fetch);
    expect(tokens).toEqual(["Bearer tok_a", "Bearer tok_b"]);
    expect(renewed).toEqual({ opened: true, hints: 1, ended: true });
    expect(await run((async () => new Response("{}", { status: 501, headers: { "content-type": "application/problem+json" } })) as typeof fetch)).toEqual({ opened: false, hints: 0, ended: true });
    expect(await run((async () => Promise.reject(new TypeError("network"))) as typeof fetch)).toEqual({ opened: false, hints: 0, ended: true });
  });
});
