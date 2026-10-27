/**
 * Whether the first-run tour (ADR-0032) was seen, and the request to show it. Seen (finished or skipped) is an app
 * preference in the webview's localStorage, like the language; the first run asks only when it was not seen, while
 * Settings and the palette ask again on purpose. The request is shared by the window, like `requestNewFolder`: the
 * shell's tour picks it up.
 */
import { useSyncExternalStore } from "react";
import type { TourStepId } from "./steps.ts";

export const TOUR_KEY = "thoth.desktop.tour";

export interface TourRequest {
  /** Wait until this step's control is on screen before the steps are counted (the Welcome page's editor); null: start now. */
  waitFor: TourStepId | null;
  nonce: number;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function tourSeen(): boolean {
  const stored = storage()?.getItem(TOUR_KEY);
  return stored === "finished" || stored === "skipped";
}

export function markTourSeen(how: "finished" | "skipped"): void {
  try {
    storage()?.setItem(TOUR_KEY, how);
  } catch {
    // storage refused: the tour may come back on a later first run, which is harmless
  }
}

let current: TourRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};

/** Settings, the palette: show the tour now, seen or not. */
export function requestTour(): void {
  current = { waitFor: null, nonce: ++seq };
  emit();
}

/** The Welcome page just opened for the first time: the tour, once its editor is there, unless it was seen. */
export function requestFirstRunTour(): void {
  if (tourSeen()) return;
  current = { waitFor: "editor", nonce: ++seq };
  emit();
}

export function clearTour(): void {
  if (current === null) return;
  current = null;
  emit();
}

const read = () => current;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function useTourRequest(): TourRequest | null {
  return useSyncExternalStore(subscribe, read, read);
}
