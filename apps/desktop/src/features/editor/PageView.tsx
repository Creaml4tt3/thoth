import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { Backlinks } from "./Backlinks.tsx";
import { ConflictDialog } from "./ConflictDialog.tsx";
import { PageEditor, type PageEditorHandle } from "./PageEditor.tsx";
import { createEditorContext } from "./context.ts";
import { EMPTY_LOOKUP, loadLinkLookup, type LinkLookup } from "./links.ts";
import { EMPTY_SUGGESTER, type LinkSuggester } from "./link-suggest.ts";
import { usePageSession } from "./usePageSession.ts";
import { vaultPageStore, type PageStore, type SaveStatus } from "./page-session.ts";
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

function Breadcrumbs({ badge, parts, status, children }: { badge: ReactNode; parts: string[]; status: SaveStatus; children?: ReactNode }) {
  return (
    <header className="crumbs">
      <nav aria-label="Breadcrumb" className="crumb-trail">
        <ol>
          <li>{badge}</li>
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

export interface PageFrameProps {
  /** Accessible name of the page region. */
  label: string;
  store: PageStore;
  /** Remembers the editor mode per page: `{ space, page }`. */
  modeKey: { space: string; page: string };
  crumbs: { badge: ReactNode; parts: string[] };
  /** Changes whenever the stored page may have changed (index revision, change feed). */
  checkTick: number;
  onWritten(): void;
  /** Wikilink resolution; null leaves every link unresolved. */
  loadLinks: (() => Promise<{ lookup: LinkLookup; suggester: LinkSuggester }>) | null;
  linkTick: number;
  /** Wikilinks open through here. */
  openLink(path: string): void;
  /** Opens the copy that Keep both made. */
  openCopy(ref: string): void;
  readOnlyNote: string;
  missing: { title: string; detail: string };
  /** Shown under a save error (for example a Sign in button). */
  errorAction?: ReactNode;
  footer?: ReactNode;
}

/** One open page: breadcrumbs, the Blocks or Plain editor, save status and the conflict dialog. Where the page lives is the store's business. */
export function PageFrame(props: PageFrameProps) {
  const { store, modeKey, loadLinks } = props;
  const handle = useRef<PageEditorHandle>(null);
  const [mode, setMode] = useState<EditorMode>(() => pageEditorMode(modeKey.space, modeKey.page));
  /** The text carried from the editor being replaced into the one being mounted, unsaved edits included. */
  const carried = useRef<string | null>(null);
  const lookup = useRef<LinkLookup>(EMPTY_LOOKUP);
  const suggester = useRef<LinkSuggester>(EMPTY_SUGGESTER);
  // One context per page: the link opener changes with every index revision, and node views and the Plain editor hold the context.
  const open = useRef(props.openLink);
  open.current = props.openLink;
  const ctx = useMemo(() => createEditorContext({ lookup: () => lookup.current, suggester: () => suggester.current, openPage: (p) => open.current(p) }), []);
  const { session, state } = usePageSession(store, handle, { checkTick: props.checkTick, onWritten: props.onWritten });

  // Wikilink chips resolve through the index; refresh them when it changes.
  useEffect(() => {
    if (!loadLinks) return;
    let live = true;
    loadLinks()
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
  }, [loadLinks, props.linkTick, ctx]);

  const canSwitch = state.phase === "ready" && !state.conflict;
  const switchMode = useCallback(
    (next: EditorMode) => {
      if (next === mode || !canSwitch) return;
      carried.current = handle.current?.markdown() ?? null;
      rememberPageEditorMode(modeKey.space, modeKey.page, next);
      setMode(next);
    },
    [mode, canSwitch, modeKey.space, modeKey.page],
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
    <section className="page-view" aria-label={props.label}>
      <Breadcrumbs badge={props.crumbs.badge} parts={props.crumbs.parts} status={state.save}>
        <ModeSwitch mode={mode} disabled={!canSwitch} onChange={switchMode} />
      </Breadcrumbs>
      <div className="page-scroll">
        <div className="page-col">
          {state.phase === "missing" && (
            <div className="missing">
              <h1 className="page-title">{props.missing.title}</h1>
              <p className="muted">{props.missing.detail}</p>
            </div>
          )}
          {state.phase === "error" && (
            <p role="alert" className="alert alert-danger">
              {state.error} {props.errorAction}
            </p>
          )}
          {state.phase === "ready" && (
            <>
              {!state.editable && (
                <p className="alert readonly-note" role="note">
                  {props.readOnlyNote}
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
                  {props.errorAction}
                </p>
              )}
              {state.conflictCopy && (
                <p role="status" className="alert alert-warning">
                  Your version was saved as <b>{state.conflictCopy.label}</b>.{" "}
                  <Button variant="quiet" small onClick={() => props.openCopy(state.conflictCopy!.ref)}>
                    Open it
                  </Button>
                </p>
              )}
            </>
          )}
          <div hidden={state.phase !== "ready"} data-editor-mode={mode}>
            {mode === "blocks" ? <PageEditor key="blocks" {...editorProps} /> : <PlainEditor key="plain" {...editorProps} />}
          </div>
          {state.phase === "ready" && props.footer}
        </div>
      </div>
      {state.conflict && session && (
        <ConflictDialog name={props.label} where={store.kind === "workspace" ? "server" : "disk"} conflict={state.conflict} error={state.error} onChoose={(choice) => void session.resolveConflict(choice)} />
      )}
    </section>
  );
}

/** A page of the Private Space: a Markdown file in the vault. */
export function PageView({ path }: { path: string }) {
  const { vault, connection, revision, openPage, refresh } = useSession();
  const store = useMemo(() => vaultPageStore(vault, path), [vault, path]);
  const loadLinks = useCallback(() => loadLinkLookup(vault, path), [vault, path]);
  const onWritten = useCallback(() => void refresh().catch(() => undefined), [refresh]);
  return (
    <PageFrame
      label={path}
      store={store}
      modeKey={{ space: connection.root, page: path }}
      crumbs={{ badge: <span className="badge badge-private">Local</span>, parts: path.split("/") }}
      checkTick={revision}
      onWritten={onWritten}
      loadLinks={loadLinks}
      linkTick={revision}
      openLink={openPage}
      openCopy={openPage}
      readOnlyNote="This file is not valid UTF-8, so Thoth shows it read-only and will never write to it. Open it in another editor to change it."
      missing={{ title: "This page is gone", detail: `${path} no longer exists on disk.` }}
      footer={<Backlinks path={path} />}
    />
  );
}
