import { useEffect, useRef, useState } from "react";
import type { Workspace } from "@thoth/workspace-protocol";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { CommandOptions, useCommandMode } from "@thoth/app-ui/keyboard/CommandOptions.tsx";
import type { Command } from "@thoth/app-ui/keyboard/commands.ts";
import type { ServerDirectory, WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";
import { SERVER_ID } from "./servers.ts";

interface Hit {
  workspace: Workspace;
  pageId: string;
  title: string;
  snippet?: string;
}

const DEBOUNCE_MS = 250;

interface Props {
  directory: ServerDirectory;
  workspaces: Workspace[];
  /** The server can search; when it cannot, the dialog still lists commands. */
  canSearch: boolean;
  commands: readonly Command[];
  onRun(command: Command): void;
  onOpen(ref: WorkspacePageRef): void;
  onClose(): void;
  onSearched(): void;
}

/**
 * Searches every workspace the user is in (the server's own search). Reports one `search` per dialog, never the text.
 * Starting with `>` it lists commands instead (ADR-0016 rule 7).
 */
export function SearchDialog({ directory, workspaces, canSearch, commands, onRun, onOpen, onClose, onSearched }: Props) {
  const t = useStrings();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const reported = useRef(false);
  const searched = useRef(onSearched);
  searched.current = onSearched;
  const cmd = useCommandMode(query, commands, onRun);

  useEffect(() => {
    const q = query.trim();
    if (q === "" || cmd.on || !canSearch) {
      setHits(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      if (!reported.current) {
        reported.current = true;
        searched.current();
      }
      const client = directory.client(SERVER_ID);
      Promise.all(workspaces.map(async (workspace) => (await client.search(workspace.id, { query: q, limit: 20 })).items.map((h) => ({ workspace, pageId: h.pageId, title: h.title, ...(h.snippet ? { snippet: h.snippet } : {}) }))))
        .then((lists) => {
          if (!live) return;
          setHits(lists.flat());
          setActive(0);
          setError(null);
        })
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, directory, workspaces, cmd.on, canSearch]);

  const open = (hit: Hit) => {
    onClose();
    onOpen({ server: SERVER_ID, workspace: hit.workspace.id, page: hit.pageId });
  };

  return (
    <Modal title={t.web.search} onClose={onClose}>
      <input
        data-autofocus
        className="input"
        type="search"
        role="combobox"
        aria-expanded={cmd.on ? cmd.items.length > 0 : hits !== null && hits.length > 0}
        aria-controls={cmd.on ? cmd.listId : "search-results"}
        aria-activedescendant={cmd.on ? cmd.activeId : undefined}
        aria-label={t.web.searchPlaceholder}
        placeholder={t.keyboard.searchOrCommands}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (cmd.onKeyDown(e) || cmd.on) return;
          if (!hits || hits.length === 0) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            open(hits[active]!);
          }
        }}
      />
      {cmd.on ? (
        <CommandOptions mode={cmd} />
      ) : (
        <>
          {error && (
            <p role="alert" className="alert alert-danger">
              {error}
            </p>
          )}
          {hits === null ? (
            <>
              {canSearch && <p className="muted">{t.web.searchHint}</p>}
              <p className="muted">{t.keyboard.palette.hint}</p>
            </>
          ) : hits.length === 0 ? (
            <p className="muted" role="status">
              {t.web.searchNone}
            </p>
          ) : (
            <ul id="search-results" className="results" role="listbox" aria-label={t.web.search}>
              {hits.map((hit, i) => (
                <li key={`${hit.workspace.id}/${hit.pageId}`} role="option" aria-selected={i === active} className="result" onMouseDown={(e) => e.preventDefault()} onClick={() => open(hit)}>
                  <b>{hit.title}</b>
                  {workspaces.length > 1 && <span className="muted">{hit.workspace.name}</span>}
                  {hit.snippet && <span className="snippet">{hit.snippet}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}
