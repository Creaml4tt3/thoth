// @vitest-environment jsdom
// A window on one Markdown file the system handed over (ADR-0057): the shared editor over the file's token, nothing
// of any Private Space.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { sha256Hex } from "@thoth/domain";
import type { OpenedFiles, Platform } from "@thoth/platform";
import { FileWindow } from "../src/features/opened/FileWindow.tsx";
import { caretAtEnd, paragraph } from "./support/render.tsx";

afterEach(cleanup);

const encode = (text: string) => new TextEncoder().encode(text);
const failure = (code: string) => Object.assign(new Error(code), { code });

function setup(text = "# Plan\n\nShip it.\n") {
  const state = { file: encode(text) as Uint8Array | null, writes: [] as string[], promoted: [] as string[] };
  const openedFile: OpenedFiles = {
    async stat() {
      return { name: "Plan.md", folder: "Downloads", mtimeMs: 1, size: 0 };
    },
    async read() {
      if (!state.file) throw failure("ENOENT");
      return state.file;
    },
    async write(_token, bytes, expected) {
      if (!state.file || sha256Hex(state.file) !== expected) throw failure("CONFLICT");
      state.writes.push(new TextDecoder().decode(bytes));
      state.file = bytes;
      return { hash: sha256Hex(bytes) };
    },
    async copy(_token, name) {
      return { name };
    },
  };
  // Anything a Private Space would use throws: a file window never reaches one.
  const forbidden = () => {
    throw new Error("a file window must not use the Private Space");
  };
  const platform = {
    kind: "tauri",
    openedFile,
    windows: {
      async promoteFile(token: string) {
        state.promoted.push(token);
      },
    },
    openVault: forbidden,
    pickVaultFolder: forbidden,
    recentVaults: forbidden,
  } as unknown as Platform;
  render(<FileWindow platform={platform} token="file_tok" />);
  return { state, user: userEvent.setup() };
}

describe("a file window", () => {
  it("shows the file with its folder and name, and saves edits back to it", async () => {
    const { state, user } = setup();
    const box = await screen.findByRole("textbox", { name: /page content/i });
    await waitFor(() => expect(box.textContent).toContain("Ship it."));
    expect(screen.getByText("Downloads")).toBeTruthy();
    expect(screen.getAllByText("Plan").length).toBeGreaterThan(0);
    expect(document.title).toBe("Plan.md");
    box.focus();
    caretAtEnd(paragraph(box, "Ship it."));
    await user.keyboard("!");
    await user.keyboard("{Meta>}s{/Meta}");
    await waitFor(() => expect(state.writes.at(-1)).toBe("# Plan\n\nShip it.!\n"));
  });

  it("says the file is gone when it was deleted outside Thoth", async () => {
    const { state } = setup();
    await screen.findByRole("textbox", { name: /page content/i });
    state.file = null;
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText("This file is gone")).toBeTruthy();
  });

  it("opens its folder as a Private Space through the shell, by token, after writing pending edits", async () => {
    const { state, user } = setup();
    const box = await screen.findByRole("textbox", { name: /page content/i });
    await waitFor(() => expect(box.textContent).toContain("Ship it."));
    box.focus();
    caretAtEnd(paragraph(box, "Ship it."));
    await user.keyboard("?");
    // Before autosave would run: the click writes the edit, then asks the shell.
    await user.click(screen.getByRole("button", { name: "Open its folder as a Private Space" }));
    await waitFor(() => expect(state.promoted).toEqual(["file_tok"]));
    expect(state.writes.at(-1)).toBe("# Plan\n\nShip it.?\n");
  });
});
