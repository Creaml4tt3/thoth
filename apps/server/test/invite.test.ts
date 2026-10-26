/**
 * Invite links (ADR-0024) without a database: configuration, log redaction, the page language and the HTML escaping.
 */
import { describe, expect, it } from "vitest";
import { redactSharePath } from "../src/app.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { donePage, invitePage, langOf, readyPage } from "../src/invite/html.ts";

const BASE = { DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db" };

describe("configuration", () => {
  it("lists members and invite-links by default; INVITE_LINKS=off drops only invite-links", () => {
    expect(loadConfig(BASE).capabilities).toEqual(expect.arrayContaining(["members", "invite-links"]));
    const off = loadConfig({ ...BASE, INVITE_LINKS: "off" }).capabilities;
    expect(off).toContain("members");
    expect(off).not.toContain("invite-links");
    expect(() => loadConfig({ ...BASE, INVITE_LINKS: "maybe" })).toThrow(ConfigError);
  });

  it("limits opens and joins per IP by default, 20 active links in the trial, and takes overrides", () => {
    expect(loadConfig(BASE).invite).toEqual({ maxLinksPerWorkspace: undefined, opensPerIp: 60, acceptsPerIp: 20 });
    expect(loadConfig({ ...BASE, THOTH_PROFILE: "trial" }).invite).toEqual({ maxLinksPerWorkspace: 20, opensPerIp: 60, acceptsPerIp: 20 });
    expect(loadConfig({ ...BASE, THOTH_PROFILE: "trial", MAX_INVITE_LINKS_PER_WORKSPACE: "unlimited", INVITE_OPENS_PER_IP: "5", INVITE_ACCEPTS_PER_IP: "unlimited" }).invite).toEqual({ maxLinksPerWorkspace: undefined, opensPerIp: 5, acceptsPerIp: undefined });
    expect(() => loadConfig({ ...BASE, INVITE_OPENS_PER_IP: "0" })).toThrow(ConfigError);
    expect(loadConfig({ ...BASE, THOTH_PROFILE: "trial" }).maxMembersPerWorkspace).toBe(10);
  });
});

describe("log lines", () => {
  it("replace the token of an invite address, and keep /i/accept", () => {
    expect(redactSharePath("/i/abcdefghijklmnopqrstuvwxyz012345")).toBe("/i/[token]");
    expect(redactSharePath("/i/abcdefghijklmnopqrstuvwxyz012345/sign-in")).toBe("/i/[token]/sign-in");
    expect(redactSharePath("/i/accept")).toBe("/i/accept");
    expect(redactSharePath("/s/abc/p/1")).toBe("/s/[token]/p/1");
    expect(redactSharePath("/api/v1/invites/accept")).toBe("/api/v1/invites/accept");
  });
});

describe("the page language", () => {
  it("is Thai only when the browser puts Thai before English", () => {
    expect(langOf(undefined)).toBe("en");
    expect(langOf("th-TH,th;q=0.9,en;q=0.8")).toBe("th");
    expect(langOf("en-US,en;q=0.9,th;q=0.8")).toBe("en");
    expect(langOf("fr-FR,th;q=0.5")).toBe("th");
    expect(langOf("de,fr")).toBe("en");
    expect(langOf("th;q=0, en")).toBe("en");
  });
});

describe("the pages", () => {
  const nasty = `<img src=x onerror="alert(1)">'&`;
  it("escape every name they show and contain no script", () => {
    for (const html of [
      invitePage("en", { workspace: nasty, inviter: nasty, role: "editor", signIn: [{ name: nasty, href: `/i/t/sign-in?provider="x"` }] }),
      invitePage("th", { workspace: nasty, inviter: nasty, role: "viewer", signIn: [] }),
      readyPage("en", { workspace: nasty, role: "viewer", account: nasty, csrf: `"><script>` }),
      donePage("th", { workspace: nasty, role: "editor", joined: true, webClient: `https://app.example/"x`, server: nasty }),
    ]) {
      expect(html).not.toContain("<img");
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toContain(`onerror="`);
      expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;");
    }
  });
});
