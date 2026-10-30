import { describe, expect, it } from "vitest";
import { createErrorReporter } from "../src/platform/errors.ts";

type Sent = { kind: "error" | "rejection"; message: string; stack?: string };
const setup = (limit?: number) => {
  const sent: Sent[] = [];
  const report = createErrorReporter(async (e) => void sent.push(e), limit);
  return { sent, report };
};
const error = (message: string, stack?: string) => ({ message, error: stack === undefined ? undefined : { stack } }) as unknown as ErrorEvent;
const rejection = (reason: unknown) => ({ reason }) as unknown as PromiseRejectionEvent;

describe("webview error reporting", () => {
  it("reports_error_event_message_and_stack", () => {
    const { sent, report } = setup();
    report(error("boom", "Error: boom\n  at a"));
    report(error("no stack"));
    expect(sent).toEqual([{ kind: "error", message: "boom", stack: "Error: boom\n  at a" }, { kind: "error", message: "no stack" }]);
  });

  it("reports_rejection_reason_string_and_error", () => {
    const { sent, report } = setup();
    report(rejection("plain"));
    const err = new Error("bad");
    report(rejection(err));
    report(rejection({ toString: () => { throw new Error("no"); } }));
    expect(sent[0]).toEqual({ kind: "rejection", message: "plain" });
    expect(sent[1]).toEqual({ kind: "rejection", message: "bad", stack: err.stack });
    expect(sent).toHaveLength(3);
  });

  it("stops_after_limit", () => {
    const { sent, report } = setup();
    for (let i = 0; i < 25; i++) report(error(`e${i}`));
    expect(sent).toHaveLength(20);
  });

  it("drops_repeats", () => {
    const { sent, report } = setup(2);
    report(error("a"));
    report(error("a"));
    report(rejection("a"));
    report(error("a"));
    expect(sent.map((s) => s.kind)).toEqual(["error", "rejection"]);
  });

  it("send_failure_is_swallowed", async () => {
    const report = createErrorReporter(() => Promise.reject(new Error("host down")));
    expect(() => report(error("x"))).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // an unhandled rejection would fail the run
  });
});
