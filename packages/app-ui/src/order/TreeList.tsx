import { useRef, type ReactNode } from "react";
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
  return (
    <ul ref={ref} role="tree" aria-label={label} aria-multiselectable={multiselectable || undefined}>
      {children}
    </ul>
  );
}
