// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HintContext } from "../src/keyboard/hints.ts";
import { shortcutHint } from "../src/keyboard/shortcuts.ts";
import { TabBar } from "../src/tabs/TabBar.tsx";
import { IconButton } from "../src/ui/IconButton.tsx";
import { Modal } from "../src/ui/Modal.tsx";

afterEach(cleanup);
const css = (name: string) => readFileSync(fileURLToPath(import.meta.url).replace(/test[\\/][^\\/]+$/, `src/${name}`), "utf8");
const rule = (source: string, selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(source)![1]!;

describe("shortcut hints", () => {
  it("write the first key combination for the platform and the client", () => {
    expect(shortcutHint("page.new", "desktop", "mac")).toEqual({ keys: "⌘N", aria: "Meta+N" });
    expect(shortcutHint("page.new", "desktop", "other")).toEqual({ keys: "Ctrl+N", aria: "Control+N" });
    expect(shortcutHint("folder.new", "desktop", "mac")?.keys).toBe("⇧⌘N");
    expect(shortcutHint("folder.new", "desktop", "other")?.keys).toBe("Ctrl+Shift+N");
    expect(shortcutHint("settings.open", "desktop", "mac")?.keys).toBe("⌘,");
    // The browser keeps Cmd/Ctrl+N and T, so the web client has its own keys (the table says so).
    expect(shortcutHint("page.new", "web", "mac")).toEqual({ keys: "⌥N", aria: "Alt+N" });
    expect(shortcutHint("tab.new", "web", "other")?.keys).toBe("Alt+T");
    expect(shortcutHint("tab.close", "desktop", "other")?.keys).toBe("Ctrl+W");
    expect(shortcutHint("dialog.close", "desktop", "mac")?.keys).toBe("Esc");
  });
});

describe("IconButton", () => {
  it("is a button named by aria-label, with the tooltip text and shortcut as data the tooltip layer reads", () => {
    render(
      <HintContext value={{ client: "desktop", platform: "mac" }}>
        <IconButton icon="page-plus" label="New page" shortcut="page.new" onClick={() => undefined} />
        <IconButton icon="gear" label="Other" />
      </HintContext>,
    );
    const button = screen.getByRole("button", { name: "New page" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("data-tip")).toBe("New page");
    expect(button.getAttribute("data-tip-keys")).toBe("⌘N");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+N");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.textContent).toBe(""); // the icon is the only content: the name is not read twice
    expect(screen.getByRole("button", { name: "Other" }).hasAttribute("data-tip-keys")).toBe(false);
  });

  it("uses the web client's keys on the web, and Ctrl on other platforms", () => {
    render(
      <HintContext value={{ client: "web", platform: "other" }}>
        <IconButton icon="page-plus" label="New page" shortcut="page.new" />
      </HintContext>,
    );
    expect(screen.getByRole("button", { name: "New page" }).getAttribute("data-tip-keys")).toBe("Alt+N");
  });

  it("is 28px square, rings on keyboard focus, and has no text label", () => {
    const base = rule(css("ui.css"), ".icon-btn");
    expect(base).toMatch(/width: 28px/);
    expect(base).toMatch(/height: 28px/);
    expect(css("ui.css")).toMatch(/\.icon-btn:focus-visible \{ outline: 2px solid var\(--thoth-accent\)/);
  });
});

describe("the tab bar and dialogs", () => {
  const tabs = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "A very long title", title: "Docs/A very long title.md" },
  ];

  it("names its icon buttons, gives the tab text a truncation tooltip, and closes with a tooltip", () => {
    render(
      <HintContext value={{ client: "desktop", platform: "other" }}>
        <TabBar tabs={tabs} active="a" onActivate={() => undefined} onClose={() => undefined} onNew={() => undefined} />
      </HintContext>,
    );
    const add = screen.getByRole("button", { name: "New tab" });
    expect(add.getAttribute("data-tip-keys")).toBe("Ctrl+T");
    const tab = screen.getByRole("tab", { name: "A very long title" });
    expect(tab.getAttribute("data-tip")).toBe("A very long title");
    expect(tab.hasAttribute("data-tip-fit")).toBe(true); // shown only when the title is cut off
    expect(tab.getAttribute("title")).toBe("Docs/A very long title.md"); // the path stays a hint on the tab
    const close = tab.parentElement!.querySelector(".tab-close")!;
    expect(close.getAttribute("data-tip")).toBe("Close tab");
    expect(close.getAttribute("data-tip-keys")).toBe("Ctrl+W");
  });

  it("opens each tab at 270px, 1.5 times the old 180px, and lets many tabs shrink to 96px", () => {
    const tab = rule(css("shell.css"), ".tab");
    expect(tab).toMatch(/flex: 0 1 270px/);
    expect(tab).toMatch(/width: 270px/);
    expect(tab).toMatch(/min-width: 96px/);
    expect(tab).toMatch(/max-width: 330px/);
    expect(rule(css("shell.css"), ".tab-close")).toMatch(/width: 28px/);
  });

  it("a dialog's Close is an icon button with the Escape key in its tooltip", () => {
    render(
      <HintContext value={{ client: "desktop", platform: "mac" }}>
        <Modal title="Hello" onClose={() => undefined}>
          <p>Body</p>
        </Modal>
      </HintContext>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.getAttribute("data-tip")).toBe("Close");
    expect(close.getAttribute("data-tip-keys")).toBe("Esc");
  });
});
