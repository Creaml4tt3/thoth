import { useEffect, useRef, useState } from "react";
import type { Workspace } from "@thoth/workspace-protocol";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import type { ServerDirectory, WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";
import { SERVER_ID } from "./servers.ts";

interface Hit {
  workspace: Workspace;
  pageId: string;
  title: string;
  snippet?: string;
}

const DEBOUNCE_MS = 250;

/** Searches every workspace the user is in (the server's own search). Reports one `search` per dialog, never the text. */
export function SearchDialog({ directory, workspaces, onOpen, onClose, onSearched }: { directory: ServerDirectory; workspaces: Workspace[]; onOpen(ref: WorkspacePageRef): void; onClose(): void; onSearched(): void }) {
  const t = useStrings();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const reported = useRef(false);
  const searched = useRef(onSearched);
  searched.current = onSearched;

  useEffect(() => {
    const q = query.trim();
    if (q === "") {
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
  }, [query, directory, workspaces]);

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
        aria-expanded={hits !== null && hits.length > 0}
        aria-controls="search-results"
        aria-label={t.web.searchPlaceholder}
        placeholder={t.web.searchPlaceholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
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
      {error && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
      {hits === null ? (
        <p className="muted">{t.web.searchHint}</p>
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
    </Modal>
  );
}
