/** A window on one Markdown file the system handed over (Open With, a Dock drop; ADR-0057): the shared page editor over
 * the file's token. No Private Space is open here: links stay unresolved and the file's images show placeholders. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenedFileInfo, Platform } from "@thoth/platform";
import { PageFrame } from "@thoth/app-ui/editor/PageFrame.tsx";
import { PageHostContext, type PageHost } from "@thoth/app-ui/editor/host.ts";
import { LanguageRoot } from "../../app/App.tsx";
import { useDesktopStrings } from "../../strings/index.ts";
import { openedFileStore } from "./opened-store.ts";

export function FileWindow({ platform, token }: { platform: Platform; token: string }) {
  return (
    <LanguageRoot>
      <FileWindowBody platform={platform} token={token} />
    </LanguageRoot>
  );
}

function FileWindowBody({ platform, token }: { platform: Platform; token: string }) {
  const { opened: t, page } = useDesktopStrings();
  const files = platform.openedFile;
  const [info, setInfo] = useState<OpenedFileInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The file is checked again whenever the window comes back to the front (another app may have changed it).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  useEffect(() => {
    if (!files) return setFailed(true);
    let live = true;
    void files.stat(token).then(
      (next) => {
        if (!live) return;
        setInfo(next);
        document.title = next.name;
      },
      () => live && setFailed(true),
    );
    return () => void (live = false);
  }, [files, token]);
  const store = useMemo(() => (files && info ? openedFileStore(files, token, info.name) : null), [files, info, token]);
  // Links lead nowhere without a Private Space; a conflict copy is next to the file, where the person can open it.
  const nowhere = useCallback(() => undefined, []);
  // The editor's host: autosave as in a Private Space, and the window's close button writes pending edits first.
  const flushers = useRef(new Set<() => Promise<boolean>>());
  const pageHost = useMemo<PageHost>(() => {
    const flushAll = async () => (await Promise.all([...flushers.current].map((f) => f().catch(() => false)))).every(Boolean);
    return {
      autosaveMs: 1000,
      now: () => new Date(),
      registerFlush: (flush) => {
        flushers.current.add(flush);
        return () => void flushers.current.delete(flush);
      },
      flushAll,
    };
  }, []);
  // "Open its folder as a Private Space": pending edits are written first; one that cannot be keeps the file open here.
  const promote = useCallback(() => {
    setProblem(null);
    void pageHost.flushAll!()
      .then((saved) => {
        if (!saved) throw new Error("not saved");
        return platform.windows?.promoteFile?.(token) ?? Promise.reject(new Error("no shell"));
      })
      .catch(() => setProblem(t.openFolderFailed));
  }, [pageHost, platform.windows, token, t.openFolderFailed]);
  useEffect(() => {
    const windows = platform.windows;
    if (!windows?.onCloseRequested) return;
    let stop: (() => void) | undefined;
    let live = true;
    void windows
      .onCloseRequested(() => void pageHost.flushAll!().finally(() => void windows.closeThis({ evenIfLast: true })))
      .then((remove) => (live ? (stop = remove) : remove()));
    return () => {
      live = false;
      stop?.();
    };
  }, [platform.windows, pageHost]);

  if (failed) return <main className="file-window" role="alert">{t.loadFailed}</main>;
  if (!store || !info) return <main className="file-window" aria-busy="true" />;
  return (
    <main className="file-window">
      <PageHostContext.Provider value={pageHost}>
        <PageFrame
          label={info.name}
          store={store}
          modeKey={{ space: `file:${info.folder}`, page: info.name }}
          crumbs={{ badge: <span className="badge">{info.folder}</span>, parts: [info.name] }}
          checkTick={tick}
          onWritten={nowhere}
          loadLinks={null}
          linkTick={0}
          openLink={nowhere}
          openCopy={nowhere}
          readOnlyNote={page.readOnly}
          missing={{ title: t.goneTitle, detail: t.goneDetail(info.name) }}
          actions={
            <span className="page-actions">
              <button type="button" className="btn" onClick={promote}>
                {t.openFolder}
              </button>
            </span>
          }
          footer={problem ? <p role="alert">{problem}</p> : undefined}
        />
      </PageHostContext.Provider>
    </main>
  );
}
