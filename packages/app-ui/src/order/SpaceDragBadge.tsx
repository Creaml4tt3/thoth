import { useSpaceHover } from "./space-drag.ts";

/**
 * The words by the pointer while pages are dragged over the other space: "Copy to Studio…", "Move to Private
 * Space…", or why the drop is refused. The browser's drag picture is fixed when the drag starts, so this badge,
 * drawn under it, is what changes. A live region says the same for screen readers.
 */
export function SpaceDragBadge() {
  const hover = useSpaceHover();
  return (
    <>
      {hover && (
        <div className="space-drag-badge" data-refused={hover.to === null || undefined} style={{ left: hover.x + 14, top: hover.y + 22 }} aria-hidden="true">
          {hover.text}
        </div>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {hover?.text ?? ""}
      </div>
    </>
  );
}
