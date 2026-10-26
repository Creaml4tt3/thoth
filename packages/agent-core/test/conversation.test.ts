/**
 * Conversations (ADR-0007, amendment "Conversations", 2026-10-26): a follow-up is a new one-shot run of the same
 * conversation, and the earlier turns (question and answer, oldest first) are quoted to the CLI as context in front of
 * the new question. The newest turns that fit the prompt limit are sent; a turn whose details were deleted, or whose
 * material this turn is not given, is left out.
 */
import { describe, expect, it } from "vitest";
import { conversationKey, conversationTurns, fitConversation, MAX_PROMPT_CHARS, type EarlierTurn, type RunRecord } from "../src/index.ts";

const turn = (n: number, question: string, answer: string | null, extra: Partial<EarlierTurn> = {}): EarlierTurn => ({ turn: n, question, answer, kept: true, allowed: true, ...extra });

describe("fitConversation", () => {
  it("quotes every earlier question and answer, oldest first, in front of the new question", () => {
    const fit = fitConversation([turn(1, "What is on the page?", "A plan with one line."), turn(2, "Who wrote it?", "It does not say.")], "And when?");
    expect(fit).toMatchObject({ earlier: 2, sent: 2, deleted: 0, notAllowed: 0 });
    const text = fit.context;
    const first = text.indexOf("What is on the page?");
    const firstAnswer = text.indexOf("A plan with one line.");
    const second = text.indexOf("Who wrote it?");
    const secondAnswer = text.indexOf("It does not say.");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(firstAnswer);
    expect(firstAnswer).toBeLessThan(second);
    expect(second).toBeLessThan(secondAnswer);
    expect(text).toContain("--- Earlier turn 1 ---");
    expect(text.endsWith("--- End of earlier turns ---\n\n")).toBe(true);
    // The new question is not part of the context: the caller puts it after.
    expect(text).not.toContain("And when?");
  });

  it("says when an earlier turn gave no answer", () => {
    expect(fitConversation([turn(1, "Hello?", null)], "Again?").context).toContain("(No answer was given.)");
  });

  it("sends nothing when there is no earlier turn", () => {
    expect(fitConversation([], "First?")).toEqual({ context: "", earlier: 0, sent: 0, deleted: 0, notAllowed: 0 });
  });

  it("keeps the newest turns that fit the prompt limit with the new question, and stops at the first that does not", () => {
    const big = "x".repeat(6000);
    const turns = [turn(1, "one", big), turn(2, "two", big), turn(3, "three", big), turn(4, "four", "short"), turn(5, "five", big)];
    const question = "q".repeat(2500);
    const fit = fitConversation(turns, question);
    expect(fit.earlier).toBe(5);
    expect(fit.sent).toBe(3);
    expect(fit.context).not.toContain("--- Earlier turn 1 ---");
    expect(fit.context).not.toContain("--- Earlier turn 2 ---");
    expect(fit.context).toContain("--- Earlier turn 3 ---");
    expect(fit.context).toContain("--- Earlier turn 5 ---");
    expect(fit.context.length + question.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    // Contiguous: a short older turn is not squeezed in past one that did not fit.
    const gap = fitConversation([turn(1, "tiny", "tiny"), turn(2, "huge", "y".repeat(19_900)), turn(3, "last", "last")], "q");
    expect(gap.sent).toBe(1);
    expect(gap.context).not.toContain("tiny");
  });

  it("leaves out a turn whose details were deleted, and one whose material this turn is not given", () => {
    const fit = fitConversation([turn(1, "pruned", null, { kept: false }), turn(2, "workspace", "From the spec.", { allowed: false }), turn(3, "kept", "Yes.")], "Next?");
    expect(fit).toMatchObject({ earlier: 3, sent: 1, deleted: 1, notAllowed: 1 });
    expect(fit.context).not.toContain("pruned");
    expect(fit.context).not.toContain("From the spec.");
    expect(fit.context).toContain("kept");
  });
});

describe("conversation turns from the records", () => {
  const record = (id: string, createdAt: number, conversation?: RunRecord["conversation"]): RunRecord => ({
    version: 1,
    id,
    provider: { id: "claude", name: "Claude Code" },
    task: { prompt: id },
    context: [],
    state: "done",
    createdAt,
    updatedAt: createdAt,
    changes: [],
    ...(conversation ? { conversation } : {}),
  });

  it("groups runs by conversation (an old run without one is its own), turns in order, conversations newest first", () => {
    const a1 = record("01900000-0000-7000-8000-00000000000a", 1, { id: "01900000-0000-7000-8000-00000000000a", turn: 1 });
    const a2 = record("01900000-0000-7000-8000-00000000000b", 5, { id: a1.id, turn: 2 });
    const old = record("01900000-0000-7000-8000-00000000000c", 3);
    const followOld = record("01900000-0000-7000-8000-00000000000d", 4, { id: old.id, turn: 2 });
    expect(conversationKey(old)).toBe(old.id);
    expect(conversationKey(a2)).toBe(a1.id);
    const grouped = conversationTurns([a2, followOld, old, a1]);
    expect(grouped.map((c) => [c.id, c.turns.map((t) => t.id)])).toEqual([
      [a1.id, [a1.id, a2.id]],
      [old.id, [old.id, followOld.id]],
    ]);
  });
});
