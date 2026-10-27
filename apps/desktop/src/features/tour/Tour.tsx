/**
 * The first-run tour (ADR-0032): a few small popovers, each beside a real control, with Back / Next / Skip tour and
 * "3 of 6". Not modal: the app stays usable around it. Focus moves into the popover; Escape skips; the control it
 * points at is described by the popover's text (`aria-describedby`) and ringed. Placed like the tooltip and kept
 * inside the window (`placeBeside`); its motion comes from the motion tokens, so reduced motion has none.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { placeBeside, type Placement } from "@thoth/app-ui/ui/place.ts";
import { shellRoot } from "@thoth/app-ui/order/ContextMenu.tsx";
import { currentPlatform, shortcutText } from "@thoth/app-ui/keyboard/shortcuts.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { TOUR_STEPS, anchorOf, availableSteps, type TourStep } from "./steps.ts";
import { clearTour, markTourSeen, useTourRequest } from "./store.ts";

/** How long the first run waits for the Welcome page's editor before it starts with what is there. */
const WAIT_MS = 3000;

const view = () => ({ width: document.documentElement.clientWidth || window.innerWidth, height: document.documentElement.clientHeight || window.innerHeight });

/** Adds or removes `id` in the element's `aria-describedby`, keeping what was there. */
function describe(el: Element, id: string, add: boolean) {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((x) => x && x !== id);
  if (add) ids.push(id);
  if (ids.length > 0) el.setAttribute("aria-describedby", ids.join(" "));
  else el.removeAttribute("aria-describedby");
}

export function Tour() {
  const request = useTourRequest();
  const t = useDesktopStrings().tour;
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<Placement | null>(null);
  const [said, setSaid] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const before = useRef<Element | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const searchKeys = useMemo(() => shortcutText("palette.open", "desktop", currentPlatform()), []);

  // A new request: wait for what it waits for, then count the steps that are on screen.
  useEffect(() => {
    if (!request) return;
    let live = true;
    const begin = () => {
      if (!live) return;
      const found = availableSteps(TOUR_STEPS);
      if (found.length === 0) return clearTour();
      before.current = document.activeElement;
      setSteps(found);
      setIndex(0);
      setSaid("");
    };
    if (request.waitFor === null) {
      begin();
      return () => void (live = false);
    }
    const waitFor = TOUR_STEPS.find((s) => s.id === request.waitFor)!;
    const until = Date.now() + WAIT_MS;
    const timer = setInterval(() => {
      if (!anchorOf(waitFor) && Date.now() < until) return;
      clearInterval(timer);
      begin();
    }, 50);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [request]);
  // The shell going away (another Private Space) ends the tour without counting it as seen.
  useEffect(() => () => clearTour(), []);

  const step = steps?.[index] ?? null;
  const anchor = step ? anchorOf(step) : null;

  const end = (how: "finished" | "skipped") => {
    markTourSeen(how);
    setSteps(null);
    setPlace(null);
    clearTour();
    const back = before.current;
    before.current = null;
    if (back instanceof HTMLElement && back.isConnected && back !== document.body) back.focus();
  };

  // The control went away (the sidebar hidden, the window narrowed): on to the next step that is on screen.
  useEffect(() => {
    if (!steps || !step || anchor) return;
    const next = steps.findIndex((s, i) => i > index && anchorOf(s) !== null);
    if (next >= 0) setIndex(next);
    else {
      setSteps(null);
      clearTour();
    }
  });

  // The control is described by the step's text, and ringed, while the step shows.
  useEffect(() => {
    if (!anchor) return;
    describe(anchor, bodyId, true);
    anchor.setAttribute("data-tour-anchor", "");
    return () => {
      describe(anchor, bodyId, false);
      anchor.removeAttribute("data-tour-anchor");
    };
  }, [anchor, bodyId]);

  // Beside the control, inside the window; again when the window changes size.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !anchor || !step) return;
    const near = (step.placeAt ? anchor.querySelector(step.placeAt) : null) ?? anchor;
    const measure = () => setPlace(placeBeside(near.getBoundingClientRect(), el.getBoundingClientRect(), view(), step.sides, { gap: 10 }));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor, step]);

  // Focus moves into the popover at every step, once it is placed (a hidden button cannot take focus); a step after
  // the first is also said aloud (`said`).
  const placed = place !== null;
  useEffect(() => {
    if (step && placed) primary.current?.focus();
  }, [step, placed]);

  if (!steps || !step || !anchor) return null;
  const text = t.steps[step.id];
  const title = text.title;
  const body = typeof text.body === "function" ? text.body(searchKeys) : text.body;
  const last = index === steps.length - 1;
  const go = (to: number) => {
    setIndex(to);
    const next = steps[to]!;
    const nextText = t.steps[next.id];
    setSaid(`${t.progress(to + 1, steps.length)}. ${nextText.title}. ${typeof nextText.body === "function" ? nextText.body(searchKeys) : nextText.body}`);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    end("skipped");
  };
  const style: CSSProperties = place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: "hidden" };

  return createPortal(
    <div ref={box} className="tour" role="dialog" aria-labelledby={titleId} aria-describedby={bodyId} data-side={place?.side ?? "bottom"} data-step={step.id} style={style} onKeyDown={onKeyDown}>
      <p className="tour-progress">{t.progress(index + 1, steps.length)}</p>
      <h2 id={titleId} className="tour-title">
        {title}
      </h2>
      <p id={bodyId} className="tour-body">
        {body}
      </p>
      <div className="tour-actions">
        <Button variant="quiet" small onClick={() => end("skipped")}>
          {t.skip}
        </Button>
        <span className="tour-nav">
          {index > 0 && (
            <Button variant="ghost" small onClick={() => go(index - 1)}>
              {t.back}
            </Button>
          )}
          <Button ref={primary} variant="primary" small onClick={() => (last ? end("finished") : go(index + 1))}>
            {last ? t.done : t.next}
          </Button>
        </span>
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {said}
      </div>
    </div>,
    shellRoot(),
  );
}
