/**
 * Picks what an agent gets (ADR-0007, "Context"). Private Space: a checkbox list of pages and folders in tree order
 * with a filter (checking a folder includes everything in it, Space toggles, Tab moves on), or the whole Private
 * Space; the agent may edit these, and the total that will be copied is shown before starting. Workspaces: pages the
 * user may copy out of a workspace, added one by one; they reach the agent as read-only reference copies. Nothing is
 * read here but the page list and sizes; staging copies the files when the task starts.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { PageSummary } from "@thoth/domain";
import { workspaceContextAccess, DEFAULT_STAGING_LIMITS } from "@thoth/agent-core";
import { workspaceKey, type ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import type { Workspace } from "@thoth/workspace-protocol";
import { nestWorkspaceTree, type WorkspaceTreeItem } from "@thoth/app-ui/workspace/tree.ts";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { buildTree, type TreeNode } from "../shell/tree.ts";
import { bytes } from "./Review.tsx";
import type { AgentsService, AgentsState } from "./service.ts";
import { workspaceChoiceKey } from "./service.ts";

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

export function ContextPicker({ state, agents, disabled }: { state: AgentsState; agents: AgentsService; disabled?: boolean }) {
  const { vault, revision } = useSession();
  const t = useDesktopStrings().agents.form;
  const { selection, wholeSpace } = state.draft;
  const onChange = (next: string[]) => agents.setDraft({ selection: next });
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

  // The total follows the vault: pages edited or added while the form is open change it.
  useEffect(() => {
    void agents.refreshPreview();
  }, [agents, revision]);

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

  const preview = state.preview;
  const limitsText = t.totalLimits(DEFAULT_STAGING_LIMITS.maxFiles, bytes(DEFAULT_STAGING_LIMITS.maxTotalBytes));

  // Permissions only narrow: what they switch off is not offered at all (and is refused at Start as well).
  const { allowPrivate, allowWholeSpace, allowWorkspace } = state.settings;
  return (
    <>
      {(allowPrivate || allowWholeSpace) && (
        <fieldset className="agents-context" disabled={disabled}>
          <legend>{t.context}</legend>
          {allowPrivate && (
            <p className="muted small" id="agents-context-hint">
              {t.contextHint}
            </p>
          )}
          {allowWholeSpace && (
            <>
              <label className="xfer-check agents-whole">
                <input type="checkbox" checked={wholeSpace} onChange={(e) => agents.setDraft({ wholeSpace: e.target.checked })} aria-describedby="agents-whole-hint" />
                <span>{t.wholeSpace}</span>
              </label>
              <p className="muted small" id="agents-whole-hint">
                {t.wholeSpaceHint}
              </p>
            </>
          )}
          {allowPrivate && (
            <>
              <div className="agents-context-bar">
                <input className="input" type="search" aria-label={t.filter} placeholder={t.filter} value={filter} onChange={(e) => setFilter(e.target.value)} disabled={wholeSpace} />
                <span aria-live="polite" className="muted small">
                  {wholeSpace ? t.wholeSpaceOn : t.selected(selection.length)}
                </span>
                {selection.length > 0 && !wholeSpace && (
                  <button type="button" className="sec-link" onClick={() => onChange([])}>
                    {t.clear}
                  </button>
                )}
              </div>
              <ul className="agents-context-list" aria-describedby="agents-context-hint">
                {loaded && shown.length === 0 && <li className="muted">{t.none}</li>}
                {shown.map((row) => {
                  const folder = coveredBy(selection, row.path);
                  const checked = wholeSpace || selection.includes(row.path) || folder !== undefined;
                  const label = row.kind === "folder" ? t.folder(row.label, row.pages) : row.label;
                  return (
                    <li key={`${row.kind}:${row.path}`} style={{ paddingInlineStart: `${row.depth * 16}px` }} data-kind={row.kind}>
                      <label className="xfer-check" title={row.path}>
                        <input type="checkbox" checked={checked} disabled={wholeSpace || folder !== undefined} onChange={() => toggle(row)} aria-label={label} />
                        <span className={row.kind === "folder" ? "agents-folder" : undefined}>{label}</span>
                        {folder !== undefined && !wholeSpace && <span className="muted small">{t.inFolder}</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <p className="small agents-total" role="status" data-testid="agent-total" data-problem={preview?.problem?.code}>
            {preview && (wholeSpace || selection.length > 0) ? (
              <>
                {t.total(preview.files, bytes(preview.bytes))}
                {preview.problem && (preview.problem.code === "too_many" || preview.problem.code === "too_large" || preview.problem.code === "file_too_large") ? ` · ${limitsText}` : ""}
              </>
            ) : (
              <span className="muted">{t.totalNone}</span>
            )}
          </p>
        </fieldset>
      )}
      {allowWorkspace && <WorkspacePicker state={state} agents={agents} disabled={disabled} />}
    </>
  );
}

/** Pages of one workspace, nested; a folder page has no text of its own worth giving, so only pages are offered. */
function PageList({ items, depth, workspace, server, workspaceName, state, agents, disabled }: { items: readonly WorkspaceTreeItem[]; depth: number; workspace: string; server: string; workspaceName: string; state: AgentsState; agents: AgentsService; disabled: boolean }) {
  return (
    <>
      {items.map((item) => {
        const choice = { server, workspace, page: item.id, title: item.title, workspaceName };
        const key = workspaceChoiceKey(choice);
        const chosen = state.draft.workspace.some((c) => workspaceChoiceKey(c) === key);
        return (
          <li key={item.id} style={{ paddingInlineStart: `${depth * 16}px` }}>
            {item.folder ? (
              <span className="agents-folder muted">{item.title}</span>
            ) : (
              <label className="xfer-check">
                <input type="checkbox" checked={chosen} disabled={disabled} aria-label={item.title} onChange={(e) => (e.target.checked ? agents.addWorkspacePage(choice) : agents.removeWorkspacePage(key))} />
                <span>{item.title}</span>
              </label>
            )}
            {item.children.length > 0 && (
              <ul className="agents-context-list">
                <PageList items={item.children} depth={depth + 1} workspace={workspace} server={server} workspaceName={workspaceName} state={state} agents={agents} disabled={disabled} />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

function WorkspaceBlock({ servers, server, workspace, state, agents, disabled }: { servers: ServerDirectory; server: string; workspace: Workspace; state: AgentsState; agents: AgentsService; disabled: boolean }) {
  const t = useDesktopStrings().agents.form;
  const dir = useSyncExternalStore(servers.subscribe, servers.getState);
  const [open, setOpen] = useState(false);
  const access = workspaceContextAccess(workspace);
  const tree = dir.trees[workspaceKey(server, workspace.id)];
  const items = useMemo(
    () => (tree ? nestWorkspaceTree(tree.nodes, { ordered: servers.canOrder(server), isFolder: (id) => tree.kinds[id]?.folder ?? false }) : []),
    [tree, servers, server],
  );
  return (
    <li>
      <details
        open={open}
        onToggle={(e) => {
          const now = (e.currentTarget as HTMLDetailsElement).open;
          if (now === open) return;
          setOpen(now);
          if (now && access === "allowed") servers.expand(server, workspace.id);
          else if (!now) servers.collapse(server, workspace.id);
        }}
      >
        <summary>
          <span>{workspace.name}</span>
          {access !== "allowed" && <span className="muted small"> · {t.workspaceBlocked(access)}</span>}
        </summary>
        {access !== "allowed" ? (
          <p className="muted small" role="note">
            {t.workspaceBlocked(access)}
          </p>
        ) : !tree || tree.loading ? (
          <p className="muted small" role="status">
            {t.workspaceLoading}
          </p>
        ) : items.length === 0 ? (
          <p className="muted small">{t.workspaceEmpty}</p>
        ) : (
          <ul className="agents-context-list" aria-label={workspace.name}>
            <PageList items={items} depth={0} workspace={workspace.id} server={server} workspaceName={workspace.name} state={state} agents={agents} disabled={disabled} />
          </ul>
        )}
      </details>
    </li>
  );
}

/** Workspace pages as read-only context: the workspaces the user may copy pages out of, and the pages chosen so far. */
function WorkspacePicker({ state, agents, disabled }: { state: AgentsState; agents: AgentsService; disabled: boolean | undefined }) {
  const { servers } = useSession();
  const t = useDesktopStrings().agents.form;
  const dir = useSyncExternalStore(servers.subscribe, servers.getState);
  const available = dir.servers.filter((s) => s.info.auth !== "signed-out" && (s.workspaces?.length ?? 0) > 0);
  const chosen = state.draft.workspace;
  return (
    <fieldset className="agents-context agents-workspace" disabled={disabled}>
      <legend>{t.workspace}</legend>
      <p className="muted small">{t.workspaceHint}</p>
      {available.length === 0 ? (
        <p className="muted small">{t.workspaceNone}</p>
      ) : (
        <ul className="agents-workspaces">
          {available.flatMap((s) =>
            (s.workspaces ?? []).map((w) => <WorkspaceBlock key={`${s.info.id}/${w.id}`} servers={servers} server={s.info.id} workspace={w} state={state} agents={agents} disabled={disabled ?? false} />),
          )}
        </ul>
      )}
      {chosen.length > 0 && (
        <div className="agents-chosen">
          <p className="small" aria-live="polite">
            {t.workspaceAdded(chosen.length)}
          </p>
          <ul className="xfer-list small">
            {chosen.map((c) => (
              <li key={workspaceChoiceKey(c)}>
                <span>{t.workspacePage(c.title, c.workspaceName)}</span>{" "}
                <button type="button" className="sec-link" aria-label={t.workspaceRemove(c.title)} onClick={() => agents.removeWorkspacePage(workspaceChoiceKey(c))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}
