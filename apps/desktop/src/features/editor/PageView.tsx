import { useEffect, useMemo, useRef } from "react";
import { Button } from "../../ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { Backlinks } from "./Backlinks.tsx";
import { ConflictDialog } from "./ConflictDialog.tsx";
import { PageEditor, type PageEditorHandle } from "./PageEditor.tsx";
import { createEditorContext } from "./context.ts";
import { EMPTY_LOOKUP, loadLinkLookup, type LinkLookup } from "./links.ts";
import { usePageSession } from "./usePageSession.ts";
import type { SaveStatus } from "./page-session.ts";

const STATUS: Record<SaveStatus, string> = { idle: "", dirty: "Unsaved changes", saving: "Saving…", saved: "Saved", error: "Not saved" };

function Breadcrumbs({ path, status }: { path: string; status: SaveStatus }) {
  const parts = path.split("/");
  return (
    <header className="crumbs">
      <nav aria-label="Breadcrumb" className="crumb-trail">
        <ol>
          <li>
            <span className="badge badge-private">Local</span>
          </li>
          {parts.map((part, i) => (
            <li key={i} {...(i === parts.length - 1 ? { "aria-current": "page" as const, className: "crumb-current" } : {})}>
              {part}
            </li>
          ))}
        </ol>
      </nav>
      <span className="save-status" data-state={status} role="status" aria-live="polite">
        {STATUS[status]}
      </span>
    </header>
  );
}

export function PageView({ path }: { path: string }) {
  const { vault, revision, openPage } = useSession();
  const handle = useRef<PageEditorHandle>(null);
  const lookup = useRef<LinkLookup>(EMPTY_LOOKUP);
  const ctx = useMemo(() => createEditorContext({ lookup: () => lookup.current, openPage: (p) => openPage(p) }), [openPage]);
  const { session, state } = usePageSession(path, handle);

  // Wikilink chips resolve through the index; refresh them when it changes.
  useEffect(() => {
    let live = true;
    loadLinkLookup(vault, path)
      .then((next) => {
        if (!live) return;
        lookup.current = next;
        for (const view of ctx.views) view.refresh();
      })
      .catch(() => undefined); // the vault may have closed while this was in flight
    return () => {
      live = false;
    };
  }, [vault, path, revision, ctx]);

  return (
    <section className="page-view" aria-label={path}>
      <Breadcrumbs path={path} status={state.save} />
      <div className="page-scroll">
        <div className="page-col">
          {state.phase === "missing" && (
            <div className="missing">
              <h1 className="page-title">This page is gone</h1>
              <p className="muted">{path} no longer exists on disk.</p>
            </div>
          )}
          {state.phase === "error" && (
            <p role="alert" className="alert alert-danger">
              {state.error}
            </p>
          )}
          {state.phase === "ready" && (
            <>
              {!state.editable && (
                <p className="alert readonly-note" role="note">
                  This file is not valid UTF-8, so Thoth shows it read-only and will never write to it. Open it in another editor to change it.
                </p>
              )}
              {state.error && !state.conflict && (
                <p role="alert" className="alert alert-danger">
                  {state.error}{" "}
                  {state.save === "error" && (
                    <Button variant="quiet" small onClick={() => void session?.save()}>
                      Retry
                    </Button>
                  )}
                </p>
              )}
              {state.conflictCopy && (
                <p role="status" className="alert alert-warning">
                  Your version was saved as <b>{state.conflictCopy}</b>.{" "}
                  <Button variant="quiet" small onClick={() => openPage(state.conflictCopy!)}>
                    Open it
                  </Button>
                </p>
              )}
            </>
          )}
          <div hidden={state.phase !== "ready"}>
            <PageEditor ctx={ctx} handleRef={handle} onEdit={() => session?.noteEdited()} onSaveShortcut={() => void session?.save()} />
          </div>
          {state.phase === "ready" && <Backlinks path={path} />}
        </div>
      </div>
      {state.conflict && session && <ConflictDialog path={path} conflict={state.conflict} error={state.error} onChoose={(choice) => void session.resolveConflict(choice)} />}
    </section>
  );
}
