/**
 * Team memory in the desktop app (ADR-0052 rule 8):
 * - `TeamMemorySettings`: in Settings → Connected apps, the workspaces whose Team memory apps may use, and for owners
 *   and managers the workspace's "Agents' memories need review".
 * - `useTeamMemoryEntry`: the bell's entry for agents' memories waiting in the user's workspaces (their own agents',
 *   and for owners and managers everyone's), and the review it opens, with the activity for owners and managers.
 * Every call goes to the workspace's server as the signed-in user; the server decides who sees and settles what.
 */
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ConnectedApps, ConnectedAppsSettings } from "@thoth/platform";
import type { ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { roleCan, type TeamMemoryProposal, type Workspace } from "@thoth/workspace-protocol";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { DiffView } from "../agents/Review.tsx";
import "../agents/agents.css";
import "./connected-apps.css";

/** How often the bell asks the servers again. */
const POLL_MS = 5 * 60_000;
/** Asked by Connected apps when an agent proposed a team memory from this window. */
export const TEAM_MEMORY_CHANGED = "thoth:team-memory-changed";

interface Place {
  server: string;
  serverLabel: string;
  workspace: Workspace;
}

/** The workspaces of signed-in servers that list `team-memory`, where the user is an editor or above. */
function places(directory: ReturnType<ServerDirectory["getState"]>, need: "write" | "read" = "write"): Place[] {
  return directory.servers.flatMap((s) =>
    (directory.capabilities[s.info.id] ?? []).includes("team-memory")
      ? (s.workspaces ?? []).filter((w) => roleCan(w.role, need)).map((workspace) => ({ server: s.info.id, serverLabel: s.info.label, workspace }))
      : [],
  );
}

export function TeamMemorySettings({ connectedApps, settings, onChange }: { connectedApps: ConnectedApps; settings: ConnectedAppsSettings; onChange(next: ConnectedAppsSettings): void }) {
  const { servers } = useSession();
  const t = useDesktopStrings().connectedApps.team;
  const directory = useSyncExternalStore(servers.subscribe, servers.getState);
  const list = places(directory, "read");
  const [reviews, setReviews] = useState<Record<string, boolean>>({});
  const [failure, setFailure] = useState("");
  const shared = settings.workspaces ?? [];
  const key = (p: Place) => `${p.server}\n${p.workspace.id}`;
  const listKey = list.map(key).join("|");

  useEffect(() => {
    let live = true;
    for (const p of list.filter((p) => roleCan(p.workspace.role, "manage")))
      void servers
        .client(p.server)
        .getTeamMemory(p.workspace.id)
        .then((s) => live && setReviews((r) => ({ ...r, [key(p)]: s.review })), () => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `listKey` names the list
  }, [servers, listKey]);

  const toggle = (p: Place, on: boolean) => {
    const others = shared.filter((w) => !(w.server === p.server && w.workspace === p.workspace.id));
    // Apps give the workspace's name; a second one of that name says its server.
    const taken = new Set(others.map((w) => w.name));
    const name = taken.has(p.workspace.name) ? `${p.workspace.name} (${p.serverLabel})` : p.workspace.name;
    const workspaces = on ? [...others, { server: p.server, workspace: p.workspace.id, name }] : others;
    void connectedApps.configure({ workspaces }).then(onChange, (e: unknown) => setFailure(t.failed(e instanceof Error ? e.message : String(e))));
  };
  const setReview = (p: Place, review: boolean) =>
    void servers
      .client(p.server)
      .setTeamMemoryReview(p.workspace.id, review)
      .then((s) => setReviews((r) => ({ ...r, [key(p)]: s.review })), (e: unknown) => setFailure(t.failed(e instanceof Error ? e.message : String(e))));

  return (
    <>
      <h3 id="set-mcp-team">{t.title}</h3>
      <p className="muted small">{t.hint}</p>
      {failure && (
        <p role="alert" className="alert alert-danger small">
          {failure}
        </p>
      )}
      {list.length === 0 ? (
        <p className="muted small">{t.none}</p>
      ) : (
        <ul className="mcp-apps" aria-labelledby="set-mcp-team">
          {list.map((p, i) => {
            const on = shared.find((w) => w.server === p.server && w.workspace === p.workspace.id);
            return (
              <li key={key(p)} className="mcp-app mcp-team" aria-label={p.workspace.name}>
                <label className="mcp-space">
                  <input type="checkbox" checked={on !== undefined} onChange={(e) => toggle(p, e.target.checked)} />
                  <span className="mcp-space-name">{p.workspace.name}</span>
                  <span className="muted small">{p.serverLabel}</span>
                </label>
                {on && <span className="muted small">{t.space(on.name)}</span>}
                {roleCan(p.workspace.role, "manage") && reviews[key(p)] !== undefined && (
                  <span className="set-toggle mcp-app-propose">
                    <input id={`mcp-team-review-${i}`} type="checkbox" role="switch" checked={reviews[key(p)]} onChange={(e) => setReview(p, e.target.checked)} aria-describedby={`mcp-team-review-hint-${i}`} />
                    <label htmlFor={`mcp-team-review-${i}`}>{t.review}</label>
                    <small id={`mcp-team-review-hint-${i}`} className="muted">
                      {t.reviewHint}
                    </small>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

interface Waiting {
  place: Place;
  proposal: TeamMemoryProposal;
}

async function pending(servers: ServerDirectory, list: Place[]): Promise<Waiting[]> {
  const found = await Promise.all(
    list.map((place) =>
      servers
        .client(place.server)
        .listTeamMemoryProposals(place.workspace.id, "pending")
        .then((items) => items.map((proposal) => ({ place, proposal })), () => []),
    ),
  );
  return found.flat();
}

/** The bell's entry for team memories waiting for review, kept up to date every few minutes and after an agent's. */
export function useTeamMemoryEntry(): { pinned: { count: number; title: string; body: string; onOpen(): void } | null; dialog: ReactNode } {
  const { servers } = useSession();
  const t = useDesktopStrings().connectedApps.team;
  const directory = useSyncExternalStore(servers.subscribe, servers.getState);
  const list = places(directory);
  const listKey = list.map((p) => `${p.server}\n${p.workspace.id}`).join("|");
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => void pending(servers, list).then((w) => setCount(w.length)), [servers, listKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (list.length === 0) return setCount(0);
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    window.addEventListener(TEAM_MEMORY_CHANGED, refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener(TEAM_MEMORY_CHANGED, refresh);
    };
  }, [refresh, list.length]);

  return {
    pinned: count > 0 ? { count, title: t.entry(count), body: t.entryBody, onOpen: () => setOpen(true) } : null,
    dialog: open ? (
      <TeamMemoryReview
        places={list}
        onClose={() => {
          setOpen(false);
          refresh();
        }}
      />
    ) : null,
  };
}

interface Item extends Waiting {
  markdown: string | null;
  /** The page as it is now, for a change. */
  current: string | null;
  error?: string;
}

function TeamMemoryReview({ places: given, onClose }: { places: Place[]; onClose(): void }) {
  const { servers } = useSession();
  // The workspaces as the review opened: a new directory state does not load it again.
  const [list] = useState(given);
  const t = useDesktopStrings().connectedApps.team;
  const [items, setItems] = useState<Item[] | null>(null);
  const [activity, setActivity] = useState<Waiting[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void pending(servers, list).then(async (waiting) => {
      const loaded = await Promise.all(
        waiting.map(async (w): Promise<Item> => {
          const client = servers.client(w.place.server);
          const full = await client.getTeamMemoryProposal(w.place.workspace.id, w.proposal.id).catch(() => null);
          const current = w.proposal.pageId ? await client.getPage(w.place.workspace.id, w.proposal.pageId).then((p) => p.markdown, () => null) : null;
          return { ...w, markdown: full?.markdown ?? null, current };
        }),
      );
      if (live) setItems(loaded.filter((i) => i.markdown !== null));
    });
    // The activity: what was applied lately, for owners and managers.
    const managed = list.filter((p) => roleCan(p.workspace.role, "manage"));
    void Promise.all(managed.map((place) => servers.client(place.server).listTeamMemoryProposals(place.workspace.id, "applied").then((ps) => ps.slice(0, 10).map((proposal) => ({ place, proposal })), () => []))).then(
      (found) => live && setActivity(found.flat()),
    );
    return () => {
      live = false;
    };
  }, [servers, list]);

  const settle = async (item: Item, action: "apply" | "decline") => {
    setBusy(true);
    setStatus("");
    try {
      await servers.client(item.place.server).settleTeamMemoryProposal(item.place.workspace.id, item.proposal.id, action);
      setItems((all) => (all ?? []).filter((i) => i.proposal.id !== item.proposal.id));
      setStatus(action === "apply" ? t.applied(item.proposal.title) : t.declined(item.proposal.title));
      if (action === "apply") void servers.loadTree(item.place.server, item.place.workspace.id).catch(() => undefined);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const text = code === "revision_conflict" ? t.changed : t.failed(error instanceof Error ? error.message : String(error));
      setItems((all) => (all ?? []).map((i) => (i.proposal.id === item.proposal.id ? { ...i, error: text } : i)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t.dialog} onClose={onClose} wide>
      <div className="mcp-review" data-testid="mcp-team-memories">
        <p className="muted">{t.lede}</p>
        <p role="status" className="muted small">
          {status}
        </p>
        {items === null ? (
          <p className="muted">{t.loading}</p>
        ) : items.length === 0 ? (
          <p className="muted">{t.empty}</p>
        ) : (
          <ul className="agents-changes">
            {items.map((item) => (
              <li key={item.proposal.id} className="agents-change mcp-proposal" aria-label={item.proposal.title}>
                <div className="agents-change-head">
                  <b className="agents-path">{item.proposal.title}</b>
                  <span className="badge badge-muted">{item.proposal.pageId ? t.changes : t.adds}</span>
                </div>
                <p className="muted small">
                  {item.place.workspace.name} · {t.from(item.proposal.agent, item.proposal.authorName)}
                </p>
                {item.error && (
                  <p className="alert alert-danger small" role="alert">
                    {item.error}
                  </p>
                )}
                <DiffView path={item.proposal.title} before={item.current} after={item.markdown} />
                <div className="set-actions">
                  <Button variant="primary" small disabled={busy} onClick={() => void settle(item, "apply")}>
                    {t.apply}
                  </Button>
                  <Button variant="ghost" small disabled={busy} onClick={() => void settle(item, "decline")}>
                    {t.decline}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {activity.length > 0 && (
          <section className="mcp-review-app" aria-labelledby="mcp-team-activity">
            <h3 id="mcp-team-activity">{t.activity}</h3>
            <ul className="mcp-memory-list">
              {activity.map(({ place, proposal }) => (
                <li key={proposal.id} className="mcp-memory">
                  <span>{t.activityLine(proposal.title, proposal.agent, proposal.authorName ?? t.someone, proposal.settledByName ?? t.someone)}</span>
                  <span className="muted small">
                    {place.workspace.name} · <time dateTime={proposal.settledAt ?? proposal.createdAt}>{new Date(proposal.settledAt ?? proposal.createdAt).toLocaleString()}</time>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
