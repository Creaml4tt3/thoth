// ADR-0042: the Manager role, the roles' order, invite roles, and the team and visibility schemas.
import { describe, expect, it } from "vitest";
import { INVITE_ROLES, PageVisibilityWriteSchema, RoleSchema, TeamWriteSchema, roleCan, type Role } from "@thoth/workspace-protocol";

describe("roles (ADR-0042)", () => {
  it("orders the roles owner > manager > editor > viewer", () => {
    expect(RoleSchema.options).toEqual(["owner", "manager", "editor", "viewer"]);
  });

  it("gives a manager an editor's permissions plus manage, and only owners administer", () => {
    const can = (role: Role) => (["read", "write", "manage", "administer"] as const).filter((p) => roleCan(role, p));
    expect(can("viewer")).toEqual(["read"]);
    expect(can("editor")).toEqual(["read", "write"]);
    expect(can("manager")).toEqual(["read", "write", "manage"]);
    expect(can("owner")).toEqual(["read", "write", "manage", "administer"]);
  });

  it("lets an invite link give manager, editor or viewer, never owner", () => {
    expect([...INVITE_ROLES]).toEqual(["manager", "editor", "viewer"]);
  });
});

describe("team and visibility bodies", () => {
  it("trims a team name and refuses an empty or too long one", () => {
    expect(TeamWriteSchema.parse({ name: "  Design " }).name).toBe("Design");
    expect(TeamWriteSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(TeamWriteSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });

  it("takes null (everyone) or one or more teams, never an empty list", () => {
    expect(PageVisibilityWriteSchema.safeParse({ teamIds: null }).success).toBe(true);
    expect(PageVisibilityWriteSchema.safeParse({ teamIds: ["team_1"] }).success).toBe(true);
    expect(PageVisibilityWriteSchema.safeParse({ teamIds: [] }).success).toBe(false);
    expect(PageVisibilityWriteSchema.safeParse({}).success).toBe(false);
  });
});
