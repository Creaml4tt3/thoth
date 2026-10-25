/**
 * The clocks and window signals the mascot needs: its state (fed from the Agent service), the window's size, whether
 * the person is typing in the editor (Auto size shrinks then), and whether the OS asks for reduced motion.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentsService } from "../agents/service.ts";
import type { MascotState } from "./MascotArt.tsx";
import { finishedWell, mascotState, nextChange, type MascotInputs } from "./state.ts";

/** How long after the last key in the editor Auto size grows back. */
export const TYPING_IDLE_MS = 2500;

/** Runs from an earlier session that are waiting for review and can be opened again. */
export function waitingReviews(state: ReturnType<AgentsService["getState"]>): string[] {
  return state.history.filter((r) => r.state === "review" && state.available[r.id]?.review).map((r) => r.id);
}

export function useMascotState(agents: AgentsService, bubbleOpen: boolean, now: () => number = Date.now): MascotState {
  const s = useSyncExternalStore(agents.subscribe, agents.getState);
  const [, setTick] = useState(0);
  const doneAt = useRef<{ id: string; at: number } | null>(null);
  const lastActivity = useRef(now());
  const [windowActive, setWindowActive] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");

  const record = s.record?.state ?? null;
  const id = s.record?.id ?? null;
  if (finishedWell(s.phase, record) && id !== null && doneAt.current?.id !== id) doneAt.current = { id, at: now() };
  if (!finishedWell(s.phase, record) && doneAt.current && s.phase !== "finished") doneAt.current = null;

  // Activity wakes it, and the window going to the background puts it to sleep.
  useEffect(() => {
    let last = 0;
    const active = () => {
      const t = now();
      lastActivity.current = t;
      if (t - last > 1000) {
        last = t;
        setTick((n) => n + 1);
      }
    };
    const visibility = () => setWindowActive(document.visibilityState !== "hidden" && (typeof document.hasFocus !== "function" || document.hasFocus()));
    const focus = () => {
      setWindowActive(document.visibilityState !== "hidden");
      active();
    };
    const blur = () => setWindowActive(false);
    window.addEventListener("pointerdown", active, true);
    window.addEventListener("keydown", active, true);
    window.addEventListener("pointermove", active, { capture: true, passive: true });
    window.addEventListener("wheel", active, { capture: true, passive: true });
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pointerdown", active, true);
      window.removeEventListener("keydown", active, true);
      window.removeEventListener("pointermove", active, true);
      window.removeEventListener("wheel", active, true);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [now]);

  const inputs: MascotInputs = {
    phase: s.phase,
    record,
    waiting: s.phase === "idle" ? waitingReviews(s).length : 0,
    bubbleOpen,
    doneAt: doneAt.current?.at ?? null,
    lastActivity: lastActivity.current,
    windowActive,
    now: now(),
  };
  const state = mascotState(inputs);
  const next = nextChange(inputs);
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, next - now()) + 20);
    return () => clearTimeout(timer);
  }, [next, now]);
  return state;
}

/** The window's inner size, live. */
export function useWindowSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

const EDITORS = ".ProseMirror, .cm-editor";

/** True while the person is typing in a page editor, and for `TYPING_IDLE_MS` after the last key. */
export function useEditorTyping(enabled: boolean): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setTyping(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!(event.target instanceof Element) || !event.target.closest(EDITORS)) return;
      setTyping(true);
      clearTimeout(timer);
      timer = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(timer);
    };
  }, [enabled]);
  return typing;
}

/** True when the OS asks for reduced motion. */
export function useReducedMotion(): boolean {
  const query = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const [reduced, setReduced] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const onChange = (event: { matches: boolean }) => setReduced(event.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return reduced;
}
