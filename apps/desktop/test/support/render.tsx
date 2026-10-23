import "./jsdom-shims.ts";
import { cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { App, DEFAULT_OPTIONS } from "../../src/app/App.tsx";
import type { AppOptions } from "../../src/app/context.ts";
import { createNodePlatform, type NodePlatform } from "./node-platform.ts";

export interface Harness {
  platform: NodePlatform;
  root: string;
  user: ReturnType<typeof userEvent.setup>;
  read(path: string): Promise<string>;
  /** Writes a file the way an external editor would, with a fresh mtime. */
  external(path: string, text: string): Promise<void>;
  mtime(path: string): Promise<number>;
}

/** Test-friendly options: no autosave unless asked, a short debounce. */
// Opening a vault indexes it first; under a full parallel `pnpm test` that can exceed the 1 s default.
configure({ asyncUtilTimeout: 5000 });

// No starter server: tests that want one pass it, so no test depends on the real demo address.
export const TEST_OPTIONS: Partial<AppOptions> = { autosaveMs: 0, reconcileDebounceMs: 15, starterServer: null };

export async function openApp(root: string, options: Partial<AppOptions> = {}, platform = createNodePlatform({ vault: root })): Promise<Harness> {
  const user = userEvent.setup();
  render(<App platform={platform} options={{ ...DEFAULT_OPTIONS, ...TEST_OPTIONS, ...options }} />);
  await user.click(await screen.findByRole("button", { name: /choose or create a private space/i }));
  return {
    platform,
    root,
    user,
    read: (path) => readFile(join(root, path), "utf8"),
    async external(path, text) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
      const later = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000));
      await utimes(join(root, path), later, later);
    },
    mtime: async (path) => (await stat(join(root, path))).mtimeMs,
  };
}

export const editorBox = () => screen.findByRole("textbox", { name: /page content/i });
export { cleanup, screen, waitFor, within };

/** Puts the caret at the end of the text in `block` (jsdom cannot hit-test a mouse click). */
export function caretAtEnd(block: Element): void {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n as Text;
  const selection = document.getSelection()!;
  const range = document.createRange();
  if (last) range.setStart(last, last.length);
  else range.setStart(block, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

export const paragraph = (box: HTMLElement, text: string): HTMLElement => {
  const found = [...box.querySelectorAll("p")].find((p) => p.textContent === text);
  if (!found) throw new Error(`No paragraph "${text}"`);
  return found;
};
