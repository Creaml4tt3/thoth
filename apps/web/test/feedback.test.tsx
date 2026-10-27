// @vitest-environment jsdom
// Send feedback in the web client (ADR-0033): Settings → Help and feedback and the palette, to the one server, only
// when it lists `feedback`.
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { cleanup, fakeBrowser, screen, signInThroughUi, within } from "./support/render.tsx";

afterEach(() => cleanup());

async function signedIn(capabilities: string[]) {
  const server = new FakeWebServer({ capabilities, limits: { maxPagesPerWorkspace: 200, idempotencyWindowSeconds: 86400 } });
  const ws = server.workspace("Notes", "owner");
  server.servers.writeAsOther(ws, { title: "Field notes", markdown: "# Field notes\n\nHello.\n" });
  const browser = fakeBrowser(server);
  await signInThroughUi(browser);
  await screen.findByRole("treeitem", { name: /^Notes/ });
  return browser;
}

describe("Send feedback in the web client", () => {
  it("sends from Settings with the browser's details, and the dialog passes axe", async () => {
    const browser = await signedIn(["search", "feedback"]);
    await browser.user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Search" });
    await browser.user.keyboard("> open settings{Enter}");
    const section = await screen.findByRole("region", { name: "Help and feedback" });
    await browser.user.click(within(section).getByRole("button", { name: "Send feedback…" }));
    const dialog = await screen.findByRole("dialog", { name: "Send feedback" });
    await within(dialog).findByText(/^Sent to /);
    expect(within(dialog).getByText("client: web")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Or write to us by email" }).getAttribute("href")).toMatch(/^mailto:/);
    expect(await axeViolations(dialog)).toEqual([]);
    await browser.user.click(within(dialog).getByRole("radio", { name: "An idea" }));
    await browser.user.type(within(dialog).getByRole("textbox", { name: "Your message" }), "Dark sidebar");
    await browser.user.click(within(dialog).getByRole("button", { name: "Send" }));
    await within(dialog).findByText("Thank you. Your message was sent.");
    expect(browser.server.servers.feedback.map((f) => f.body)).toEqual([expect.objectContaining({ kind: "idea", message: "Dark sidebar", context: expect.objectContaining({ client: "web", language: "en" }) })]);
  });

  it("is not offered when the server does not take feedback", async () => {
    const browser = await signedIn(["search"]);
    await browser.user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Search" });
    await browser.user.keyboard("> feedback");
    expect(within(palette).queryByRole("option", { name: /Send feedback/ })).toBeNull();
    await browser.user.keyboard("{Escape}");
    await browser.user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Search" });
    await browser.user.keyboard("> open settings{Enter}");
    await screen.findByRole("heading", { name: "Settings", level: 1 });
    expect(screen.queryByRole("region", { name: "Help and feedback" })).toBeNull();
  });
});
