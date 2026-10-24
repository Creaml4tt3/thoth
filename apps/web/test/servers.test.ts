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
