/**
 * The Memories view (ADR-0052): what agents remember in this window's Private Space, grouped by kind, each with the app
 * that wrote it, when, and the hints of rule 4 (inferred, or older than its kind's "Check after" age), with a filter by
 * app. Under them, the writes without review of the last 30 days, each with Undo while the file is as it left it.
 * A memory opens as a page: editing and deleting work as on any page.
 */
import { useCallback, useEffect, useState } from "react";
import type { ConnectedApps, MemoryHistoryChange } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { MEMORY_FOLDER, MEMORY_KINDS, ageDays, canUndoMemory, isStale, loadMemories, undoMemory, type Memory } from "@thoth/local-store";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import "../agents/agents.css";
import "./connected-apps.css";

/** Recent changes shown at most. */
const RECENT = 20;

interface Loaded {
  folder: string;
  about: Memory | null;
  memories: Memory[];
  /** Newest first, each with whether Undo can still put it back. */
  changes: { change: MemoryHistoryChange; undoable: boolean }[];
}

export function MemoriesView({ connectedApps, onClose }: { connectedApps: ConnectedApps; onClose(): void }) {
  const { vault, connection, revision, refresh, openPage } = useSession();
  const t = useDesktopStrings().connectedApps.memoriesView;
  const trash = connection.trash?.bind(connection);
  const [data, setData] = useState<Loaded | null>(null);
  const [app, setApp] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const reload = useCallback(async () => {
    const settings = await connectedApps.settings().catch(() => null);
    const folder = settings?.memoryFolders?.[connection.root] ?? MEMORY_FOLDER;
    const [{ about, memories }, history] = await Promise.all([loadMemories(vault, folder), connectedApps.memoryHistory().catch(() => [])]);
    const mine = history.filter((c) => c.root === connection.root).slice(0, RECENT);
    const changes = await Promise.all(mine.map(async (change) => ({ change, undoable: await canUndoMemory(vault, change) })));
    setData({ folder, about, memories, changes });
  }, [connectedApps, connection.root, vault]);

  // Again when the index changes (an edit, a save from an agent) and when an app writes a memory.
  useEffect(() => {
    void reload().catch(() => setData({ folder: MEMORY_FOLDER, about: null, memories: [], changes: [] }));
  }, [reload, revision]);
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void connectedApps
      .onMemories((written) => {
        if (written.root === connection.root) void reload().catch(() => undefined);
      })
      .then((remove) => (live ? (stop = remove) : remove()));
    return () => {
      live = false;
      stop?.();
    };
  }, [connectedApps, connection.root, reload]);

  const undo = async (change: MemoryHistoryChange) => {
    setBusy(true);
    setStatus("");
    try {
      const full = await connectedApps.memoryChange(change.id);
      await undoMemory(vault, trash, full, data?.folder);
      await refresh([change.path]);
      setStatus(t.undone(change.title));
      await reload();
    } catch (error) {
      setStatus(t.undoFailed(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  };
  const open = (path: string) => {
    onClose();
    openPage(path);
  };

  const now = new Date();
  const apps = [...new Set((data?.memories ?? []).map((m) => m.updatedBy || m.source).filter((a) => a !== ""))].sort((a, b) => a.localeCompare(b));
  const shown = (data?.memories ?? []).filter((m) => app === "" || m.source === app || m.updatedBy === app);
  return (
    <Modal title={t.title} onClose={onClose} wide>
      <div className="mcp-review mcp-memories" data-testid="mcp-memories">
        <p className="muted">{t.lede(`${data?.folder ?? MEMORY_FOLDER}/`)}</p>
        <p role="status" className="muted small">
          {status}
        </p>
        {data === null ? (
          <p className="muted">{t.loading}</p>
        ) : (
          <>
            {apps.length > 1 && (
              <label className="mcp-memories-filter">
                <span className="small">{t.app}</span>
                <select value={app} onChange={(e) => setApp(e.target.value)}>
                  <option value="">{t.allApps}</option>
                  {apps.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {data.about && data.about.text !== "" && (
              <section className="mcp-review-app" aria-label={t.aboutMe}>
                <h3>
                  <button type="button" className="link-button" onClick={() => open(data.about!.path)}>
                    {t.aboutMe}
                  </button>
                </h3>
                <p className="muted small">{t.aboutMeHint}</p>
              </section>
            )}
            {shown.length === 0 && !(data.about && data.about.text !== "") ? (
              <p className="muted">{t.none}</p>
            ) : (
              MEMORY_KINDS.map((kind) => {
                const group = shown.filter((m) => m.kind === kind).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
                if (group.length === 0) return null;
                return (
                  <section key={kind} className="mcp-review-app" aria-label={t.kinds[kind]}>
                    <h3>
                      {t.kinds[kind]} <span className="muted small">{group.length.toLocaleString()}</span>
                    </h3>
                    <ul className="mcp-memory-list">
                      {group.map((m) => (
                        <li key={m.path} className="mcp-memory">
                          <button type="button" className="link-button mcp-memory-title" onClick={() => open(m.path)}>
                            {m.title}
                          </button>
                          <span className="muted small">{t.meta(m.updatedBy || m.source || t.byYou, new Date(m.updated))}</span>
                          {m.certainty === "inferred" && (
                            <span className="badge badge-muted" title={t.inferredHint}>
                              {t.inferred}
                            </span>
                          )}
                          {isStale(m, now) && <span className="muted small mcp-memory-stale">{t.stale(ageDays(m, now))}</span>}
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })
            )}
            {data.changes.length > 0 && (
              <section className="mcp-review-app" aria-labelledby="mcp-memories-recent">
                <h3 id="mcp-memories-recent">{t.recent}</h3>
                <p className="muted small">{t.recentHint}</p>
                <ul className="mcp-memory-list">
                  {data.changes.map(({ change, undoable }) => (
                    <li key={change.id} className="mcp-memory" data-action={change.action}>
                      <span>{t.actions[change.action](change.app, change.title)}</span>
                      <time className="muted small" dateTime={change.createdAt}>
                        {t.when(new Date(change.createdAt))}
                      </time>
                      {undoable ? (
                        <Button variant="ghost" small disabled={busy} aria-label={t.undoLabel(change.title)} onClick={() => void undo(change)}>
                          {t.undo}
                        </Button>
                      ) : (
                        <span className="muted small">{t.changedSince}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
