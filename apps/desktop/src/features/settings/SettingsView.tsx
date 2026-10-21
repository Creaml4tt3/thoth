import { useState } from "react";
import { Button } from "../../ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { ImportWizard } from "../import/ImportWizard.tsx";

type Rebuild = { state: "idle" } | { state: "running" } | { state: "done"; pages: number } | { state: "error"; message: string };

/** Settings: vault location, Rebuild index, and Import & Export. */
export function SettingsView() {
  const { connection, vault, refresh, switchVault, openPage, openFolder } = useSession();
  const [rebuild, setRebuild] = useState<Rebuild>({ state: "idle" });
  const [importing, setImporting] = useState(false);

  const rebuildIndex = async () => {
    setRebuild({ state: "running" });
    try {
      const report = await vault.rebuildIndex();
      await refresh();
      setRebuild({ state: "done", pages: report.added.length });
    } catch (e) {
      setRebuild({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="page-scroll">
      <div className="page-col settings">
        <h1 className="page-title">Settings</h1>

        <section aria-labelledby="set-vault" className="set-section">
          <h2 id="set-vault">Private Space</h2>
          <p>
            <b>{connection.label}</b> <span className="badge badge-private">Local</span>
          </p>
          <p className="mono muted" data-testid="vault-location">
            {connection.root}
          </p>
          <p className="muted">Pages are Markdown files in this folder. The index lives in .thoth inside it and can always be rebuilt.</p>
          <div className="set-actions">
            <Button variant="ghost" small onClick={switchVault}>
              Switch Private Space
            </Button>
          </div>
        </section>

        <section aria-labelledby="set-index" className="set-section">
          <h2 id="set-index">Search index</h2>
          <p className="muted">Rebuilding re-reads every file and recreates the index. Your files are not changed.</p>
          <div className="set-actions">
            <Button variant="ghost" small disabled={rebuild.state === "running"} onClick={() => void rebuildIndex()}>
              {rebuild.state === "running" ? "Rebuilding…" : "Rebuild index"}
            </Button>
            <span role="status" className="muted">
              {rebuild.state === "done" ? `Index rebuilt (${rebuild.pages} pages read).` : ""}
            </span>
          </div>
          {rebuild.state === "error" && (
            <p role="alert" className="alert alert-danger">
              {rebuild.message}
            </p>
          )}
        </section>

        <section aria-labelledby="set-import" className="set-section">
          <h2 id="set-import">Import & Export</h2>
          {importing ? (
            <ImportWizard
              onClose={() => setImporting(false)}
              onOpenFolder={(folder) => {
                setImporting(false);
                openFolder(folder);
              }}
              onOpenPage={openPage}
            />
          ) : (
            <>
              <p className="muted">Bring pages in from Notion or Obsidian. Your originals are only ever read.</p>
              <div className="set-actions">
                <Button variant="primary" small onClick={() => setImporting(true)}>
                  Import from Notion or Obsidian
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
