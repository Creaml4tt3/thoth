import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { shellRoot } from "../order/ContextMenu.tsx";
import { Icon } from "./Icon.tsx";
import { searchable } from "./SettingsLayout.tsx";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string> {
  value: V;
  onChange(value: V): void;
  options: readonly SelectOption<V>[];
  id?: string;
  name?: string;
  disabled?: boolean | undefined;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "data-testid"?: string;
  /** The Modal focuses the element marked `data-autofocus` first. */
  "data-autofocus"?: boolean;
}

const MARGIN = 8;
const GAP = 4;
/** How long typed letters keep adding to one search. */
const TYPE_AHEAD_MS = 500;

/**
 * Thoth's dropdown, in place of the system's select element: the WAI-ARIA select-only combobox. A button shows the chosen
 * label; it opens a listbox on the raised surface, below the button or above it when there is no room, kept inside the
 * window. Focus stays on the button the whole time (`aria-activedescendant` names the active option). Enter, Space and
 * Alt+Down open; Up, Down, Home and End move; typed letters jump to the option that starts with them (Thai too); Enter
 * or a click chooses; Tab chooses and moves on; Escape closes without changing and goes no further (a dialog around it
 * stays open); a click elsewhere closes. Inside a dialog the list is put in the dialog, so it stays in its theme and in
 * what a screen reader reads of a modal dialog.
 */
export function Select<V extends string>({ value, onChange, options, id, name, disabled, className, ...aria }: SelectProps<V>) {
  const listId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number; minWidth: number; maxHeight: number | undefined; side: "top" | "bottom" } | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const chosen = options.findIndex((o) => o.value === value);
  const enabled = (i: number) => options[i] !== undefined && !options[i]!.disabled;
  const optionId = (i: number) => `${listId}-${i}`;

  const show = (at: number) => {
    setActive(at);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setPlace(null);
  };
  const choose = (i: number) => {
    close();
    if (enabled(i) && options[i]!.value !== value) onChange(options[i]!.value);
  };
  /** The nearest enabled option from `from` in direction `step`, or `from` itself when there is none. */
  const step = (from: number, by: 1 | -1): number => {
    for (let i = from + by; i >= 0 && i < options.length; i += by) if (enabled(i)) return i;
    return from;
  };
  const first = () => (enabled(0) ? 0 : step(0, 1));
  const last = () => (enabled(options.length - 1) ? options.length - 1 : step(options.length - 1, -1));
  const start = () => (enabled(chosen) ? chosen : first());

  /** Adds `key` to the search and returns the option it finds, or null. One letter typed again cycles through the options with it. */
  const search = (key: string, from: number): number | null => {
    const now = Date.now();
    const previous = now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : "";
    typed.current = { text: previous + key, at: now };
    const text = typed.current.text;
    const repeat = [...text].every((c) => c === text[0]);
    const needle = searchable(repeat ? text[0]! : text);
    const begin = repeat || previous === "" ? from + 1 : from;
    for (let k = 0; k < options.length; k++) {
      const i = (begin + k) % options.length;
      if (enabled(i) && searchable(options[i]!.label).startsWith(needle)) return i;
    }
    return null;
  };
  const searching = () => typed.current.text !== "" && Date.now() - typed.current.at < TYPE_AHEAD_MS;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const key = event.key;
    const letter = key.length === 1 && key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (!open) {
      if (key === "Enter" || key === " " || key === "ArrowDown" || key === "ArrowUp") show(start());
      else if (key === "Home") show(first());
      else if (key === "End") show(last());
      else if (letter) {
        const hit = search(key, start());
        show(hit ?? start());
      } else return;
      event.preventDefault();
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (key === "Tab") choose(active); // not prevented: focus moves on
    else if (key === "Enter" || (key === "ArrowUp" && event.altKey)) {
      event.preventDefault();
      choose(active);
    } else if (key === " ") {
      event.preventDefault();
      if (searching()) {
        const hit = search(key, active);
        if (hit !== null) setActive(hit);
      } else choose(active);
    } else if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End" || key === "PageDown" || key === "PageUp") {
      event.preventDefault();
      const to = { ArrowDown: step(active, 1), ArrowUp: step(active, -1), Home: first(), End: last(), PageDown: Math.min(last(), step(Math.min(active + 9, options.length), -1)), PageUp: Math.max(first(), step(Math.max(active - 9, -1), 1)) }[key];
      setActive(to);
    } else if (letter) {
      event.preventDefault();
      const hit = search(key, active);
      if (hit !== null) setActive(hit);
    }
  };

  // Before paint: below the button when it fits, otherwise on the side with more room, and never past the window. Then
  // it follows the button each frame while open: the dialog around it can still be animating in or move (the bubble
  // moves when its content grows), and a list left where the button was would be clicked in the wrong place.
  useLayoutEffect(() => {
    if (!open) return;
    let natural = 0;
    let frame = 0;
    const measure = () => {
      if (!button.current || !list.current) return;
      const anchor = button.current.getBoundingClientRect();
      natural ||= list.current.getBoundingClientRect().height; // measured once, before a max-height can cap it
      const viewW = document.documentElement.clientWidth || window.innerWidth;
      const viewH = document.documentElement.clientHeight || window.innerHeight;
      const below = viewH - MARGIN - anchor.bottom - GAP;
      const above = anchor.top - GAP - MARGIN;
      const side = natural <= below || below >= above ? "bottom" : "top";
      const room = Math.max(0, side === "bottom" ? below : above);
      const shown = Math.min(natural, room);
      const width = Math.max(anchor.width, list.current.getBoundingClientRect().width);
      const next = {
        side,
        top: Math.round(side === "bottom" ? anchor.bottom + GAP : anchor.top - GAP - shown),
        left: Math.round(Math.max(MARGIN, Math.min(anchor.left, viewW - MARGIN - width))),
        minWidth: anchor.width,
        maxHeight: natural > room ? room : undefined,
      } as const;
      setPlace((prev) => (prev && prev.top === next.top && prev.left === next.left && prev.side === next.side && prev.minWidth === next.minWidth && prev.maxHeight === next.maxHeight ? prev : next));
    };
    measure();
    const follow = () => {
      measure();
      frame = requestAnimationFrame(follow);
    };
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame?.(frame);
  }, [open]);

  useEffect(() => {
    // Scrolls the list only: scrollIntoView would also move clipped ancestors of the shell (the WebKit trap).
    const box = list.current;
    const row = open ? document.getElementById(optionId(active)) : null;
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [open, active]);

  // A press elsewhere closes it. A scroll or a resize does not: the list follows its button (above).
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || button.current?.contains(target) || list.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const style: CSSProperties = place
    ? { top: place.top, left: place.left, minWidth: place.minWidth, maxHeight: place.maxHeight }
    : { top: 0, left: 0, visibility: "hidden" }; // measured, then placed before paint
  const host = button.current?.closest<HTMLElement>('[role="dialog"]') ?? shellRoot();

  return (
    <>
      <button
        ref={button}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && options[active] ? optionId(active) : undefined}
        {...aria}
        disabled={disabled}
        className={`input select${className ? ` ${className}` : ""}`}
        data-value={value}
        // What the search in Settings finds: every choice, not only the shown one.
        data-search={options.map((o) => o.label).join(" ")}
        onClick={() => (open ? close() : show(start()))}
        onKeyDown={onKeyDown}
        // A button clicks itself on the keyup of Space; that would close what the keydown opened.
        onKeyUp={(event) => event.key === " " && event.preventDefault()}
      >
        <span className="select-value">{options[chosen]?.label ?? ""}</span>
        <svg className="select-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {name !== undefined && <input type="hidden" name={name} value={value} />}
      {open &&
        createPortal(
          <div ref={list} id={listId} role="listbox" aria-labelledby={aria["aria-labelledby"]} aria-label={aria["aria-label"]} className="select-list" data-side={place?.side} style={style}>
            {options.map((o, i) => (
              <div
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={i === chosen}
                aria-disabled={o.disabled || undefined}
                aria-labelledby={`${optionId(i)}-l`}
                aria-describedby={o.description ? `${optionId(i)}-d` : undefined}
                className="select-option"
                data-active={i === active || undefined}
                // Keeps focus on the button: a press on an option must not move it.
                onMouseDown={(event) => event.preventDefault()}
                onPointerMove={() => enabled(i) && i !== active && setActive(i)}
                onClick={() => enabled(i) && choose(i)}
              >
                <span className="select-check">{i === chosen && <Icon name="done" size={14} />}</span>
                <span className="select-text">
                  <span id={`${optionId(i)}-l`}>{o.label}</span>
                  {o.description && (
                    <span id={`${optionId(i)}-d`} className="select-desc">
                      {o.description}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>,
          host,
        )}
    </>
  );
}
