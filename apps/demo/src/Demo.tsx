/** One demo (compare or window): the app's contexts, a labelled region that Esc returns to, and "Start over". */
import { useRef, useState, type KeyboardEvent, type FocusEvent, type ReactNode } from "react";
import { PageHostContext, type PageHost } from "@thoth/app-ui/editor/host.ts";
import { HintContext } from "@thoth/app-ui/keyboard/hints.ts";
import { currentPlatform } from "@thoth/app-ui/keyboard/shortcuts.ts";
import { STRINGS, StringsContext, type Lang } from "@thoth/app-ui/strings/index.ts";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Compare } from "./Compare.tsx";
import { resetModes } from "./shim/mode.ts";
import { demoStrings } from "./strings.ts";
import { createVault, type Vault } from "./store.ts";
import { Window } from "./Window.tsx";
import { en } from "./vault/en.ts";
import { th } from "./vault/th.ts";

export type DemoKind = "compare" | "window";

/** What focus is in when the hint shows and Esc applies: either editor. */
export const EDITOR = ".ProseMirror, .cm-content";
/** The editors' menus and selection toolbar, while one is showing (they hide with `hidden`). */
const OPEN_POPUP = ".slash-menu:not([hidden]), .link-menu:not([hidden]), .block-menu:not([hidden]), .text-toolbar:not([hidden])";

interface Session {
  id: number;
  vault: Vault;
  host: PageHost;
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';
const tabbable = (el: HTMLElement): boolean => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest("[inert], [hidden]") && el.getClientRects().length > 0;

/** The tab stop after (or, with `back`, before) the whole of `from` in the page, so Esc then Tab goes on past the editor just left, not into its own checkboxes. */
export function tabStopFrom(from: HTMLElement, back: boolean): HTMLElement | undefined {
  const side = back ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  const stops = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !from.contains(el) && !el.contains(from) && from.compareDocumentPosition(el) & side && tabbable(el));
  return back ? stops[stops.length - 1] : stops[0];
}

let counter = 0;
/** autosave off and no flush: nothing is saved by timer; a page's edits reach the in-memory store when its last editor leaves. */
const fresh = (lang: Lang): Session => ({
  id: ++counter,
  vault: createVault(lang === "th" ? th : en),
  host: { client: "web", autosaveMs: 0, now: () => new Date(), registerFlush: () => () => {} },
});

export function Demo({ kind, lang }: { kind: DemoKind; lang: Lang }) {
  const t = demoStrings[lang];
  const [session, setSession] = useState(() => fresh(lang));
  const [editing, setEditing] = useState(false);
  const region = useRef<HTMLDivElement>(null);
  /** The editor that Esc was pressed in: Tab from the region goes on from there. Plain's Tab indents, so this is how its user gets out. */
  const left = useRef<HTMLElement | null>(null);

  const startOver = () => {
    resetModes();
    setSession(fresh(lang));
  };
  const inEditor = (node: EventTarget | null) => node instanceof Element && node.closest(EDITOR) !== null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Tab" && event.target === region.current && left.current?.isConnected && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const next = tabStopFrom(left.current, event.shiftKey);
      if (next) {
        event.preventDefault();
        left.current = null;
        next.focus();
      }
      return;
    }
    // Capture phase: Tiptap and CodeMirror use Esc themselves (select the parent block, close a menu) and would swallow it.
    // An open menu or the selection toolbar takes this Esc (it closes); the next one leaves.
    if (event.key !== "Escape" || event.nativeEvent.isComposing || !inEditor(event.target) || document.querySelector(OPEN_POPUP)) return;
    event.preventDefault();
    event.stopPropagation();
    left.current = (event.target as Element).closest<HTMLElement>(EDITOR);
    region.current?.focus();
  };
  const hint = (children: ReactNode) => <p className="demo-hint" role="status">{children}</p>;

  return (
    <StringsContext.Provider value={STRINGS[lang]}>
      <HintContext.Provider value={{ client: "web", platform: currentPlatform() }}>
        <PageHostContext.Provider value={session.host}>
          <div
            ref={region}
            className="demo-region"
            role="region"
            tabIndex={-1}
            aria-label={kind === "compare" ? t.compareRegion : t.windowRegion}
            onKeyDownCapture={onKeyDown}
            onFocus={(event: FocusEvent) => setEditing(inEditor(event.target))}
            onBlur={(event: FocusEvent) => setEditing(inEditor(event.relatedTarget))}
            // The sample has no real links, but a typed one must never take the visitor off the site.
            onClickCapture={(event) => event.target instanceof Element && event.target.closest("a") && event.preventDefault()}
            onAuxClick={(event) => event.target instanceof Element && event.target.closest("a") && event.preventDefault()}
          >
            {kind === "compare" ? <Compare key={session.id} vault={session.vault} lang={lang} /> : <Window key={session.id} vault={session.vault} lang={lang} />}
            <div className="demo-bar">
              {hint(editing ? t.escHint : "")}
              <Button variant="quiet" small onClick={startOver}>
                {t.startOver}
              </Button>
            </div>
          </div>
        </PageHostContext.Provider>
      </HintContext.Provider>
    </StringsContext.Provider>
  );
}
