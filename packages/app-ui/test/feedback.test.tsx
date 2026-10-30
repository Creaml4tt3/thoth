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

describe("Include recent app log (ADR-0040)", () => {
  const LINES = ["2026-10-30T10:00:00Z INFO thoth: started", "2026-10-30T10:00:01Z WARN host: command failed code=io"];
  const LOG = "Include recent app log";
  function withLog(diagnostics: () => Promise<string[]>, impl?: (input: FeedbackRequest) => Promise<void>) {
    const { target, send } = sender(impl);
    const user = userEvent.setup();
    render(<FeedbackDialog target={() => Promise.resolve(target)} context={CONTEXT} diagnostics={diagnostics} onClose={() => undefined} />);
    return { user, send };
  }
  const write = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByText("Sent to Thoth demo server.");
    await user.type(screen.getByRole("textbox", { name: "Your message" }), "It froze.");
  };

  it("log_box_absent_without_diagnostics_prop", async () => {
    setup(sender().target);
    await screen.findByText("Sent to Thoth demo server.");
    expect(screen.queryByRole("checkbox", { name: LOG })).toBeNull();
    expect(screen.queryByText(/app log/)).toBeNull();
  });

  it("log_box_off_by_default_and_nothing_sent", async () => {
    const diagnostics = vi.fn(() => Promise.resolve(LINES));
    const { user, send } = withLog(diagnostics);
    await write(user);
    expect(checked(screen.getByRole("checkbox", { name: LOG }))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).not.toHaveProperty("diagnostics");
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("ticking_shows_exact_lines_then_sends_them", async () => {
    const diagnostics = vi.fn(() => Promise.resolve(LINES));
    const { user, send } = withLog(diagnostics);
    await write(user);
    await user.click(screen.getByRole("checkbox", { name: LOG }));
    const pre = await waitFor(() => {
      const el = document.querySelector("pre");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(pre.textContent).toBe(LINES.join("\n"));
    expect(pre.tabIndex).toBe(0);
    expect(description(pre)).toBe("This is everything that will be sent. File paths, links and email addresses are removed; check that nothing private is left.");
    // Unticking and ticking again does not ask the host again.
    await user.click(screen.getByRole("checkbox", { name: LOG }));
    await user.click(screen.getByRole("checkbox", { name: LOG }));
    expect(diagnostics).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(send.mock.calls[0]![0].diagnostics).toEqual({ log: LINES });
  });

  it("empty_log_shows_no_log_yet_and_sends_nothing", async () => {
    const { user, send } = withLog(() => Promise.resolve([]));
    await write(user);
    await user.click(screen.getByRole("checkbox", { name: LOG }));
    expect(await screen.findByText("No log yet.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("No log yet.");
    expect(document.querySelector("pre")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Thank you. Your message was sent.");
    expect(send.mock.calls[0]![0]).not.toHaveProperty("diagnostics");
  });

  it("collect_failure_shows_message_and_still_sends_feedback", async () => {
    const { user, send } = withLog(() => Promise.reject(new Error("host gone")));
    await write(user);
    await user.click(screen.getByRole("checkbox", { name: LOG }));
    expect(await screen.findByText("The app log could not be read. You can still send your message without it.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Thank you. Your message was sent.");
    expect(send.mock.calls[0]![0]).not.toHaveProperty("diagnostics");
  });

  it("a failed read is retried by unticking and ticking again", async () => {
    const diagnostics = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new Error("host gone")).mockResolvedValueOnce(LINES);
    const { user } = withLog(diagnostics);
    await write(user);
    await user.click(screen.getByRole("checkbox", { name: LOG }));
    await screen.findByText(/The app log could not be read/);
    await user.click(screen.getByRole("checkbox", { name: LOG }));
    await user.click(screen.getByRole("checkbox", { name: LOG }));
    await waitFor(() => expect(document.querySelector("pre")?.textContent).toBe(LINES.join("\n")));
    expect(diagnostics).toHaveBeenCalledTimes(2);
  });

  it("Send waits while the ticked log is loading", async () => {
    let resolve!: (lines: string[]) => void;
    const { user } = withLog(() => new Promise((r) => (resolve = r)));
    await write(user);
    // The status line is there, empty, before the tick, so the loading text is announced as a change.
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    await user.click(screen.getByRole("checkbox", { name: LOG }));
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("Reading the app log…");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    resolve(LINES);
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("old_server_refusing_log_says_untick", async () => {
    const { user, send } = withLog(() => Promise.resolve(LINES), () => Promise.reject(new ProblemError(problem("validation_failed", { detail: "Unrecognized key: diagnostics" }))));
    await write(user);
    await user.click(screen.getByRole("checkbox", { name: LOG }));
    await waitFor(() => expect(document.querySelector("pre")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This server doesn't accept the app log yet. Untick “Include recent app log” and send again.");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("names the log in the privacy note only where there is one", async () => {
    withLog(() => Promise.resolve(LINES));
    expect(await screen.findByText(/and, if you include it, the app log shown above\./)).toBeTruthy();
  });
});
