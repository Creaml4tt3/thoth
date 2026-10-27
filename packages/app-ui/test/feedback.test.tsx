// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const checked = (el: HTMLElement) => (el as HTMLInputElement).checked;
const description = (el: HTMLElement) => (el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProblemError } from "@thoth/workspace-client";
import { problem, type FeedbackRequest } from "@thoth/workspace-protocol";
import { FEEDBACK_EMAIL, FeedbackDialog, pickFeedbackServer, type FeedbackTarget } from "../src/feedback/FeedbackDialog.tsx";

afterEach(cleanup);

const CONTEXT = { client: "desktop", version: "0.4.0", os: "macOS", language: "en" } as const;

function setup(target: FeedbackTarget | null) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<FeedbackDialog target={() => Promise.resolve(target)} context={CONTEXT} onClose={onClose} />);
  return { user, onClose };
}

const sender = (impl: (input: FeedbackRequest) => Promise<void> = () => Promise.resolve()) => {
  const send = vi.fn(impl);
  return { target: { label: "Thoth demo server", send }, send };
};

describe("Send feedback (ADR-0033)", () => {
  it("sends the kind, the message, the email and exactly the details it shows, then says so in a live region", async () => {
    const { target, send } = sender();
    const { user } = setup(target);
    await screen.findByText("Sent to Thoth demo server.");
    expect(checked(screen.getByRole("radio", { name: "A problem" }))).toBe(true);
    await user.click(screen.getByRole("radio", { name: "An idea" }));
    await user.type(screen.getByRole("textbox", { name: "Your message" }), "Tags, please.");
    await user.type(screen.getByRole("textbox", { name: "Your email (optional)" }), "ada@example.org");
    // On by default, and what it adds is on screen.
    expect(checked(screen.getByRole("checkbox", { name: "Include the app version and system" }))).toBe(true);
    for (const shown of ["client: desktop", "version: 0.4.0", "os: macOS", "language: en"]) expect(screen.getByText(shown)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(send).toHaveBeenCalledWith({ kind: "idea", message: "Tags, please.", email: "ada@example.org", context: CONTEXT });
    expect((await screen.findByRole("status")).textContent).toBe("Thank you. Your message was sent.");
  });

  it("leaves the details out when the box is unchecked, and the email when it is empty", async () => {
    const { target, send } = sender();
    const { user } = setup(target);
    await screen.findByText("Sent to Thoth demo server.");
    await user.type(screen.getByRole("textbox", { name: "Your message" }), "It froze.");
    await user.click(screen.getByRole("checkbox", { name: "Include the app version and system" }));
    expect(screen.queryByText("client: desktop")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(send).toHaveBeenCalledWith({ kind: "problem", message: "It froze." });
  });

  it("ties each error to its field and moves focus to the first one; nothing is sent", async () => {
    const { target, send } = sender();
    const { user } = setup(target);
    await screen.findByText("Sent to Thoth demo server.");
    await user.type(screen.getByRole("textbox", { name: "Your email (optional)" }), "not an email");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const message = screen.getByRole("textbox", { name: "Your message" });
    const email = screen.getByRole("textbox", { name: "Your email (optional)" });
    expect(document.activeElement).toBe(message);
    expect(message.getAttribute("aria-invalid")).toBe("true");
    expect(description(message)).toContain("Write a message.");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(description(email)).toContain("Check the email address");
    expect(send).not.toHaveBeenCalled();
    // Fixing the message moves the focus to the next error.
    await user.type(message, "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(document.activeElement).toBe(email);
    expect(message.hasAttribute("aria-invalid")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("says when there are too many messages, and offers the email link", async () => {
    const { target } = sender(() => Promise.reject(new ProblemError(problem("rate_limited", { detail: "slow down" }))));
    const { user } = setup(target);
    await screen.findByText("Sent to Thoth demo server.");
    await user.type(screen.getByRole("textbox", { name: "Your message" }), "Again");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Too many messages for now.");
    expect(screen.getByRole("link", { name: "Or write to us by email" }).getAttribute("href")).toMatch(new RegExp(`^mailto:${FEEDBACK_EMAIL}`));
  });

  it("with no server that takes feedback, says so and offers only the email link", async () => {
    setup(null);
    expect(await screen.findByText(/No server here can take feedback right now/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("link", { name: "Or write to us by email" }).getAttribute("href")).toContain(`mailto:${FEEDBACK_EMAIL}`);
  });
});

it("where links to mail cannot open, shows the address with a Copy button", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<FeedbackDialog target={() => Promise.resolve(null)} context={CONTEXT} mail="copy" onClose={() => undefined} />);
  await screen.findByText(/No server here can take feedback right now/);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText(FEEDBACK_EMAIL)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Copy address" }));
  expect(writeText).toHaveBeenCalledWith(FEEDBACK_EMAIL);
  await waitFor(() => expect(screen.getByText("Copied.")).toBeTruthy());
});

describe("pickFeedbackServer", () => {
  const server = (id: string, url: string, auth: "signed-out" | "browser" = "browser") => ({ info: { id, url, label: id, auth, providers: [] }, workspaces: null, error: null });
  const caps: Record<string, string[] | null> = { demo: ["feedback"], team: ["feedback"], old: [], signedOut: ["feedback"] };
  const capabilitiesOf = (id: string) => Promise.resolve(caps[id] ?? null);

  it("prefers the demo server once it is added, signed in or not; else the first signed-in server that takes feedback", async () => {
    const starter = "https://demo.example";
    expect((await pickFeedbackServer([server("old", "https://old.example"), server("team", "https://team.example"), server("demo", starter, "signed-out")], capabilitiesOf, starter))?.info.id).toBe("demo");
    expect((await pickFeedbackServer([server("old", "https://old.example"), server("signedOut", "https://x.example", "signed-out"), server("team", "https://team.example")], capabilitiesOf, starter))?.info.id).toBe("team");
    expect(await pickFeedbackServer([server("old", "https://old.example")], capabilitiesOf, starter)).toBeNull();
    // A demo server that does not list the capability is passed over.
    expect(await pickFeedbackServer([server("old", starter)], capabilitiesOf, starter)).toBeNull();
  });
});

it("waits for the server lookup before offering Send", async () => {
  let resolve!: (t: FeedbackTarget | null) => void;
  render(<FeedbackDialog target={() => new Promise((r) => (resolve = r))} context={CONTEXT} onClose={() => undefined} />);
  expect(screen.getByText("Finding where to send it…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  resolve(sender().target);
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
});
