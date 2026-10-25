/**
 * Picks the pages and folders an agent gets (ADR-0007 rule 4). A checkbox list in tree order with a filter: checking
 * a folder includes everything in it (its rows show as included), Space toggles, Tab moves on. Nothing is read
 * here but the page list; staging copies the files when the task starts.
 */
import { useEffect, useMemo, useState } from "react";
import type { PageSummary } from "@thoth/domain";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { buildTree, type TreeNode } from "../shell/tree.ts";

interface Row {
  kind: "folder" | "page";
  path: string;
  label: string;
  depth: number;
  pages: number;
}

function rows(tree: readonly TreeNode[]): Row[] {
  const out: Row[] = [];
  const count = (node: TreeNode): number => (node.kind === "page" ? 1 : node.children.reduce((n, c) => n + count(c), 0));
  const walk = (list: readonly TreeNode[], depth: number) => {
    for (const node of list) {
      if (node.kind === "folder") {
        out.push({ kind: "folder", path: node.path, label: node.name, depth, pages: count(node) });
        walk(node.children, depth + 1);
      } else out.push({ kind: "page", path: node.path, label: node.title, depth, pages: 1 });
    }
  };
  walk(tree, 0);
  return out;
}

/** The folder in `selection` that already includes `path`, if any. */
const coveredBy = (selection: readonly string[], path: string): string | undefined => selection.find((s) => s !== path && path.startsWith(`${s}/`));

export function ContextPicker({ selection, onChange, disabled }: { selection: readonly string[]; onChange(next: string[]): void; disabled?: boolean }) {
  const { vault, revision } = useSession();
  const t = useDesktopStrings().agents.form;
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([vault.listPages(), vault.listFolders().catch(() => [] as string[])]).then(([p, f]) => {
      if (!live) return;
      setPages(p);
      setFolders(f);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [vault, revision]);

  const all = useMemo(() => rows(buildTree(pages, { folders })), [pages, folders]);
  const shown = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase();
    return q === "" ? all : all.filter((r) => r.label.toLocaleLowerCase().includes(q) || r.path.toLocaleLowerCase().includes(q));
  }, [all, filter]);

  const toggle = (row: Row) => {
    if (selection.includes(row.path)) return onChange(selection.filter((s) => s !== row.path));
    // Picking a folder replaces what was picked inside it.
    const next = row.kind === "folder" ? selection.filter((s) => !s.startsWith(`${row.path}/`)) : [...selection];
    onChange([...next, row.path].sort());
  };

  return (
    <fieldset className="agents-context" disabled={disabled}>
      <legend>{t.context}</legend>
      <p className="muted small" id="agents-context-hint">
        {t.contextHint}
      </p>
      <div className="agents-context-bar">
        <input className="input" type="search" aria-label={t.filter} placeholder={t.filter} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span aria-live="polite" className="muted small">
          {t.selected(selection.length)}
        </span>
        {selection.length > 0 && (
          <button type="button" className="sec-link" onClick={() => onChange([])}>
            {t.clear}
          </button>
        )}
      </div>
      <ul className="agents-context-list" aria-describedby="agents-context-hint">
        {loaded && shown.length === 0 && <li className="muted">{t.none}</li>}
        {shown.map((row) => {
          const folder = coveredBy(selection, row.path);
          const checked = selection.includes(row.path) || folder !== undefined;
          const label = row.kind === "folder" ? t.folder(row.label, row.pages) : row.label;
          return (
            <li key={`${row.kind}:${row.path}`} style={{ paddingInlineStart: `${row.depth * 16}px` }} data-kind={row.kind}>
              <label className="xfer-check" title={row.path}>
                <input type="checkbox" checked={checked} disabled={folder !== undefined} onChange={() => toggle(row)} aria-label={label} />
                <span className={row.kind === "folder" ? "agents-folder" : undefined}>{label}</span>
                {folder !== undefined && <span className="muted small">{t.inFolder}</span>}
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
