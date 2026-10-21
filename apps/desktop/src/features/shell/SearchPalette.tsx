import { useEffect, useId, useRef, useState } from "react";
import type { SearchHit } from "@thoth/local-store";
import { Modal } from "../../ui/Modal.tsx";
import { useSession } from "../../app/context.ts";

/** Cmd/Ctrl+K quick search over the index (`vault.search`). */
export function SearchPalette({ onClose }: { onClose(): void }) {
  const { vault, openPage } = useSession();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    if (query.trim() === "") {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      vault
        .search(query)
        .then((result) => {
          if (mine !== seq.current) return;
          setHits(result);
          setActive(0);
          setError(null);
        })
        .catch((e: unknown) => mine === seq.current && setError(e instanceof Error ? e.message : String(e)));
    }, 80);
    return () => clearTimeout(timer);
  }, [vault, query]);

  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onClose();
    openPage(hit.path);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(hits[active]);
    }
  };

  return (
    <Modal title="Search" onClose={onClose}>
      <input
        data-autofocus
        className="input"
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls={listId}
        aria-activedescendant={hits[active] ? `${listId}-${active}` : undefined}
        aria-label="Search pages"
        placeholder="Search pages…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {error && (
        <p role="alert" className="alert alert-danger">
          {error}
        </p>
      )}
      <ul id={listId} role="listbox" aria-label="Results" className="results">
        {hits.map((hit, i) => (
          <li key={hit.id} id={`${listId}-${i}`} role="option" aria-selected={i === active} className="result" onMouseEnter={() => setActive(i)} onClick={() => choose(hit)}>
            <b>{hit.title}</b>
            <span className="muted mono">{hit.path}</span>
            <span className="snippet">{hit.snippet}</span>
          </li>
        ))}
      </ul>
      {query.trim() !== "" && hits.length === 0 && !error && <p className="muted">No pages match “{query.trim()}”.</p>}
    </Modal>
  );
}
