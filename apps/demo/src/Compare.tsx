/** "Weekend plans" in the real Blocks and Plain editors side by side, one page session between them (the app's session pool). */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createEditorContext, type EditorContext } from "@thoth/app-ui/editor/context.ts";
import { createLinkSuggester } from "@thoth/app-ui/editor/link-suggest.ts";
import { buildLinkLookup } from "@thoth/app-ui/editor/links.ts";
import { PageEditor, type PageEditorHandle } from "@thoth/app-ui/editor/PageEditor.tsx";
import type { PageStore } from "@thoth/app-ui/editor/page-session.ts";
import { loadPlainEditor, plainEditorNow } from "@thoth/app-ui/editor/plain/load.ts";
import { pageKey } from "@thoth/app-ui/editor/session-pool.ts";
import { usePageSession } from "@thoth/app-ui/editor/usePageSession.ts";
import { STRINGS, type Lang } from "@thoth/app-ui/strings/index.ts";
import { demoStrings } from "./strings.ts";
import type { Vault } from "./store.ts";

const WIDE = "(min-width: 900px)";
const noop = () => undefined;

function useWide(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = matchMedia(WIDE);
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => matchMedia(WIDE).matches,
  );
}

type Kind = "blocks" | "plain";

/** One editor on the shared page: it leads when edited or focused, the other catches up (`usePageSession`, ADR-0030). */
function Side({ kind, store, ctx, path }: { kind: Kind; store: PageStore; ctx: EditorContext; path: string }) {
  const handle = useRef<PageEditorHandle>(null);
  const { member } = usePageSession(store, handle, { checkTick: 0, onWritten: noop }, pageKey(store, "demo", path));
  const props = { ctx, handleRef: handle, onEdit: () => member?.edited(), onSaveShortcut: noop };
  const Plain = plainEditorNow();
  return (
    <div className="page-scroll demo-col-body" onFocus={() => member?.focused()}>
      <div className="page-col">{kind === "plain" && Plain ? <Plain {...props} /> : <PageEditor {...props} />}</div>
    </div>
  );
}

export function Compare({ vault, lang }: { vault: Vault; lang: Lang }) {
  const t = demoStrings[lang];
  // As PageFrame does: no session starts before the Plain editor's chunk has loaded, so the text it reads always has an editor to go into.
  const [ready, setReady] = useState(() => plainEditorNow() !== undefined);
  useEffect(() => {
    if (ready) return;
    let live = true;
    const done = () => live && setReady(true);
    loadPlainEditor().then(done, done);
    return () => void (live = false);
  }, [ready]);
  const wide = useWide();
  const [which, setWhich] = useState<Kind>("blocks");
  const path = vault.first;
  const store = vault.storeFor(path);
  const ctx = useMemo(
    () => {
      const lookup = buildLinkLookup(path, [], vault.summaries, vault.folders);
      const suggester = createLinkSuggester(path, vault.summaries, vault.folders);
      // No pickImage, links, openExternal or media: no image item, nothing fetched. A page link does nothing here.
      return createEditorContext({ lookup: () => lookup, suggester: () => suggester, openPage: noop, strings: STRINGS[lang].editor, client: "web" });
    },
    [vault, path, lang],
  );
  const kinds: Kind[] = wide ? ["blocks", "plain"] : [which];
  if (!ready) return <div className="demo-compare" aria-busy="true" />;
  return (
    <div className="demo-compare">
      {!wide && (
        <div className="mode-switch demo-switch" role="group" aria-label={t.switchGroup}>
          {(["blocks", "plain"] as const).map((k) => (
            <button key={k} type="button" className="btn btn-quiet btn-sm mode-option" aria-pressed={which === k} onClick={() => setWhich(k)}>
              {t[k]}
            </button>
          ))}
        </div>
      )}
      <div className="demo-cols">
        {kinds.map((k) => (
          <section key={k} className="demo-col" aria-label={t[k]}>
            {wide && <p className="demo-cap" aria-hidden="true">{t[k]}</p>}
            <Side kind={k} store={store} ctx={ctx} path={path} />
          </section>
        ))}
      </div>
    </div>
  );
}
