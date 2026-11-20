// @vitest-environment jsdom
/** The line under a page's breadcrumbs: created and edited, "today"/"yesterday" with the time, a date otherwise, and who edited. */
import { describe, expect, it } from "vitest";
import { newStableId, stableIdTime } from "@thoth/domain";
import { pageInfoText } from "../src/editor/PageFrame.tsx";
import { en } from "../src/strings/en.ts";

const now = new Date(2026, 10, 21, 15, 0);
const at = (d: number, h = 9) => new Date(2026, 10, d, h, 30).getTime();
const text = (dates: Parameters<typeof pageInfoText>[0], nameOf?: (id: string) => string | null) => pageInfoText(dates, en.editor.pageInfo, "en", nameOf, now);

describe("pageInfoText", () => {
  it("says created and edited, by name on a server", () => {
    expect(text({ created: at(2), updated: at(21), updatedBy: "u1" }, (id) => (id === "u1" ? "Mali" : null))).toMatch(/^Created Nov 2, 2026 · Edited today, 9:30\s?AM by Mali$/);
  });
  it("yesterday by name, and no edited part when it was never changed after it was made", () => {
    expect(text({ created: at(20), updated: at(20) + 1000 })).toMatch(/^Created yesterday, 9:30\s?AM$/);
  });
  it("says by you after this person's own save, only where names are shown", () => {
    expect(text({ updated: at(21), updatedByMe: true }, () => "x")).toMatch(/by you$/);
    expect(text({ updated: at(21), updatedByMe: true })).not.toMatch(/by/);
  });
  it("says nothing when nothing is known", () => {
    expect(text({})).toBeNull();
    expect(text({ created: Number.NaN })).toBeNull();
  });
  it("reads when a thoth_id was made", () => {
    expect(stableIdTime(newStableId(at(5)))).toBe(at(5));
    expect(stableIdTime("local:0123")).toBeNull();
    expect(stableIdTime(undefined)).toBeNull();
  });
});
