/**
 * Review of the changes connected apps proposed for this window's Private Space (ADR-0048), opened from the bell:
 * per proposal the app's name, when, the page, a diff (the Agent Hub's, ADR-0007) and Apply / Decline, grouped by app
 * with "Apply all from <app>". Each Apply is checked on its own with compare-and-swap (`apply.ts`); a page that changed
 * meanwhile shows its diff against the page as it is now, to decline or to apply anyway on purpose.
 */
import { useCallback, useEffect, useState } from "react";
import type { ConnectedAppProposalText, ConnectedApps } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { DiffView } from "../agents/Review.tsx";
import { applyProposal, currentPage, type CurrentPage } from "./apply.ts";
import "../agents/agents.css";
import "./connected-apps.css";

interface Item {
  proposal: ConnectedAppProposalText;
  /** For a conflicted one: the page as it is now (null: no file there). */
  current?: CurrentPage | null;
  error?: string | undefined;
}

/** The open proposals of the Private Space at `root`, with their text, oldest first. */
async function load(apps: ConnectedApps, root: string, read: (path: string) => Promise<CurrentPage | null>): Promise<Item[]> {
  const { proposals } = await apps.proposals();
  const open = proposals.filter((p) => p.root === root && (p.status === "pending" || p.status === "conflicted"));
  const items = await Promise.all(
    open.map(async (summary): Promise<Item | null> => {
      const proposal = await apps.proposal(summary.id).catch(() => null);
      if (!proposal || proposal.after === null) return null;
      return proposal.status === "conflicted" ? { proposal, current: await read(proposal.path) } : { proposal };
    }),
  );
  return items.filter((i): i is Item => i !== null);
}

export function ProposalsReview({ connectedApps, onClose }: { connectedApps: ConnectedApps; onClose(): void }) {
  const { vault, connection } = useSession();
  const t = useDesktopStrings().connectedApps.proposals;
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const reload = useCallback(() => load(connectedApps, connection.root, (path) => currentPage(vault, path)).then(setItems, () => setItems([])), [connectedApps, connection.root, vault]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const update = (id: string, change: Partial<Item> | null) =>
    setItems((list) => (list ?? []).flatMap((i) => (i.proposal.id !== id ? [i] : change === null ? [] : [{ ...i, ...change }])));

  /** Applies one; `over` only after the user saw the diff against the page as it is now. */
  const apply = async (item: Item, over?: CurrentPage | null) => {
    try {
      const outcome = await applyProposal(vault, connectedApps, item.proposal, over);
      if (outcome.status === "applied") {
        update(item.proposal.id, null);
        setStatus(t.applied(item.proposal.path));
      } else {
        update(item.proposal.id, { proposal: { ...item.proposal, status: "conflicted" }, current: outcome.current, error: undefined });
      }
    } catch (error) {
      update(item.proposal.id, { error: t.failed(error instanceof Error ? error.message : String(error)) });
    }
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setStatus("");
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  const decline = (item: Item) =>
    run(async () => {
      await connectedApps.settle(item.proposal.id, "declined").catch(() => undefined);
      update(item.proposal.id, null);
    });
  const applyAll = (app: string) =>
    run(async () => {
      // One by one, each checked on its own: a page that changed becomes conflicted and the rest go on.
      for (const item of (items ?? []).filter((i) => i.proposal.app === app && i.proposal.status === "pending")) await apply(item);
    });

  const apps = [...new Set((items ?? []).map((i) => i.proposal.app))];
  return (
    <Modal title={t.title} onClose={onClose} wide>
      <div className="mcp-review" data-testid="mcp-proposals">
        <p className="muted">{t.lede}</p>
        <p role="status" className="muted small">
          {status}
        </p>
        {items === null ? (
          <p className="muted">{t.loading}</p>
        ) : items.length === 0 ? (
          <p className="muted">{t.none}</p>
        ) : (
          apps.map((app) => {
            const group = items.filter((i) => i.proposal.app === app);
            const pending = group.filter((i) => i.proposal.status === "pending").length;
            return (
              <section key={app} className="mcp-review-app" aria-label={t.from(app)}>
                <div className="agents-change-head">
                  <h3>{t.from(app)}</h3>
                  {pending > 1 && (
                    <Button variant="ghost" small disabled={busy} onClick={() => void applyAll(app)}>
                      {t.applyAll(app)}
                    </Button>
                  )}
                </div>
                <ul className="agents-changes">
                  {group.map((item) => (
                    <Proposal key={item.proposal.id} item={item} busy={busy} onApply={(over) => void run(() => apply(item, over))} onDecline={() => void decline(item)} />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </Modal>
  );
}

function Proposal({ item, busy, onApply, onDecline }: { item: Item; busy: boolean; onApply(over?: CurrentPage | null): void; onDecline(): void }) {
  const t = useDesktopStrings().connectedApps.proposals;
  const { proposal, current } = item;
  const conflicted = proposal.status === "conflicted";
  const when = new Date(proposal.createdAt);
  // A new page that cannot be made (a file is there now) can only be declined.
  const blocked = conflicted && proposal.kind === "create";
  return (
    <li className="agents-change mcp-proposal" aria-label={t.label(proposal.path)} data-status={proposal.status}>
      <div className="agents-change-head">
        <b className="mono agents-path">{proposal.path}</b>
        <span className="badge badge-muted" data-kind={proposal.kind === "create" ? "added" : "modified"}>
          {t.kinds[proposal.kind]}
        </span>
      </div>
      <p className="muted small">
        {proposal.app} · <time dateTime={proposal.createdAt}>{Number.isNaN(when.getTime()) ? proposal.createdAt : t.when(when)}</time>
      </p>
      {conflicted && (
        <p className="alert alert-warning small" role="note">
          {blocked ? t.conflictExists : t.conflict}
        </p>
      )}
      {item.error && (
        <p className="alert alert-danger small" role="alert">
          {item.error}
        </p>
      )}
      {!blocked && <DiffView path={proposal.path} before={conflicted ? (current?.source ?? null) : proposal.before} after={proposal.after} />}
      <div className="set-actions">
        {!blocked && (
          <Button variant="primary" small disabled={busy} onClick={() => onApply(conflicted ? (current ?? null) : undefined)}>
            {conflicted ? t.applyAnyway : t.apply}
          </Button>
        )}
        <Button variant="ghost" small disabled={busy} onClick={onDecline}>
          {t.decline}
        </Button>
      </div>
    </li>
  );
}
