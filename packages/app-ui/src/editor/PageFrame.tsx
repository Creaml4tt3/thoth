import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { tip, tipIfClipped } from "../ui/Tooltip.tsx";
import { useShortcutHint } from "../keyboard/hints.ts";
import { useStrings } from "../strings/index.ts";
import { ConflictDialog } from "./ConflictDialog.tsx";
import { PageEditor, type PageEditorHandle } from "./PageEditor.tsx";
import { createEditorContext } from "./context.ts";
import { EMPTY_LOOKUP, type LinkLookup } from "./links.ts";
import type { PageMedia } from "./media.ts";
import { EMPTY_SUGGESTER, type LinkSuggester } from "./link-suggest.ts";
import { registerEditorActions } from "../keyboard/editor-actions.ts";
import { usePageSession } from "./usePageSession.ts";
import { usePageHost } from "./host.ts";
import type { PageStore, SaveStatus } from "./page-session.ts";
import { EDITOR_MODES, pageEditorMode, rememberPageEditorMode, type EditorMode } from "./mode.ts";
import { PlainEditor } from "./plain/PlainEditor.tsx";

function ModeSwitch({ mode, disabled, onChange }: { mode: EditorMode; disabled: boolean; onChange(mode: EditorMode): void }) {
  const t = useStrings().editor;
  const hint = useShortcutHint("editor.mode");
  return (
    <div className="mode-switch" role="group" aria-label={t.modeGroup}>
      {EDITOR_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className="icon-btn mode-option"
          aria-label={t.modes[m.id].label}
          aria-pressed={mode === m.id}
          {...(hint ? { "aria-keyshortcuts": hint.aria } : {})}
          {...tip(t.modes[m.id].label, hint?.keys, t.modes[m.id].hint)}
          disabled={disabled}
          onClick={() => onChange(m.id)}
        >
          <Icon name={m.id === "blocks" ? "blocks" : "text"} />
        </button>
      ))}
    </div>
  );
}

function Breadcrumbs({ badge, parts, status, children }: { badge: ReactNode; parts: string[]; status: SaveStatus; children?: ReactNode }) {
  const t = useStrings().editor;
  return (
    <header className="crumbs">
      <nav aria-label={t.breadcrumb} className="crumb-trail">
        <ol>
          <li>{badge}</li>
          {parts.map((part, i) => (
            <li key={i} {...(i === parts.length - 1 ? { "aria-current": "page" as const, className: "crumb-current" } : {})}>
              <span className="crumb-text" {...tipIfClipped(part)}>
                {part}
              </span>
            </li>
          ))}
        </ol>
      </nav>
      <div className="crumb-tools">
        <span className="save-status" data-state={status} role="status" aria-live="polite">
          {t.status[status]}
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
  /** Where the page's images come from and where added ones go (ADR-0028). Absent: images show their placeholder. */
  media?: PageMedia;
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
  /** Extra controls in the breadcrumb bar (the desktop's Copy / Move to Private Space). */
  actions?: ReactNode;
  /** Told when the conflict dialog opens and how it was resolved (the web client's anonymous analytics, and the save-conflict notification of ADR-0018). */
  onConflict?(event: { kind: "shown" } | { kind: "resolved"; choice: "mine" | "theirs" | "both" }): void;
  /** Told after each save that wrote the page (the web client's anonymous analytics). */
  onSaved?(): void;
}

/** One open page: breadcrumbs, the Blocks or Plain editor, save status and the conflict dialog. Where the page lives is the store's business. */
export function PageFrame(props: PageFrameProps) {
  const { store, modeKey, loadLinks } = props;
  const strings = useStrings();
  const t = strings.editor;
  const handle = useRef<PageEditorHandle>(null);
  const [mode, setMode] = useState<EditorMode>(() => pageEditorMode(modeKey.space, modeKey.page));
  /** The text carried from the editor being replaced into the one being mounted, unsaved edits included. */
  const carried = useRef<string | null>(null);
  const lookup = useRef<LinkLookup>(EMPTY_LOOKUP);
  const suggester = useRef<LinkSuggester>(EMPTY_SUGGESTER);
  // One context per page: the link opener changes with every index revision, and node views and the Plain editor hold the context.
  const open = useRef(props.openLink);
  open.current = props.openLink;
  const pageHost = usePageHost();
  const client = pageHost.client ?? "desktop";
  // Link previews (ADR-0020) know where the page lives: links in a workspace page wait for "Load preview".
  const space = store.kind === "file" ? "private" : "workspace";
  const linkService = pageHost.links;
  const links = useMemo(() => linkService?.forPage({ space, key: `${modeKey.space}\n${modeKey.page}` }), [linkService, space, modeKey.space, modeKey.page]);
  const media = useRef(props.media ?? null);
  media.current = props.media ?? null;
  const pickImage = pageHost.pickImage;
  const ctx = useMemo(
    () =>
      createEditorContext({
        lookup: () => lookup.current,
        suggester: () => suggester.current,
        openPage: (p) => open.current(p),
        strings: t,
        client,
        media: () => media.current,
        ...(links ? { links, openExternal: (url: string) => links.open(url) } : {}),
        ...(pickImage ? { pickImage } : {}),
      }),
    [t, client, links, pickImage],
  );
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

  // Analytics and notification hooks: no page content, title or id is passed on (the caller knows which page it is).
  const conflictOpen = state.conflict !== null;
  const notify = useRef(props.onConflict);
  notify.current = props.onConflict;
  useEffect(() => {
    if (conflictOpen) notify.current?.({ kind: "shown" });
  }, [conflictOpen]);
  const saved = useRef(props.onSaved);
  saved.current = props.onSaved;
  useEffect(() => {
    if (state.save === "saved") saved.current?.();
  }, [state.save]);

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

  // The command palette reaches the open page through these: switch the mode, style the selection.
  useEffect(
    () =>
      registerEditorActions({
        toggleMode: () => switchMode(mode === "blocks" ? "plain" : "blocks"),
        canFormat: () => mode === "blocks" && canSwitch && (handle.current?.canFormat?.() ?? false),
        format: (command) => handle.current?.format?.(command) ?? false,
      }),
    [mode, canSwitch, switchMode],
  );

  const editorProps = { ctx, handleRef: handle, onEdit: () => session?.noteEdited(), onSaveShortcut: () => void session?.save() };

  return (
    <section className="page-view" aria-label={props.label}>
      <Breadcrumbs badge={props.crumbs.badge} parts={props.crumbs.parts} status={state.save}>
        {props.actions}
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
                      {t.retry}
                    </Button>
                  )}
                  {props.errorAction}
                </p>
              )}
              {state.conflictCopy && (
                <p role="status" className="alert alert-warning">
                  {t.copySaved.before}
                  <b>{state.conflictCopy.label}</b>
                  {t.copySaved.after}{" "}
                  <Button variant="quiet" small onClick={() => props.openCopy(state.conflictCopy!.ref)}>
                    {t.openIt}
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
        <ConflictDialog
          name={props.label}
          where={store.kind === "workspace" ? "server" : "disk"}
          conflict={state.conflict}
          error={state.error}
          onChoose={(choice) =>
            void session.resolveConflict(choice).then(() => {
              if (session.getState().conflict === null) notify.current?.({ kind: "resolved", choice });
            })
          }
        />
      )}
    </section>
  );
}
