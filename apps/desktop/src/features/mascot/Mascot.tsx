/**
 * The Thoth assistant on screen: the mascot floating in a corner of the window (bottom-right by default), and the
 * prompt bubble it opens. Desktop only, and only where the host can run agent CLIs.
 *
 * - It is one button. Its name says its state ("Thoth assistant, working") and a polite live region says when the
 *   state changes. Click (or Enter, Space, the shortcut) opens the bubble; when a run waits for review it opens the
 *   review instead.
 * - It can be dragged with the pointer, or moved with the arrow keys while it has focus (Shift for bigger steps). With
 *   "Snap to the edges" on, it settles on the nearest edge or corner when let go (pointer) or when the keys stop
 *   (keyboard, without animation). It never goes over the tab strip, comes back inside the window after a resize, and
 *   its place is remembered (as distances from its corner's edges, prefs.ts).
 * - A small button beside it (and a shortcut) shrinks it to the compact badge and back; Auto size does that by itself
 *   while you type in a page or when the window is narrow. Both versions are one drawing (MascotArt), so they show the
 *   same state and the switch is a morph.
 * - It faces the middle of the window: the beak points right on the left half, left on the right half.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { Icon } from "@thoth/app-ui/ui/Icon.tsx";
import { tip } from "@thoth/app-ui/ui/Tooltip.tsx";
import { useShortcutHint } from "@thoth/app-ui/keyboard/hints.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { describeNotification, notificationTarget, type NotificationEntry } from "@thoth/app-ui/notifications/core.ts";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import type { AgentsService } from "../agents/service.ts";
import type { AssistantController } from "./controller.ts";
import { COMPACT_BOX, MascotArt, STAGE, type MascotState, type MascotVersion } from "./MascotArt.tsx";
import { Bubble, editorSelection } from "./Bubble.tsx";
import { useEditorTyping, useMascotState, useReducedMotion, useWindowSize, waitingReviews } from "./hooks.ts";
import {
  DEFAULT_POSITION,
  DRAG_THRESHOLD,
  KEY_STEP,
  KEY_STEP_LARGE,
  NARROW_WIDTH,
  TOP_INSET,
  boxSize,
  clampPoint,
  defaultInsets,
  facingFor,
  pointFor,
  positionFor,
  snapPoint,
  type Point,
} from "./placement.ts";
import "./mascot.css";
import "../notifications/notifications.css";

/** After the arrow keys stop for this long, a snapping mascot settles on its edge. */
export const KEY_SNAP_MS = 600;
/** How long the settle after a drop animates (the slow motion token). */
const SETTLE_MS = 300;

/** The bottom of the tab strip, so the mascot stays below it. */
function topInset(): number {
  const strip = document.querySelector(".tabstrip");
  const bottom = strip?.getBoundingClientRect().bottom ?? 0;
  return Math.max(TOP_INSET, Math.round(bottom) + 8);
}

interface Drag {
  pointer: number;
  startX: number;
  startY: number;
  origin: Point;
  moved: boolean;
}

function Layer({ agents, assistant }: { agents: AgentsService; assistant: AssistantController }) {
  const { tabs, openAgentReview, notifications, openNotification, options } = useSession();
  const t = useDesktopStrings().mascot;
  const notificationText = useStrings().notifications;
  const prefs = useSyncExternalStore(assistant.prefs.subscribe, assistant.prefs.get);
  const view = useSyncExternalStore(assistant.subscribe, assistant.get);
  const agentState = useSyncExternalStore(agents.subscribe, agents.getState);
  const state = useMascotState(agents, view.bubble);
  const reduced = useReducedMotion();
  const win = useWindowSize();
  const typing = useEditorTyping(prefs.size === "auto");
  const button = useRef<HTMLButtonElement>(null);
  const [drag, setDrag] = useState<{ point: Point } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [settling, setSettling] = useState(false);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [inset, setInset] = useState(TOP_INSET);
  useLayoutEffect(() => setInset(topInset()), [win.width, win.height, tabs.state]);

  const auto = win.width < NARROW_WIDTH || typing;
  const version: MascotVersion = prefs.size === "auto" ? (auto && !view.bubble ? "compact" : "full") : prefs.size;
  const motion = reduced ? "off" : prefs.motion;
  const box = boxSize(version, prefs.scale);
  const stage = Math.round(STAGE * (prefs.scale / 100));
  const insets = defaultInsets(inset);
  const position = prefs.position ?? DEFAULT_POSITION;
  const rest = pointFor(position, box, win, insets);
  const point = drag?.point ?? rest;
  const facing = facingFor(position);
  const review = state === "review";

  // The state, said politely when it changes (not when the person opened the bubble: they know).
  const [announced, setAnnounced] = useState("");
  const lastState = useRef<MascotState>(state);
  useEffect(() => {
    if (lastState.current === state) return;
    lastState.current = state;
    if (state !== "listening") setAnnounced(t.announce[state]);
  }, [state, t]);

  // A short message after a run ended by itself (ADR-0018). The state and its announcement say it to everyone; this
  // is the line to see and click. It takes no focus, waits while the pointer or focus is on it, then goes.
  const [message, setMessage] = useState<NotificationEntry | null>(null);
  const [held, setHeld] = useState(false);
  const seen = useRef(notifications.getState().latest?.seq ?? 0);
  useEffect(
    () =>
      notifications.subscribe(() => {
        const { latest, entries } = notifications.getState();
        if (!latest || latest.seq === seen.current) return;
        seen.current = latest.seq;
        const entry = entries.find((e) => e.id === latest.id);
        if (entry && entry.event.kind.startsWith("agent") && !assistant.get().bubble) {
          setHeld(false);
          setMessage(entry);
        }
      }),
    [notifications, assistant],
  );
  useEffect(() => {
    if (!message || held) return;
    const timer = setTimeout(() => setMessage(null), options.messageMs);
    return () => clearTimeout(timer);
  }, [message, held, options.messageMs]);
  // The bubble says the same and more.
  useEffect(() => {
    if (view.bubble) setMessage(null);
  }, [view.bubble]);
  const openMessage = (entry: NotificationEntry) => {
    notifications.markRead(entry.id);
    setMessage(null);
    openNotification(notificationTarget(entry.event));
  };

  // The text selected in the editor when the mascot was pressed (a press can collapse it before the click).
  const pressedSelection = useRef<{ text: string | null; at: number } | null>(null);
  const [excerpt, setExcerpt] = useState<string | null>(null);
  const activate = useCallback(() => {
    const s = agents.getState();
    if (s.phase === "review" || s.phase === "applying") {
      assistant.closeBubble();
      openAgentReview();
      return;
    }
    const waiting = s.phase === "idle" ? waitingReviews(s) : [];
    if (waiting.length > 0) {
      assistant.closeBubble();
      void agents.reopenReview(waiting[0]!).then(() => {
        if (agents.getState().phase === "review") openAgentReview();
        else assistant.openBubble(); // it could not be opened again: the bubble says so, next to the mascot that was clicked
      });
      return;
    }
    if (assistant.get().bubble) return assistant.closeBubble();
    const pressed = pressedSelection.current;
    setExcerpt(pressed && Date.now() - pressed.at < 2000 ? pressed.text : editorSelection());
    pressedSelection.current = null;
    assistant.openBubble();
  }, [agents, assistant, openAgentReview]);

  const shownRef = useRef(version);
  shownRef.current = version;
  useEffect(() => assistant.register({ activate, shown: () => shownRef.current }), [assistant, activate]);

  const save = (next: Point, snap: boolean) => {
    const placed = snap && prefs.snap ? snapPoint(next, box, win, insets) : clampPoint(next, box, win, insets);
    assistant.prefs.update({ position: positionFor(placed, box, win) });
    return placed;
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    pressedSelection.current = { text: editorSelection(), at: Date.now() };
    dragRef.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, origin: rest, moved: false };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // a synthetic pointer (tests) cannot be captured; the drag still works
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointer !== event.pointerId) return;
    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!d.moved) assistant.closeBubble();
    d.moved = true;
    setSettling(false);
    setDrag({ point: clampPoint({ left: d.origin.left + dx, top: d.origin.top + dy }, box, win, insets) });
  };
  const endDrag = (event: PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const d = dragRef.current;
    if (!d || d.pointer !== event.pointerId) return;
    dragRef.current = null;
    if (!d.moved) return;
    suppressClick.current = true;
    const dropped = cancelled ? d.origin : clampPoint({ left: d.origin.left + event.clientX - d.startX, top: d.origin.top + event.clientY - d.startY }, box, win, insets);
    save(dropped, !cancelled);
    setDrag(null);
    // The settle to the snapped edge animates from where it was let go (a transition on the layer's transform).
    setSettling(true);
    // One settle at a time: a second drop restarts it rather than being cut short by the first one's timer.
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => setSettling(false), SETTLE_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key] as [number, number] | undefined;
    if (!delta || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const stepBy = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    // Keyboard moves never animate; snapping waits until the keys stop, so small steps along an edge still work.
    setSettling(false);
    const placed = save({ left: rest.left + delta[0] * stepBy, top: rest.top + delta[1] * stepBy }, false);
    clearTimeout(keyTimer.current);
    if (prefs.snap) keyTimer.current = setTimeout(() => save(placed, true), KEY_SNAP_MS);
  };
  useEffect(
    () => () => {
      clearTimeout(keyTimer.current);
      clearTimeout(settleTimer.current);
    },
    [],
  );

  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    activate();
  };

  // The stage is the full drawing's box; in the compact version it hangs off the button so the badge sits in the
  // button's box, in the corner the mascot is docked in.
  const spare = stage - Math.round(COMPACT_BOX * (prefs.scale / 100));
  const stageLeft = version === "compact" && facing === "left" ? -spare : 0;
  const stageTop = version === "compact" && position.v === "bottom" ? -spare : 0;
  const askKeys = useShortcutHint("assistant.ask");
  const sizeKeys = useShortcutHint("assistant.size");
  const name = `${t.name}, ${t.states[state]}`;
  const sizeLabel = version === "full" ? t.shrink : t.expand;

  return (
    <>
      <div
        className="mascot-layer"
        data-version={version}
        data-h={position.h}
        data-v={position.v}
        data-dragging={drag ? "" : undefined}
        data-settling={settling && motion !== "off" ? "" : undefined}
        data-motion={motion}
        data-testid="mascot"
        data-state={state}
        style={{ transform: `translate3d(${point.left}px, ${point.top}px, 0)`, width: box, height: box }}
      >
        <button
          ref={button}
          type="button"
          className="mascot"
          aria-label={name}
          aria-haspopup={review ? undefined : "dialog"}
          aria-expanded={review ? undefined : view.bubble}
          aria-controls={view.bubble ? "mascot-bubble" : undefined}
          {...(askKeys ? { "aria-keyshortcuts": askKeys.aria } : {})}
          {...tip(t.name, askKeys?.keys, review ? t.reviewHint : t.hint)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, false)}
          onPointerCancel={(e) => endDrag(e, true)}
          onKeyDown={onKeyDown}
          onClick={onClick}
        >
          <span className="mascot-stage" style={{ width: stage, height: stage, left: stageLeft, top: stageTop }}>
            <MascotArt state={state} version={version} facing={facing} vertical={position.v} motion={motion} />
          </span>
        </button>
        <button
          type="button"
          className="icon-btn mascot-size"
          aria-label={sizeLabel}
          {...(sizeKeys ? { "aria-keyshortcuts": sizeKeys.aria } : {})}
          {...tip(sizeLabel, sizeKeys?.keys)}
          onClick={() => assistant.toggleSize()}
        >
          <Icon name={version === "full" ? "shrink" : "expand"} size={14} />
        </button>
        <span className="sr-only" aria-live="polite" data-testid="mascot-live">
          {announced}
        </span>
      </div>
      {message && !view.bubble && (
        <div
          className="mascot-message"
          data-testid="mascot-message"
          data-kind={message.event.kind}
          data-side={position.v === "bottom" ? "above" : "below"}
          data-motion={motion}
          style={{
            ...(position.v === "bottom" ? { bottom: Math.max(8, win.height - point.top + 8) } : { top: point.top + box + 8 }),
            ...(position.h === "right" ? { right: Math.max(8, win.width - (point.left + box)) } : { left: Math.max(8, point.left) }),
          }}
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
        >
          <button type="button" className="mascot-message-btn" onClick={() => openMessage(message)}>
            {describeNotification(message.event, notificationText).title}
          </button>
        </div>
      )}
      {view.bubble && (
        <Bubble
          agents={agents}
          state={agentState}
          anchor={{ left: point.left, top: point.top, size: box, h: position.h, v: position.v }}
          view={win}
          insets={insets}
          focusNonce={view.focusNonce}
          onClose={(refocus) => {
            assistant.closeBubble();
            if (refocus) button.current?.focus();
          }}
          mascot={button}
          excerpt={excerpt}
          motion={motion}
        />
      )}
    </>
  );
}

/** Mount once in the shell. Nothing on the web, nothing where agents cannot run, nothing when switched off. */
export function MascotLayer() {
  const { agents, assistant } = useSession();
  const prefs = useSyncExternalStore(assistant?.prefs.subscribe ?? (() => () => undefined), () => assistant?.prefs.get() ?? null);
  if (!agents || !assistant || !prefs?.show) return null;
  return <Layer agents={agents} assistant={assistant} />;
}
