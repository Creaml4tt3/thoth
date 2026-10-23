import { useEffect, useId, useRef, type ReactNode } from "react";
import { useStrings } from "../strings/index.ts";

interface ModalProps {
  title: string;
  /** Omit to make the dialog impossible to dismiss without choosing an action. */
  onClose?: () => void;
  theme?: "night" | "paper";
  wide?: boolean;
  children: ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal: labelled, focus moves in and is restored, Tab is trapped. When it may be dismissed it
 * has a visible Close button, and Escape or a click on the backdrop closes it too.
 */
export function Modal({ title, onClose, theme = "paper", wide, children }: ModalProps) {
  const titleId = useId();
  const t = useStrings().modal;
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

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
      className="modal-scrim"
      data-theme={theme === "night" ? "night" : undefined}
      // Only a press that starts on the backdrop itself closes: a text selection dragged out of the dialog does not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close.current?.();
      }}
    >
      <div ref={box} className={`modal${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="modal-head">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          {onClose && (
            <button type="button" className="modal-close" aria-label={t.close} title={t.closeTitle} onClick={() => close.current?.()}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
