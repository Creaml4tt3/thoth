// @vitest-environment jsdom
// The shared workspace tree in the web client: rename (F2), folders, keyboard order (ADR-0016, Phase 3b AC 1, 9).
import { afterEach, describe, expect, it } from "vitest";
import { isFolderMarkdown } from "@thoth/app-ui/workspace/folders.ts";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { cleanup, fakeBrowser, screen, signInThroughUi, waitFor, within } from "./support/render.tsx";

afterEach(() => cleanup());

async function signedIn(pages: { title: string; position?: string }[]) {
  const server = new FakeWebServer();
  const ws = server.workspace("Notes");
  for (const p of pages) server.servers.writeAsOther(ws, { title: p.title, markdown: `# ${p.title}\n`, ...(p.position ? { position: p.position } : {}) });
  const browser = fakeBrowser(server);
  await signInThroughUi(browser);
  const tree = screen.getByRole("tree", { name: "Workspaces" });
  const group = await within(tree).findByRole("group", { name: "Pages in Notes" });
  return { browser, ws, tree, group };
}

const names = (group: HTMLElement) => within(group).getAllByRole("treeitem").map((i) => i.textContent);

describe("the workspace tree in the web client", () => {
  it("renames a page with F2 (the text and the title) and keeps the tree operable by keyboard", async () => {
    const { browser, ws, group } = await signedIn([{ title: "Plan" }, { title: "Other" }]);
    const page = [...ws.pages.values()].find((p) => p.title === "Plan")!;
    within(group).getByRole("treeitem", { name: "Plan" }).focus();
    await browser.user.keyboard("{F2}");
    await screen.findByRole("textbox", { name: "Rename Plan" });
    await browser.user.keyboard("Roadmap{Enter}");
    await waitFor(() => expect(page.title).toBe("Roadmap"));
    expect(page.markdown).toBe("# Roadmap\n");
    await waitFor(() => expect(names(group)).toEqual(["Other", "Roadmap"]));
  });

  it("reorders with Alt+Shift+Up/Down: one metadata call, only the moved page's position", async () => {
    const { browser, ws, group } = await signedIn([{ title: "A", position: "G" }, { title: "B", position: "N" }, { title: "C", position: "U" }]);
    within(group).getByRole("treeitem", { name: "C" }).focus();
    await browser.user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
    await waitFor(() => expect(names(group)).toEqual(["A", "C", "B"]));
    const calls = browser.server.requests.filter((r) => r.method === "POST" && r.url.endsWith("/move"));
    expect(calls).toHaveLength(1);
    expect(Object.keys(JSON.parse(calls[0]!.body) as object)).toEqual(["position"]);
    const byTitle = (t: string) => [...ws.pages.values()].find((p) => p.title === t)!;
    expect(byTitle("A").position).toBe("G");
    expect(byTitle("B").position).toBe("N");
    expect(byTitle("C").position! > "G" && byTitle("C").position! < "N").toBe(true);
  });

  it("New folder makes a folder page that looks like a folder, and names it in place", async () => {
    const { browser, ws, tree, group } = await signedIn([{ title: "Plan" }]);
    await browser.user.click(within(tree).getByRole("button", { name: "New folder in Notes" }));
    await screen.findByRole("textbox", { name: "Rename New folder" });
    const folder = [...ws.pages.values()].find((p) => p.title === "New folder")!;
    expect(isFolderMarkdown(folder.markdown)).toBe(true);
    await browser.user.keyboard("Research{Enter}");
    const row = await within(group).findByRole("treeitem", { name: "Research" });
    expect(row.getAttribute("data-kind")).toBe("folder");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.getAttribute("title")).toBe("Folder · Empty");
  });
});
