// The rules for a drag from one space (the Private Space, a workspace) onto the other (ADR-0006, amendment of
// 2026-10-26): which transfer a drop would start, when it is refused and why, the payload, Alt/Option for Move.
import { describe, expect, it } from "vitest";
import { betweenRefusal, crossDirection, decodeSpaceDrag, encodeSpaceDrag, modeAtDrop, spaceDropRefusal, type SpaceDrag, type WorkspaceAccess } from "../src/order/space-drag.ts";

const PRIVATE = { kind: "private" } as const;
const studio = { kind: "workspace", server: "srv_1", workspace: "ws_studio" } as const;
const other = { kind: "workspace", server: "srv_1", workspace: "ws_other" } as const;
const access = (patch: Partial<WorkspaceAccess> = {}): WorkspaceAccess => ({ name: "Studio", serverName: "Team", role: "editor", signedIn: true, transfers: true, exportRestricted: false, ...patch });

describe("crossDirection", () => {
  it("the Private Space onto a workspace is to_workspace, the other way from_workspace", () => {
    expect(crossDirection(PRIVATE, studio)).toBe("to_workspace");
    expect(crossDirection(studio, PRIVATE)).toBe("from_workspace");
  });

  it("within one space it is no transfer (the trees handle their own drags)", () => {
    expect(crossDirection(PRIVATE, PRIVATE)).toBeNull();
    expect(crossDirection(studio, { ...studio })).toBeNull();
  });

  it("between two workspaces, on one server or two, it is between_workspaces (amendment of 2026-10-27)", () => {
    expect(crossDirection(studio, other)).toBe("between_workspaces");
    expect(crossDirection(studio, { kind: "workspace", server: "srv_2", workspace: "ws_studio" })).toBe("between_workspaces");
  });
});

describe("betweenRefusal", () => {
  const archive = (patch: Partial<WorkspaceAccess> = {}) => access({ name: "Archive", ...patch });
  it("asks the destination as a receiver and the source as a giver", () => {
    expect(betweenRefusal(access({ role: "viewer" }), archive())).toBeNull(); // a viewer may copy out
    expect(betweenRefusal(access(), archive({ role: "viewer" }))).toEqual({ refusal: "viewer", access: archive({ role: "viewer" }) });
    expect(betweenRefusal(access({ exportRestricted: true }), archive())).toEqual({ refusal: "export_restricted", access: access({ exportRestricted: true }) });
    expect(betweenRefusal(access({ signedIn: false }), archive())?.refusal).toBe("signed_out");
  });
});

describe("spaceDropRefusal", () => {
  it("lets an owner or editor receive pages, and anyone read pages out of an unrestricted workspace", () => {
    expect(spaceDropRefusal("to_workspace", access({ role: "owner" }))).toBeNull();
    expect(spaceDropRefusal("to_workspace", access({ role: "editor" }))).toBeNull();
    expect(spaceDropRefusal("from_workspace", access({ role: "viewer" }))).toBeNull();
  });

  it("refuses a viewer workspace as the destination", () => {
    expect(spaceDropRefusal("to_workspace", access({ role: "viewer" }))).toBe("viewer");
  });

  it("refuses an export-restricted workspace as the source, but not as the destination", () => {
    expect(spaceDropRefusal("from_workspace", access({ exportRestricted: true }))).toBe("export_restricted");
    expect(spaceDropRefusal("to_workspace", access({ exportRestricted: true }))).toBeNull();
  });

  it("refuses a server without the transfers capability, in both directions; unknown capabilities are left to the preview", () => {
    expect(spaceDropRefusal("to_workspace", access({ transfers: false }))).toBe("no_transfers");
    expect(spaceDropRefusal("from_workspace", access({ transfers: false }))).toBe("no_transfers");
    expect(spaceDropRefusal("to_workspace", access({ transfers: null }))).toBeNull();
  });

  it("refuses a signed-out server first, whatever else is true", () => {
    expect(spaceDropRefusal("to_workspace", access({ signedIn: false, role: "viewer", transfers: false }))).toBe("signed_out");
    expect(spaceDropRefusal("from_workspace", access({ signedIn: false, exportRestricted: true }))).toBe("signed_out");
  });
});

describe("the payload", () => {
  const drag: SpaceDrag = { from: studio, row: "pg_1", ids: ["pg_1", "pg_2"], title: "Roadmap ไทย" };

  it("round-trips through the drag data", () => {
    expect(decodeSpaceDrag(encodeSpaceDrag(drag))).toEqual(drag);
    const local: SpaceDrag = { from: PRIVATE, row: "Projects", ids: ["Projects/Plan.md"], title: "Projects", base: "" };
    expect(decodeSpaceDrag(encodeSpaceDrag(local))).toEqual(local);
  });

  it("rejects anything that is not a page drag", () => {
    for (const text of ["", "Plan.md", "{}", '{"from":{"kind":"private"},"row":"a","ids":[],"title":"a"}', '{"from":{"kind":"cloud"},"row":"a","ids":["a"],"title":"a"}', '{"from":{"kind":"private"},"row":"a","ids":[1],"title":"a"}'])
      expect(decodeSpaceDrag(text)).toBeNull();
  });
});

describe("modeAtDrop", () => {
  it("is Copy, or Move while Alt/Option is held", () => {
    expect(modeAtDrop({ altKey: false })).toBe("copy");
    expect(modeAtDrop({ altKey: true })).toBe("move");
  });
});
