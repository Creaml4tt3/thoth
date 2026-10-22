import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { Backlinks } from "./Backlinks.tsx";
import { ConflictDialog } from "./ConflictDialog.tsx";
import { PageEditor, type PageEditorHandle } from "./PageEditor.tsx";
import { createEditorContext } from "./context.ts";
import { EMPTY_LOOKUP, loadLinkLookup, type LinkLookup } from "./links.ts";
import { EMPTY_SUGGESTER, type LinkSuggester } from "./link-suggest.ts";
import { usePageSession } from "./usePageSession.ts";
import type { SaveStatus } from "./page-session.ts";
import { EDITOR_MODES, pageEditorMode, rememberPageEditorMode, type EditorMode } from "./mode.ts";
import { PlainEditor } from "./plain/PlainEditor.tsx";

const STATUS: Record<SaveStatus, string> = { idle: "", dirty: "Unsaved changes", saving: "Saving…", saved: "Saved", error: "Not saved" };

function ModeSwitch({ mode, disabled, onChange }: { mode: EditorMode; disabled: boolean; onChange(mode: EditorMode): void }) {
  return (
    <div className="mode-switch" role="group" aria-label="Editor mode" title="Switch editor mode (Ctrl/Cmd+Shift+E)">
      {EDITOR_MODES.map((m) => (
        <button key={m.id} type="button" className="mode-option" aria-pressed={mode === m.id} title={m.hint} disabled={disabled} onClick={() => onChange(m.id)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

function Breadcrumbs({ path, status, children }: { path: string; status: SaveStatus; children?: React.ReactNode }) {
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
      <div className="crumb-tools">
        <span className="save-status" data-state={status} role="status" aria-live="polite">
          {STATUS[status]}
        </span>
        {children}
      </div>
    </header>
  );
}

export function PageView({ path }: { path: string }) {
  const { vault, connection, revision, openPage } = useSession();
  const handle = useRef<PageEditorHandle>(null);
  const [mode, setMode] = useState<EditorMode>(() => pageEditorMode(connection.root, path));
  /** The text carried from the editor being replaced into the one being mounted, unsaved edits included. */
  const carried = useRef<string | null>(null);
  const lookup = useRef<LinkLookup>(EMPTY_LOOKUP);
  const suggester = useRef<LinkSuggester>(EMPTY_SUGGESTER);
  // One context per page: `openPage` changes with every index revision, and node views and the Plain editor hold the context.
  const open = useRef(openPage);
  open.current = openPage;
  const ctx = useMemo(() => createEditorContext({ lookup: () => lookup.current, suggester: () => suggester.current, openPage: (p) => open.current(p) }), []);
  const { session, state } = usePageSession(path, handle);

  // Wikilink chips resolve through the index; refresh them when it changes.
  useEffect(() => {
    let live = true;
    loadLinkLookup(vault, path)
      .then((next) => {
        if (!live) return;
        lookup.current = next.lookup;
        suggester.current = next.suggester;
        for (const view of ctx.views) view.refresh();
      })
      .catch(() => undefined); // the vault may have closed while this was in flight
    return () => {
      live = false;
    };
  }, [vault, path, revision, ctx]);

  const canSwitch = state.phase === "ready" && !state.conflict;
  const switchMode = useCallback(
    (next: EditorMode) => {
      if (next === mode || !canSwitch) return;
      carried.current = handle.current?.markdown() ?? null;
      rememberPageEditorMode(connection.root, path, next);
      setMode(next);
    },
    [mode, canSwitch, connection.root, path],
  );

  // The new editor starts with the old one's text, so switching never saves and never drops an edit.
  useLayoutEffect(() => {
    const text = carried.current;
    carried.current = null;
    if (text === null || !handle.current) return;
    handle.current.load(text);
    handle.current.setEditable(state.editable && !state.conflict);
    handle.current.focus();
    // Only a mode change carries text; `state` is read at that moment.
  }, [mode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        switchMode(mode === "blocks" ? "plain" : "blocks");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, switchMode]);

  const editorProps = { ctx, handleRef: handle, onEdit: () => session?.noteEdited(), onSaveShortcut: () => void session?.save() };

  return (
    <section className="page-view" aria-label={path}>
      <Breadcrumbs path={path} status={state.save}>
        <ModeSwitch mode={mode} disabled={!canSwitch} onChange={switchMode} />
      </Breadcrumbs>
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
          <div hidden={state.phase !== "ready"} data-editor-mode={mode}>
            {mode === "blocks" ? <PageEditor key="blocks" {...editorProps} /> : <PlainEditor key="plain" {...editorProps} />}
          </div>
          {state.phase === "ready" && <Backlinks path={path} />}
        </div>
      </div>
      {state.conflict && session && <ConflictDialog path={path} conflict={state.conflict} error={state.error} onChoose={(choice) => void session.resolveConflict(choice)} />}
    </section>
  );
}
