/**
 * Conversations (ADR-0007, amendment "Conversations", 2026-10-26). A conversation is Thoth's, not the CLI's: every
 * turn is its own one-shot run (no session flags, nothing kept by the CLI), and a follow-up gets the earlier turns of
 * its conversation (each question and answer, oldest first) quoted in front of the new question, the way a selected
 * excerpt is quoted after it: sent, never kept in the vault's run record. The record holds the conversation's id and
 * the turn's number only.
 *
 * The conversation's id is the run id of its first turn, so an older run without one (a one-turn conversation) can be
 * continued too.
 */
import { MAX_PROMPT_CHARS, type RunRecord } from "./records.ts";

/** The conversation a run belongs to: the id its record names, or its own id (an older run, or a first turn). */
export const conversationKey = (record: Pick<RunRecord, "id" | "conversation">): string => record.conversation?.id ?? record.id;

/** A run's turn number in its conversation (an older run is turn 1). */
export const turnOf = (record: Pick<RunRecord, "conversation">): number => record.conversation?.turn ?? 1;

export interface Conversation {
  id: string;
  /** Oldest first. */
  turns: RunRecord[];
}

/** The runs grouped into conversations, turns in order; the conversation with the newest turn first. */
export function conversationTurns(records: readonly RunRecord[]): Conversation[] {
  const byKey = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = conversationKey(record);
    const list = byKey.get(key);
    if (list) list.push(record);
    else byKey.set(key, [record]);
  }
  const conversations = [...byKey].map(([id, turns]) => ({ id, turns: turns.sort((a, b) => turnOf(a) - turnOf(b) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)) }));
  const newest = (c: Conversation) => Math.max(...c.turns.map((t) => t.createdAt));
  return conversations.sort((a, b) => newest(b) - newest(a) || (a.id < b.id ? 1 : -1));
}

/** One earlier turn, as the hub found it. */
export interface EarlierTurn {
  turn: number;
  /** The person's own question (the record's task). */
  question: string;
  /** What the agent answered; null when it said nothing (or its details are gone, see `kept`). */
  answer: string | null;
  /** False when the local details (the transcript the answer comes from) were deleted. */
  kept: boolean;
  /** False when this turn is not given the material that turn had (its answer may quote it), so it is left out. */
  allowed: boolean;
}

export interface ConversationFit {
  /** The framed earlier turns, to put in front of the new question; "" when none is sent. */
  context: string;
  /** Earlier turns there were. */
  earlier: number;
  /** Earlier turns that were sent (the newest that fit). */
  sent: number;
  /** Left out: their details were deleted. */
  deleted: number;
  /** Left out: this turn is not given what they were given. */
  notAllowed: number;
}

/** The line that ends the quoted turns. The question follows it. */
export const END_OF_TURNS = "--- End of earlier turns ---";

const PREAMBLE = "This question continues a conversation with you. Its earlier turns are quoted below, oldest first, for context only; the new question follows them.\n\n";

function block(turn: EarlierTurn): string {
  return [`--- Earlier turn ${turn.turn} ---`, "Question:", '"""', turn.question, '"""', "Answer:", '"""', turn.answer ?? "(No answer was given.)", '"""', "", ""].join("\n");
}

/**
 * Which earlier turns go with the new question, and how they read. Turns whose details were deleted or that are not
 * allowed are left out; of the rest, the newest that fit `limit` together with the question are sent, stopping at the
 * first that does not fit (so what is sent is the most recent stretch of the conversation, with no gaps).
 */
export function fitConversation(turns: readonly EarlierTurn[], question: string, limit = MAX_PROMPT_CHARS): ConversationFit {
  const deleted = turns.filter((t) => !t.kept).length;
  const notAllowed = turns.filter((t) => t.kept && !t.allowed).length;
  const usable = turns.filter((t) => t.kept && t.allowed);
  const fixed = PREAMBLE.length + END_OF_TURNS.length + 2 + question.length;
  const chosen: string[] = [];
  let used = fixed;
  for (let i = usable.length - 1; i >= 0; i--) {
    const text = block(usable[i]!);
    if (used + text.length > limit) break;
    used += text.length;
    chosen.unshift(text);
  }
  const context = chosen.length === 0 ? "" : `${PREAMBLE}${chosen.join("")}${END_OF_TURNS}\n\n`;
  return { context, earlier: turns.length, sent: chosen.length, deleted, notAllowed };
}
