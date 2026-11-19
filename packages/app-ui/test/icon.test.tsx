// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Icon, type IconName } from "../src/ui/Icon.tsx";

afterEach(cleanup);

describe("Icon", () => {
  it("every IconName draws something", () => {
    const names: IconName[] = ["moon", "pen", "folder", "sun", "server", "plug", "speech", "keyboard"];
    for (const name of names) {
      const { container, unmount } = render(<Icon name={name} />);
      expect(container.querySelector("svg")!.childElementCount, name).toBeGreaterThan(0);
      unmount();
    }
  });
});
