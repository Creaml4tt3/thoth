import { useEffect, useId, useRef, useState } from "react";
import type { SearchHit } from "@thoth/local-store";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { CommandOptions, useCommandMode } from "@thoth/app-ui/keyboard/CommandOptions.tsx";
import type { Command } from "@thoth/app-ui/keyboard/commands.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { tipIfClipped } from "@thoth/app-ui/ui/Tooltip.tsx";

/**
 * Cmd/Ctrl+K quick search over the index (`vault.search`). Starting with `>` it lists commands instead (ADR-0016 rule
 * 7): new page, rename, move, theme, tabs, Settings, the shortcuts list and, with text selected, its styles.
 */
export function SearchPalette({ commands, onRun, onClose }: { commands: readonly Command[]; onRun(command: Command): void; onClose(): void }) {
  const { vault, openPage } = useSession();
  const t = useDesktopStrings().search;
  const k = useStrings().keyboard;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const seq = useRef(0);
  const cmd = useCommandMode(query, commands, onRun);

  useEffect(() => {
    const mine = ++seq.current;
    if (query.trim() === "" || cmd.on) {
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
  }, [vault, query, cmd.on]);

  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onClose();
    openPage(hit.path);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (cmd.onKeyDown(event)) return;
    if (cmd.on) return;
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
    <Modal title={t.title} onClose={onClose}>
      <input
        data-autofocus
        className="input"
        role="combobox"
        aria-expanded={cmd.on ? cmd.items.length > 0 : hits.length > 0}
        aria-controls={cmd.on ? cmd.listId : listId}
        aria-activedescendant={cmd.on ? cmd.activeId : hits[active] ? `${listId}-${active}` : undefined}
        aria-label={t.label}
        placeholder={t.placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
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
          <ul id={listId} role="listbox" aria-label={t.results} className="results">
            {hits.map((hit, i) => (
              <li key={hit.id} id={`${listId}-${i}`} role="option" aria-selected={i === active} className="result" onMouseEnter={() => setActive(i)} onClick={() => choose(hit)}>
                <b>{hit.title}</b>
                <span className="muted mono">{hit.path}</span>
                <span className="snippet" {...tipIfClipped(hit.snippet)}>{hit.snippet}</span>
              </li>
            ))}
          </ul>
          {query.trim() === "" && <p className="muted">{k.palette.hint}</p>}
          {query.trim() !== "" && hits.length === 0 && !error && <p className="muted">{t.none(query.trim())}</p>}
        </>
      )}
    </Modal>
  );
}
