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

interface Session {
  id: number;
  vault: Vault;
  host: PageHost;
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

  const startOver = () => {
    resetModes();
    setSession(fresh(lang));
  };
  const inEditor = (node: EventTarget | null) => node instanceof Element && node.closest(EDITOR) !== null;
  const onKeyDown = (event: KeyboardEvent) => {
    // A menu or a selection takes the first Esc (it prevents the default); the next one leaves.
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || !inEditor(event.target)) return;
    event.preventDefault();
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
            onKeyDown={onKeyDown}
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
