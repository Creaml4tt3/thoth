import { describe, expect, it } from "vitest";
import { ConfigError, TRIAL_PROFILE, loadConfig, parseCorsOrigins } from "../src/config.ts";

const DB = "postgres://user:s3cretpw@localhost:5432/thoth";
const env = (extra: Record<string, string> = {}) => ({ DATABASE_URL: DB, ...extra });
const failure = (extra: Record<string, string>): string => {
  try {
    loadConfig(env(extra));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a ConfigError");
};

describe("configuration", () => {
  it("defaults: no quotas, filesystem blobs, events on, migrations on, nothing rate limited", () => {
    const c = loadConfig(env());
    expect(c).toMatchObject({ profile: "default", blobStore: "fs", migrateOnStart: true, databasePoolMax: 10, trustProxy: false, corsOrigins: [], cronSecret: undefined });
    for (const k of ["maxWorkspacesPerAccount", "maxMembersPerWorkspace", "maxPagesPerWorkspace", "maxWorkspaceAttachmentBytes", "revisionRetentionDays", "maxTotalAttachmentBytes", "maxAccounts"] as const) expect(c[k], k).toBeUndefined();
    expect(c.maxAttachmentBytes).toBe(26_214_400);
    expect(c.maxMarkdownBytes).toBe(1_048_576);
    expect(c.rateLimit).toEqual({ perAccount: undefined, perIp: undefined, windowSeconds: 60 });
    expect(c.capabilities).toContain("events.sse");
  });

  it("each limit is its own variable", () => {
    const c = loadConfig(env({ MAX_PAGES_PER_WORKSPACE: "7", MAX_MEMBERS_PER_WORKSPACE: "3", MAX_WORKSPACES_PER_ACCOUNT: "2", MAX_WORKSPACE_ATTACHMENT_BYTES: "1000", REVISION_RETENTION_DAYS: "9", MAX_TOTAL_ATTACHMENT_BYTES: "5000", MAX_ACCOUNTS: "4" }));
    expect(c).toMatchObject({ maxPagesPerWorkspace: 7, maxMembersPerWorkspace: 3, maxWorkspacesPerAccount: 2, maxWorkspaceAttachmentBytes: 1000, revisionRetentionDays: 9, maxTotalAttachmentBytes: 5000, maxAccounts: 4 });
  });

  it("THOTH_PROFILE=trial fills the owner's trial defaults", () => {
    const c = loadConfig(env({ THOTH_PROFILE: "trial" }));
    expect(c).toMatchObject({
      profile: "trial",
      maxWorkspacesPerAccount: 1,
      maxMembersPerWorkspace: 10,
      maxPagesPerWorkspace: 200,
      maxWorkspaceAttachmentBytes: 20 * 1_048_576,
      maxTotalAttachmentBytes: 600 * 1_048_576,
      revisionRetentionDays: 30,
      maxAttachmentBytes: 4 * 1_048_576,
      maxMarkdownBytes: 256 * 1024,
      blobStore: "postgres",
      maxAccounts: 300,
      rateLimit: { perAccount: 300, perIp: 600, windowSeconds: 60 },
    });
    expect(c.capabilities).not.toContain("events.sse");
    expect(TRIAL_PROFILE.maxAttachmentBytes).toBeLessThan(4_500_000); // below Vercel's 4.5 MB request body limit
  });

  it("explicit variables override the profile; `unlimited` removes a profile default", () => {
    const c = loadConfig(env({ THOTH_PROFILE: "trial", MAX_PAGES_PER_WORKSPACE: "500", BLOB_STORE: "fs", MAX_ATTACHMENT_BYTES: "2048", MAX_WORKSPACES_PER_ACCOUNT: "unlimited" }));
    expect(c).toMatchObject({ maxPagesPerWorkspace: 500, blobStore: "fs", maxAttachmentBytes: 2048, maxMembersPerWorkspace: 10 });
    expect(c.maxWorkspacesPerAccount).toBeUndefined();
    const keepSse = loadConfig(env({ THOTH_PROFILE: "trial", EVENTS: "on", MAX_ACCOUNTS: "unlimited", RATE_LIMIT_PER_IP: "unlimited" }));
    expect(keepSse.capabilities).toContain("events.sse");
    expect(keepSse.maxAccounts).toBeUndefined();
    expect(keepSse.rateLimit.perIp).toBeUndefined();
  });

  it("EVENTS=off drops events.sse from the capabilities; the rest stay", () => {
    const c = loadConfig(env({ EVENTS: "off" }));
    expect(c.capabilities).toEqual(["attachments", "search", "transfers"]);
    expect(loadConfig(env({ EVENTS: "on" })).capabilities).toContain("events.sse");
  });

  it("MIGRATE_ON_START, DATABASE_POOL_MAX, TRUST_PROXY, BLOB_STORE", () => {
    expect(loadConfig(env({ MIGRATE_ON_START: "false" })).migrateOnStart).toBe(false);
    expect(loadConfig(env({ MIGRATE_ON_START: "true" })).migrateOnStart).toBe(true);
    expect(loadConfig(env({ DATABASE_POOL_MAX: "3" })).databasePoolMax).toBe(3);
    expect(loadConfig(env({ TRUST_PROXY: "1" })).trustProxy).toBe(true);
    expect(loadConfig(env({ BLOB_STORE: "postgres" })).blobStore).toBe("postgres");
  });

  it("rate limits are off unless set, and read their window", () => {
    expect(loadConfig(env({ RATE_LIMIT_PER_ACCOUNT: "30", RATE_LIMIT_PER_IP: "100", RATE_LIMIT_WINDOW_SECONDS: "10" })).rateLimit).toEqual({ perAccount: 30, perIp: 100, windowSeconds: 10 });
  });

  it("rejects invalid values strictly, without echoing them", () => {
    const bad: Record<string, string>[] = [
      { MAX_PAGES_PER_WORKSPACE: "0" },
      { MAX_PAGES_PER_WORKSPACE: "-3" },
      { MAX_PAGES_PER_WORKSPACE: "1.5" },
      { MAX_PAGES_PER_WORKSPACE: "12abc" },
      { MAX_PAGES_PER_WORKSPACE: "1e3" },
      { MAX_ACCOUNTS: "lots" },
      { THOTH_PROFILE: "enterprise" },
      { BLOB_STORE: "s3" },
      { EVENTS: "maybe" },
      { MIGRATE_ON_START: "yes" },
      { TRUST_PROXY: "sure" },
      { DATABASE_POOL_MAX: "0" },
      { DATABASE_POOL_MAX: "1000" },
      { RATE_LIMIT_WINDOW_SECONDS: "0" },
      { CRON_SECRET: "short" },
      { CORS_ORIGINS: "https://app.example.org/path" },
      { CORS_ORIGINS: "*" },
      { CORS_ORIGINS: "https://*.example.org" },
      { CORS_ORIGINS: "ftp://example.org" },
      { CORS_ORIGINS: "not a url" },
      { CORS_ORIGINS: "https://app.example.org/" },
    ];
    for (const extra of bad) {
      const message = failure(extra);
      // Short numbers legitimately occur in the range text; every distinctive value must be absent.
      for (const value of Object.values(extra)) if (value.length >= 4 && !/^[-\d.]+$/.test(value)) expect(message, JSON.stringify(extra)).not.toContain(value);
      expect(message).not.toContain("s3cretpw");
    }
  });

  it("a rejected CRON_SECRET or DATABASE_URL is never quoted", () => {
    expect(failure({ CRON_SECRET: "tooshort" })).not.toContain("tooshort");
    expect(() => loadConfig({ DATABASE_URL: "mysql://u:hunter2@h/db" })).toThrow(expect.objectContaining({ message: expect.not.stringContaining("hunter2") }));
  });

  it("CORS_ORIGINS: exact origins, trimmed and de-duplicated", () => {
    expect(parseCorsOrigins(" https://app.example.org , http://localhost:5173 ,https://app.example.org")).toEqual(["https://app.example.org", "http://localhost:5173"]);
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins("  ")).toEqual([]);
  });

  it("the trial transfer body limit never drops below the Markdown limit", () => {
    expect(loadConfig(env({ THOTH_PROFILE: "trial", MAX_MARKDOWN_BYTES: "8388608" })).maxTransferBytes).toBeGreaterThanOrEqual(8_388_608);
  });
});

describe("sign-in configuration", () => {
  const SECRET = "gcs-not-a-real-secret-0123456789";
  const google = { PUBLIC_URL: "https://api.example.org", OIDC_GOOGLE_CLIENT_ID: "gid.apps.example", OIDC_GOOGLE_CLIENT_SECRET: SECRET };

  it("no provider: sign-in is off, and lifetimes still validate", () => {
    expect(loadConfig(env()).signIn).toBeUndefined();
    expect(failure({ ACCESS_TOKEN_TTL_SECONDS: "30" })).toContain("ACCESS_TOKEN_TTL_SECONDS");
  });

  it("a provider with PUBLIC_URL: defaults per sign-in.md section 5", () => {
    const s = loadConfig(env(google)).signIn!;
    expect(s).toMatchObject({ publicUrl: "https://api.example.org", webRedirectUris: [], signupLimitPerIp: undefined, accessTokenTtlSeconds: 900, refreshTokenTtlDays: 30, sessionMaxDays: 90 });
    expect(s.providers).toEqual([{ kind: "oidc", id: "google", name: "Google", issuer: "https://accounts.google.com", clientId: "gid.apps.example", clientSecret: SECRET }]);
  });

  it("the trial profile limits sign-ups to 10 per IP; `unlimited` removes it", () => {
    expect(loadConfig(env({ ...google, THOTH_PROFILE: "trial" })).signIn!.signupLimitPerIp).toBe(10);
    expect(loadConfig(env({ ...google, THOTH_PROFILE: "trial", SIGNUP_LIMIT_PER_IP: "unlimited" })).signIn!.signupLimitPerIp).toBeUndefined();
  });

  it("GitHub and a generic issuer, with Enterprise URLs and a loopback test issuer", () => {
    const s = loadConfig(env({ PUBLIC_URL: "http://127.0.0.1:8080", GITHUB_CLIENT_ID: "Iv1.x", GITHUB_CLIENT_SECRET: SECRET, GITHUB_URL: "https://ghe.example.org", GITHUB_API_URL: "https://ghe.example.org/api/v3", OIDC_ISSUER: "http://127.0.0.1:9000/realms/t", OIDC_CLIENT_ID: "kc", OIDC_CLIENT_SECRET: SECRET, OIDC_NAME: "Keycloak", WEB_REDIRECT_URIS: "https://app.example.org/app/callback, http://localhost:5173/callback" })).signIn!;
    expect(s.providers.map((p) => p.id)).toEqual(["github", "oidc"]);
    expect(s.providers[0]).toMatchObject({ webUrl: "https://ghe.example.org", apiUrl: "https://ghe.example.org/api/v3" });
    expect(s.providers[1]).toMatchObject({ name: "Keycloak", issuer: "http://127.0.0.1:9000/realms/t" });
    expect(s.webRedirectUris).toEqual(["https://app.example.org/app/callback", "http://localhost:5173/callback"]);
  });

  it("only one of a provider's ID and secret is a ConfigError naming the variable, never the value", () => {
    const cases: [Record<string, string>, string][] = [
      [{ PUBLIC_URL: "https://a.example", OIDC_GOOGLE_CLIENT_ID: "only-the-id-value" }, "OIDC_GOOGLE_CLIENT_SECRET"],
      [{ PUBLIC_URL: "https://a.example", OIDC_GOOGLE_CLIENT_SECRET: SECRET }, "OIDC_GOOGLE_CLIENT_ID"],
      [{ PUBLIC_URL: "https://a.example", GITHUB_CLIENT_SECRET: SECRET }, "GITHUB_CLIENT_ID"],
      [{ PUBLIC_URL: "https://a.example", GITHUB_CLIENT_ID: "only-the-id-value" }, "GITHUB_CLIENT_SECRET"],
      [{ PUBLIC_URL: "https://a.example", OIDC_ISSUER: "https://id.example", OIDC_CLIENT_SECRET: SECRET }, "OIDC_CLIENT_ID"],
      [{ PUBLIC_URL: "https://a.example", OIDC_CLIENT_ID: "kc", OIDC_CLIENT_SECRET: SECRET }, "OIDC_ISSUER"],
    ];
    for (const [extra, variable] of cases) {
      const message = failure(extra);
      expect(message, variable).toContain(variable);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("only-the-id-value");
    }
  });

  it("a non-https issuer that is not loopback is an error; so are other insecure URLs", () => {
    for (const issuer of ["http://id.example.org", "http://10.0.0.5/realms/x", "ftp://id.example.org", "https://u:p@id.example.org", "https://id.example.org/?x=1", "not a url"]) {
      const message = failure({ PUBLIC_URL: "https://a.example", OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "kc", OIDC_CLIENT_SECRET: SECRET });
      expect(message, issuer).toContain("OIDC_ISSUER");
      expect(message).not.toContain(issuer);
    }
    expect(failure({ PUBLIC_URL: "https://a.example", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: SECRET, GITHUB_URL: "http://github.example" })).toContain("GITHUB_URL");
    for (const url of ["http://[::1]:9000", "http://127.0.0.1:9000/r", "http://localhost:9000"]) expect(loadConfig(env({ PUBLIC_URL: "https://a.example", OIDC_ISSUER: url, OIDC_CLIENT_ID: "kc", OIDC_CLIENT_SECRET: SECRET })).signIn!.providers[0]!.kind).toBe("oidc");
  });

  it("PUBLIC_URL is required with a provider and must be an https origin (http only on loopback)", () => {
    expect(failure({ OIDC_GOOGLE_CLIENT_ID: "x", OIDC_GOOGLE_CLIENT_SECRET: SECRET })).toContain("PUBLIC_URL");
    for (const bad of ["https://api.example.org/base", "http://api.example.org", "https://api.example.org/?x", "api.example.org"]) expect(failure({ ...google, PUBLIC_URL: bad }), bad).toContain("PUBLIC_URL");
    expect(loadConfig(env({ ...google, PUBLIC_URL: "https://api.example.org/" })).signIn!.publicUrl).toBe("https://api.example.org");
  });

  it("WEB_REDIRECT_URIS: exact URIs only", () => {
    for (const bad of ["https://app.example.org/cb#x", "https://*.example.org/cb", "http://app.example.org/cb", "/cb", "https://app.example.org"]) expect(failure({ ...google, WEB_REDIRECT_URIS: bad }), bad).toContain("WEB_REDIRECT_URIS");
  });
});
