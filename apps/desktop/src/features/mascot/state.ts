/**
 * The mascot's state machine: one state for both versions (full and compact), derived from what the assistant is
 * doing and what the person is doing. A pure function of its inputs, so every rule is tested without a DOM; the hook
 * (`useMascotState`) feeds it and keeps the clocks (the "done" moment, the idle time before sleep).
 *
 * In order of priority:
 *   working  a run is starting, streaming or being cancelled;
 *   review   a run is waiting for review (now, or left from an earlier session), or its changes are being applied;
 *   error    the last run failed (until a new task is started);
 *   done     a run just finished well (applied, or nothing to change), for a few seconds, bubble open or not;
 *   listening the prompt bubble is open;
 *   sleeping the window is in the background, or nothing happened for a few minutes;
 *   idle     otherwise.
 */
import type { RunPhase } from "../agents/service.ts";
import type { MascotState } from "./MascotArt.tsx";

/** How long "done" shows before the mascot goes back to idle. */
export const DONE_MS = 3500;
/** Idle time before the mascot falls asleep. */
export const SLEEP_AFTER_MS = 3 * 60_000;

export interface MascotInputs {
  phase: RunPhase;
  /** The state of the current run's record, if there is one (`finished` tells success from failure with it). */
  record: "staging" | "running" | "review" | "applied" | "done" | "discarded" | "cancelled" | "failed" | "interrupted" | null;
  /** Runs from an earlier session still waiting for review. */
  waiting: number;
  bubbleOpen: boolean;
  /** When the current run finished well (ms), or null. */
  doneAt: number | null;
  /** The last time the person did something in the window (ms). */
  lastActivity: number;
  /** The window is visible and focused. */
  windowActive: boolean;
  now: number;
}

export function mascotState(i: MascotInputs): MascotState {
  if (i.phase === "starting" || i.phase === "running" || i.phase === "cancelling") return "working";
  if (i.phase === "review" || i.phase === "applying") return "review";
  if (i.phase === "finished" && (i.record === "failed" || i.record === "interrupted")) return "error";
  if (i.phase === "idle" && i.waiting > 0) return "review";
  if (i.phase === "finished" && i.doneAt !== null && i.now - i.doneAt < DONE_MS) return "done";
  if (i.bubbleOpen) return "listening";
  if (!i.windowActive || i.now - i.lastActivity >= SLEEP_AFTER_MS) return "sleeping";
  return "idle";
}

/** A finished run that went well: its changes were applied, or there was nothing to change. */
export const finishedWell = (phase: RunPhase, record: MascotInputs["record"]): boolean => phase === "finished" && (record === "applied" || record === "done");

/** When the state can next change by itself (a timer is needed then), or null. */
export function nextChange(i: MascotInputs): number | null {
  const times: number[] = [];
  if (i.phase === "finished" && i.doneAt !== null && i.now - i.doneAt < DONE_MS) times.push(i.doneAt + DONE_MS);
  if (i.windowActive && i.now - i.lastActivity < SLEEP_AFTER_MS) times.push(i.lastActivity + SLEEP_AFTER_MS);
  return times.length > 0 ? Math.min(...times) : null;
}
