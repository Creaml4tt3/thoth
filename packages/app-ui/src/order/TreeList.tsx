import { useEffect, useRef, useState, type ReactNode } from "react";
import { TreeMotionContext } from "./TreeGroup.tsx";
import { useRovingTabStop } from "./tree-keys.ts";

interface Props {
  label: string;
  multiselectable?: boolean | undefined;
  children: ReactNode;
}

/** A `role="tree"` list with a single Tab stop. Rows are `[role="treeitem"]` elements with a `data-tree-id` (see `tree-keys.ts`). */
export function TreeList({ label, multiselectable, children }: Props) {
  const ref = useRef<HTMLUListElement>(null);
  useRovingTabStop(ref);
  // Folders animate once the person has used the tree; until then they open without motion (TreeGroup.tsx).
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    const list = ref.current;
    if (!list || touched) return;
    const touch = () => setTouched(true);
    list.addEventListener("pointerdown", touch, { capture: true, once: true });
    list.addEventListener("keydown", touch, { capture: true, once: true });
    return () => {
      list.removeEventListener("pointerdown", touch, { capture: true });
      list.removeEventListener("keydown", touch, { capture: true });
    };
  }, [touched]);
  return (
    <TreeMotionContext value={touched}>
      <ul ref={ref} role="tree" aria-label={label} aria-multiselectable={multiselectable || undefined}>
        {children}
      </ul>
    </TreeMotionContext>
  );
}
