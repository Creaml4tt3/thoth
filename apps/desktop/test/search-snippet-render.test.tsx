// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { Snippet } from "../src/features/shell/SearchPalette.js";

it("marks the typed words and leaves the page's own brackets as text", () => {
  const { container } = render(<p><Snippet text="see [[Weekly review]] before [plan]ning" words={["plan"]} /></p>);
  expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["plan"]);
  expect(container.textContent).toBe("see [[Weekly review]] before planning");
});
