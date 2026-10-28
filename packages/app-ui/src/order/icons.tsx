/** Small row icons for the page trees. Decorative: the row's text and `aria-expanded` carry the meaning. */

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** The disclosure arrow; it turns down when the row is open. */
export function Disclosure({ open, hidden, onToggle }: { open: boolean; hidden?: boolean; onToggle?: () => void }) {
  return (
    <span
      className="tree-caret"
      data-open={open || undefined}
      data-empty={hidden || undefined}
      aria-hidden="true"
      {...(onToggle
        ? {
            onClick: (event: { stopPropagation(): void }) => {
              event.stopPropagation(); // the arrow opens and closes; the row's click opens the page
              onToggle();
            },
          }
        : {})}
    >
      {!hidden && (
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M3 2l3.2 3L3 8" {...STROKE} />
        </svg>
      )}
    </span>
  );
}

/** A folder: closed, or open with its lid tilted. Both shapes are drawn and cross-fade (`.tree-icon-folder` in shell.css). */
export function FolderIcon({ open, color }: { open: boolean; color?: string | null | undefined }) {
  return (
    <span className="tree-icon tree-icon-folder" data-open={open || undefined} data-color={color ?? undefined} aria-hidden="true">
      <svg className="folder-closed" width="16" height="16" viewBox="0 0 16 16">
        <path d="M2 4.2a1 1 0 0 1 1-1h3l1.4 1.6H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" {...STROKE} />
      </svg>
      <svg className="folder-open" width="16" height="16" viewBox="0 0 16 16">
        <path d="M2 5.2V4a1 1 0 0 1 1-1h3l1.4 1.6H12a1 1 0 0 1 1 1V6" {...STROKE} />
        <path d="M1.6 12.6l1.5-5a1 1 0 0 1 1-.7h9.3a.9.9 0 0 1 .9 1.2l-1.4 4.6a1 1 0 0 1-1 .7H2.5a.9.9 0 0 1-.9-.8z" {...STROKE} />
      </svg>
    </span>
  );
}

export function PageIcon() {
  return (
    <span className="tree-icon tree-icon-page" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16">
        <path d="M4 2.5h5l3 3V13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13z" {...STROKE} />
        <path d="M9 2.5v3h3" {...STROKE} />
      </svg>
    </span>
  );
}
