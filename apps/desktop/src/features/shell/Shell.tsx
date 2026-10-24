import { useEffect, useState, useSyncExternalStore } from "react";
import type { PageSummary } from "@thoth/domain";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { PageView } from "../editor/PageView.tsx";
import { SettingsView } from "../settings/SettingsView.tsx";
import { NewPageDialog } from "./NewPageDialog.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { WorkspacePageView } from "../servers/WorkspacePageView.tsx";
import { TransferDialog, type TransferTarget } from "../transfer/TransferDialog.tsx";
import type { WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";

type Dialog = { kind: "search" } | { kind: "new" } | { kind: "transfer"; target: TransferTarget } | null;

/** What startup recovery did, said once (ADR-0006 §7: an interrupted transfer is never silent). */
function RecoveryNotice() {
  const { transfers } = useSession();
  const t = useDesktopStrings().transfer;
  const { recovery } = useSyncExternalStore(transfers.subscribe, transfers.getState);
  const [hidden, setHidden] = useState(false);
  if (!recovery || hidden) return null;
  const lines = [
    recovery.completed.length > 0 ? t.recoveredCompleted(recovery.completed.length) : null,
    recovery.rolledBack.length > 0 ? t.recoveredRolledBack(recovery.rolledBack.length) : null,
    recovery.waiting.length > 0 ? t.recoveredWaiting(recovery.waiting.length) : null,
  ].filter((l): l is string => l !== null);
  if (lines.length === 0) return null;
  return (
    <div role="status" className="alert alert-warning banner">
      <b>{t.recoveredTitle}.</b> {lines.join(" ")}{" "}
      <Button variant="quiet" small onClick={() => setHidden(true)}>
        {t.dismiss}
      </Button>
    </div>
  );
}

/** The Paper shell: sidebar on the left, page or settings on the right. */
export function Shell({ path, remote = null, settings }: { path: string | null; remote?: WorkspacePageRef | null; settings: false | "top" | "servers" }) {
  const { vault, revision, watchError, openPage, flushAll } = useSession();
  const t = useDesktopStrings().shell;
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
        setDialog((d) => (d?.kind === "search" ? null : { kind: "search" }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Open the first page when nothing is open yet, so the shell is never blank.
  useEffect(() => {
    if (!path && !remote && !settings && pages.length > 0) openPage(pages[0]!.path);
  }, [path, remote, settings, pages, openPage]);

  // Unsaved edits are written first, so the transfer sends (and hashes) what is on screen.
  const transfer = (target: TransferTarget) => void flushAll().then((ok) => ok && setDialog({ kind: "transfer", target }));

  return (
    <div className="shell" data-theme="light">
      <Sidebar pages={pages} current={settings ? null : path} currentRemote={settings ? null : remote} onSearch={() => setDialog({ kind: "search" })} onNewPage={() => setDialog({ kind: "new" })} onTransfer={transfer} />
      <main className="main">
        {watchError && (
          <p role="alert" className="alert alert-warning banner">
            {t.watchError(watchError)}
          </p>
        )}
        <RecoveryNotice />
        {settings ? (
          <SettingsView section={settings} />
        ) : remote ? (
          <WorkspacePageView key={`${remote.server}\n${remote.workspace}\n${remote.page}`} target={remote} onTransfer={transfer} />
        ) : path ? (
          <PageView key={path} path={path} />
        ) : (
          <div className="empty">
            <Mark size={40} />
            <h1>{t.nothingOpen}</h1>
            <p className="muted">{t.nothingOpenHint}</p>
          </div>
        )}
      </main>
      {dialog?.kind === "search" && <SearchPalette onClose={() => setDialog(null)} />}
      {dialog?.kind === "new" && <NewPageDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "transfer" && <TransferDialog target={dialog.target} onClose={() => setDialog(null)} />}
    </div>
  );
}
