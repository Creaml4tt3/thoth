import { expectProblem, type Check } from "./support.ts";

/**
 * Capability `feedback` (ADR-0033). The suite never sends a real message: a conformance run must not leave feedback
 * on someone's server. It checks the refusals only, which a conforming server stores nothing for.
 */
export const feedbackChecks: Check[] = [
  {
    id: "feedback.refusals",
    title: "sendFeedback refuses an unknown kind, an empty message and an unknown field with 400 validation_failed, with or without credentials",
    capability: "feedback",
    async run(ctx) {
      for (const auth of ["none", "token"] as const) {
        expectProblem(await ctx.client.call("sendFeedback", { json: { kind: "complaint", message: "x" }, auth }), 400, "validation_failed", `sendFeedback with an unknown kind (auth ${auth})`);
        expectProblem(await ctx.client.call("sendFeedback", { json: { kind: "idea", message: "" }, auth }), 400, "validation_failed", `sendFeedback with an empty message (auth ${auth})`);
        expectProblem(await ctx.client.call("sendFeedback", { json: { kind: "idea", message: "x", pageTitle: "Plan" }, auth }), 400, "validation_failed", `sendFeedback with an unknown field (auth ${auth})`);
      }
    },
  },
  {
    id: "feedback.diagnostics.too_long",
    title: "sendFeedback refuses an app log of more than 200 lines with 400 validation_failed, with or without credentials",
    capability: "feedback",
    async run(ctx) {
      for (const auth of ["none", "token"] as const) {
        expectProblem(await ctx.client.call("sendFeedback", { json: { kind: "problem", message: "x", diagnostics: { log: Array(201).fill("x") } }, auth }), 400, "validation_failed", `sendFeedback with 201 log lines (auth ${auth})`);
      }
    },
  },
];
