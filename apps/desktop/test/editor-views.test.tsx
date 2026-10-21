// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { guardWrites } from "./support/write-guard.ts";

const dirs = tempDirs();
let root: string;

const RICH = `# Rich

[!note] not a callout here.

> [!warning] Careful
> Mind the gap.

See [[Target Page]], [[Missing One]] and [[Target Page|an alias]].

<div class="x">raw html</div>

$$
x^2 + y^2
$$

[^1]: A footnote definition.

- [ ] open task
- [x] done task
`;

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Rich.md": RICH, "Folder/Target Page.md": "# Target Page\n\nI am the target.\n" });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

async function openRich() {
  const guard = guardWrites();
  const app = await openApp(root);
  await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: "Rich" }));
  const box = await editorBox();
  await waitFor(() => expect(box.textContent).toContain("Mind the gap."));
  return { app, box, guard };
}

describe("node views", () => {
  it("renders callouts by kind", async () => {
    const { box } = await openRich();
    const callout = box.querySelector<HTMLElement>(".callout")!;
    expect(callout.dataset["callout"]).toBe("warning");
    expect(callout.querySelector(".callout-title")!.textContent).toBe("Careful");
  });

  it("shows raw, html and math blocks read-only and labelled as preserved", async () => {
    const { box } = await openRich();
    const kinds = [...box.querySelectorAll<HTMLElement>(".preserved")].map((n) => n.dataset["kind"]);
    expect(kinds).toEqual(expect.arrayContaining(["html", "math", "raw"]));
    for (const node of box.querySelectorAll<HTMLElement>(".preserved")) {
      expect(node.getAttribute("contenteditable")).toBe("false");
      expect(node.textContent).toMatch(/preserved as written/);
    }
    expect(box.querySelector('.preserved[data-kind="html"] pre')!.textContent).toBe('<div class="x">raw html</div>');
  });

  it("renders wikilinks as chips: resolved, unresolved, and with a label", async () => {
    const { box } = await openRich();
    const chips = [...box.querySelectorAll<HTMLElement>("a.wikilink")];
    expect(chips.map((c) => c.textContent)).toEqual(["Target Page", "Missing One", "an alias"]);
    expect(chips.map((c) => c.dataset["state"])).toEqual(["resolved", "unresolved", "resolved"]);
    expect(chips[0]!.dataset["target"]).toBe("Folder/Target Page.md");
  });

  it("clicking a resolved wikilink chip opens the target page; an unresolved one does nothing", async () => {
    const { app, box } = await openRich();
    const [resolved, missing] = [...box.querySelectorAll<HTMLElement>("a.wikilink")];
    await app.user.click(missing!);
    expect(screen.getByRole("heading", { level: 1, name: "Rich" })).toBeTruthy();
    await app.user.click(resolved!);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Target Page" })).toBeTruthy());
    expect((await editorBox()).textContent).toContain("I am the target.");
  });

  it("shows backlinks and navigates through them", async () => {
    const { app, box } = await openRich();
    await app.user.click(box.querySelector<HTMLElement>("a.wikilink")!);
    const panel = await screen.findByRole("region", { name: /backlinks/i });
    const link = await within(panel).findByRole("button", { name: /Rich/ });
    await app.user.click(link);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Rich" })).toBeTruthy());
  });

  it("shows breadcrumbs for the open page", async () => {
    const { app, box } = await openRich();
    await app.user.click(box.querySelector<HTMLElement>("a.wikilink")!);
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByText("Folder")).toBeTruthy();
    expect(within(crumbs).getByText("Target Page.md").getAttribute("aria-current")).toBe("page");
  });

  it("opening a page full of preserved blocks and saving makes no write", async () => {
    const { app, guard } = await openRich();
    await app.user.keyboard("{Meta>}s{/Meta}");
    await new Promise((r) => setTimeout(r, 60));
    expect(guard.calls).toHaveLength(0);
  });
});
