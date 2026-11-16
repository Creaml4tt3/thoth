import { describe, expect, it } from "vitest";
import { withoutTitle } from "../src/features/shell/SearchPalette.js";

describe("withoutTitle", () => {
  it("drops the title and the page's H1 from the front of a snippet", () => {
    expect(withoutTitle("Weekend [plan] Weekend [plan] Saturday at home", "Weekend plan")).toBe("Saturday at home");
  });
  it("leaves a snippet from the middle of the page alone", () => {
    expect(withoutTitle("…the road is [clear] before nine", "Weekend plan")).toBe("…the road is [clear] before nine");
  });
  it("keeps the snippet when it is only the title", () => {
    expect(withoutTitle("[Zebra]", "Zebra")).toBe("[Zebra]");
  });
});
