import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { useStrings } from "../strings/index.ts";
import { IconButton } from "./IconButton.tsx";
import { leaveAsGhost } from "./presence.ts";

interface ModalProps {
  title: string;
  /** Omit to make the dialog impossible to dismiss without choosing an action. */
  onClose?: () => void;
  theme?: "night" | "paper";
  wide?: boolean;
  /** A command palette: placed near the top, no visible title or close button (Esc and a click outside still close it). */
  palette?: boolean;
  children: ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal: labelled, focus moves in and is restored, Tab is trapped. When it may be dismissed it
 * has a visible Close button, and Escape or a click on the backdrop closes it too.
 *
 * Motion (ui.css): the backdrop fades and the dialog rises in; on the way out both leave a step faster. The parent
 * still removes the modal at once, however it was closed: focus is back where it was in that same moment, and the exit
 * plays on an inert copy (`leaveAsGhost`), so a dialog never holds focus or the keyboard while it fades.
 */
export function Modal({ title, onClose, theme = "paper", wide, palette, children }: ModalProps) {
  const titleId = useId();
  const t = useStrings().modal;
  const box = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const node = scrim.current;
    return () => {
      if (node) leaveAsGhost(node, ".modal");
    };
  }, []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? box.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box.current)?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && close.current) {
      event.stopPropagation();
      close.current();
      return;
    }
    if (event.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={scrim}
      className={`modal-scrim${palette ? " modal-scrim-palette" : ""}`}
      data-theme={theme === "night" ? "night" : undefined}
      // Only a press that starts on the backdrop itself closes: a text selection dragged out of the dialog does not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close.current?.();
      }}
    >
      <div ref={box} className={`modal${wide ? " modal-wide" : ""}${palette ? " modal-palette" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className={`modal-head${palette ? " sr-only" : ""}`}>
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          {onClose && !palette && (
            <IconButton icon="close" label={t.close} shortcut="dialog.close" className="modal-close" onClick={() => close.current?.()} />
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
