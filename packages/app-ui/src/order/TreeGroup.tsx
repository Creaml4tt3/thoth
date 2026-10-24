import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { usePresence } from "../ui/presence.ts";

/**
 * Whether folders may animate yet. A `TreeList` turns it on at the first pointer press or key press inside the tree, so the
 * folders that open by themselves while the tree first appears (the open page's parents, a restored session) just appear.
 * Outside a `TreeList` there is nothing to wait for.
 */
export const TreeMotionContext = createContext(true);

/** A folder with more rows than this opens and closes at once: animating a long list would make every frame lay out the sidebar. */
export const TREE_MOTION_MAX = 48;

/** The row that owns a group: the tree item in the same list item. */
function ownerOf(group: HTMLElement): HTMLElement | null {
  return group.closest("li")?.querySelector<HTMLElement>(':scope > [role="treeitem"], :scope > .tree-row > [role="treeitem"]') ?? null;
}

interface Props {
  open: boolean;
  /** How many rows the group holds directly; a long group does not animate. */
  count: number;
  label?: string | undefined;
  children: ReactNode;
}

/**
 * The children of an open folder, as a `role="group"` list. It opens and closes with a short height change
 * (`grid-template-rows` 0fr to 1fr, see `.tree-collapse` in shell.css) and is not animated on the first render.
 * While it closes the list is `inert`, so no row in it can be focused, clicked or read; if focus was inside, it moves
 * to the folder's own row first, so the keyboard is never left on something that is leaving.
 */
export function TreeGroup({ open, count, label, children }: Props) {
  const touched = useContext(TreeMotionContext);
  const { present, state, ref } = usePresence<HTMLDivElement>(open, touched && count <= TREE_MOTION_MAX);
  const was = useRef(open);
  useLayoutEffect(() => {
    const group = ref.current;
    if (was.current && !open && group && document.activeElement && group.contains(document.activeElement)) ownerOf(group)?.focus({ preventScroll: true });
    was.current = open;
  }, [open, ref]);
  if (!present) return null;
  return (
    <div ref={ref} className="tree-collapse" data-state={state}>
      <ul role="group" aria-label={label} inert={state === "closed" ? true : undefined} aria-hidden={state === "closed" ? true : undefined}>
        {children}
      </ul>
    </div>
  );
}
