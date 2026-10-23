import type { ReactNode } from "react";

/** A full-pane message where a page would be (removed, signed out, loading). */
export function Notice({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="page-scroll">
      <div className="page-col">
        <div className="missing">
          <h1 className="page-title">{title}</h1>
          {detail && <p className="muted">{detail}</p>}
          {children && <div className="set-actions">{children}</div>}
        </div>
      </div>
    </div>
  );
}
