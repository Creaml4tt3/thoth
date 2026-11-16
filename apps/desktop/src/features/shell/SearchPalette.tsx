import { useEffect, useId, useRef, useState } from "react";
import type { SearchHit } from "@thoth/local-store";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { CommandOptions, useCommandMode } from "@thoth/app-ui/keyboard/CommandOptions.tsx";
import type { Command } from "@thoth/app-ui/keyboard/commands.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { tipIfClipped } from "@thoth/app-ui/ui/Tooltip.tsx";
import { Icon } from "@thoth/app-ui/ui/Icon.tsx";

/** The index body starts with the title, then often the page's own H1 (parse.ts keeps block breaks), so a snippet can
 * open with the title twice; the row already shows it. Drops only whole leading lines equal to the title (brackets and
 * case ignored); anything else, such as a longer heading that starts the same, stays as it is. */
export function withoutTitle(snippet: string, title: string): string {
  const lines = snippet.split("\n");
  const same = (line: string) => line.replace(/[[\]]/g, "").trim().toLowerCase() === title.trim().toLowerCase();
  let start = 0;
  while (start < lines.length && title.trim() !== "" && (same(lines[start]!) || (start > 0 && lines[start]!.trim() === ""))) start++;
  const rest = lines.slice(start).join("\n").trim();
  return rest === "" ? snippet : rest;
}

/** A snippet's matches come bracketed from the index (`[plan]`, search-query.ts `markTerms`); shown as <mark>. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[([^\]]*)\]/);
  return <>{parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}</>;
}

/** The folder a page sits in, as people read it: "Projects / Ideas", nothing for the top level, no ".md". */
export const parentOf = (path: string): string => path.split("/").slice(0, -1).join(" / ");
const titleOf = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/i, "");

/**
 * Cmd/Ctrl+K quick search over the index (`vault.search`). Starting with `>` it lists commands instead (ADR-0016 rule
 * 7): new page, rename, move, theme, tabs, Settings, the shortcuts list and, with text selected, its styles.
 */
export function SearchPalette({ commands, onRun, onClose }: { commands: readonly Command[]; onRun(command: Command): void; onClose(): void }) {
  const { vault, openPage, recent } = useSession();
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
      setActive(0); // back to the recent list: its first row, never an index past its end
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

  // Before anything is typed: the pages opened last in this Private Space, so the palette is useful at once.
  const recentPages = query.trim() === "" && !cmd.on ? recent.get().flatMap((e) => (e.ref.kind === "private" ? [e.ref.path] : [])).slice(0, 5) : [];
  const rows: { id: string; path: string; title: string; snippet?: string }[] =
    recentPages.length > 0 ? recentPages.map((path) => ({ id: path, path, title: titleOf(path) })) : hits.map((h) => ({ id: h.id, path: h.path, title: h.title, snippet: withoutTitle(h.snippet, h.title) }));

  const choose = (hit: { path: string } | undefined) => {
    if (!hit) return;
    onClose();
    openPage(hit.path);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (cmd.onKeyDown(event)) return;
    if (cmd.on) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(rows[active]);
    }
  };

  return (
    <Modal title={t.title} onClose={onClose} palette>
      <div className="palette-input">
        <Icon name="search" />
      <input
        data-autofocus
        className="input"
        role="combobox"
        aria-expanded={cmd.on ? cmd.items.length > 0 : rows.length > 0}
        aria-controls={cmd.on ? cmd.listId : listId}
        aria-activedescendant={cmd.on ? cmd.activeId : rows[active] ? `${listId}-${active}` : undefined}
        aria-label={t.label}
        placeholder={t.placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      </div>
      {cmd.on ? (
        <CommandOptions mode={cmd} />
      ) : (
        <>
          {error && (
            <p role="alert" className="alert alert-danger">
              {error}
            </p>
          )}
          {recentPages.length > 0 && <p className="palette-label">{t.recent}</p>}
          <ul id={listId} role="listbox" aria-label={recentPages.length > 0 ? t.recent : t.results} className="results">
            {rows.map((row, i) => (
              <li key={row.id} id={`${listId}-${i}`} role="option" aria-selected={i === active} className="result" onMouseEnter={() => setActive(i)} onClick={() => choose(row)}>
                <span className="result-line">
                  <Icon name="page" />
                  <b className="result-title">{row.title}</b>
                  {parentOf(row.path) && <span className="result-path">{parentOf(row.path)}</span>}
                </span>
                {row.snippet && (
                  <span className="snippet" {...tipIfClipped(row.snippet.replace(/[[\]]/g, ""))}>
                    <Snippet text={row.snippet} />
                  </span>
                )}
              </li>
            ))}
          </ul>
          {query.trim() === "" && <p className="palette-hint">{k.palette.hint}</p>}
          {query.trim() !== "" && hits.length === 0 && !error && <p className="muted">{t.none(query.trim())}</p>}
        </>
      )}
    </Modal>
  );
}
