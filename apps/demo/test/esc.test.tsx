// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Demo } from "../src/Demo.tsx";

// jsdom has no matchMedia; a wide screen shows both editors.
beforeEach(() => vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("Esc leaves the editor while the selection toolbar shows (it only hears Esc from inside itself)", async () => {
  const { container } = render(<Demo kind="compare" lang="en" />);
  const editor = await waitFor(() => {
    const el = container.querySelector<HTMLElement>(".ProseMirror");
    if (!el) throw new Error("no editor yet");
    return el;
  });
  // The toolbar as the editor shows it over a selection: on the body, not hidden.
  const toolbar = document.createElement("div");
  toolbar.className = "text-toolbar";
  document.body.append(toolbar);
  act(() => editor.focus());
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(document.activeElement).toBe(container.querySelector(".demo-region"));
});

it("an open menu still takes the first Esc", async () => {
  const { container } = render(<Demo kind="compare" lang="en" />);
  const editor = await waitFor(() => {
    const el = container.querySelector<HTMLElement>(".ProseMirror");
    if (!el) throw new Error("no editor yet");
    return el;
  });
  const menu = document.createElement("div");
  menu.className = "slash-menu";
  document.body.append(menu);
  act(() => editor.focus());
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(document.activeElement).not.toBe(container.querySelector(".demo-region"));
});
