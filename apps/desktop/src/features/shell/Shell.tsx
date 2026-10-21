import { useEffect, useState } from "react";
import type { PageSummary } from "@thoth/domain";
import { useSession } from "../../app/context.ts";
import { PageView } from "../editor/PageView.tsx";
import { SettingsView } from "../settings/SettingsView.tsx";
import { NewPageDialog } from "./NewPageDialog.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Mark } from "../../ui/Mark.tsx";

type Dialog = "search" | "new" | null;

/** The Paper shell: sidebar on the left, page or settings on the right. */
export function Shell({ path, settings }: { path: string | null; settings: boolean }) {
  const { vault, revision, watchError, openPage } = useSession();
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    let live = true;
    vault
      .listPages()
      .then((list) => live && setPages(list))
      .catch(() => undefined); // the vault may have closed while this was in flight
    return () => {
      live = false;
    };
  }, [vault, revision]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDialog((d) => (d === "search" ? null : "search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Open the first page when nothing is open yet, so the shell is never blank.
  useEffect(() => {
    if (!path && !settings && pages.length > 0) openPage(pages[0]!.path);
  }, [path, settings, pages, openPage]);

  return (
    <div className="shell" data-theme="light">
      <Sidebar pages={pages} current={settings ? null : path} onSearch={() => setDialog("search")} onNewPage={() => setDialog("new")} />
      <main className="main">
        {watchError && (
          <p role="alert" className="alert alert-warning banner">
            Changes made outside Thoth may not show up automatically: {watchError}
          </p>
        )}
        {settings ? (
          <SettingsView />
        ) : path ? (
          <PageView key={path} path={path} />
        ) : (
          <div className="empty">
            <Mark size={40} />
            <h1>Nothing open</h1>
            <p className="muted">Create a page with New page, or press Ctrl/Cmd+K to search.</p>
          </div>
        )}
      </main>
      {dialog === "search" && <SearchPalette onClose={() => setDialog(null)} />}
      {dialog === "new" && <NewPageDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
