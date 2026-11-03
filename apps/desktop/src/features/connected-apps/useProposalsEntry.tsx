import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { ProposalsReview } from "./ProposalsReview.tsx";

/**
 * The bell's entry for proposed changes from connected apps (ADR-0048), for this window's Private Space: how many wait
 * (pending or conflicted), kept up to date by the host's `mcp.proposals` event, and the review it opens.
 */
export function useProposalsEntry(): { pinned: { count: number; title: string; body: string; onOpen(): void } | null; dialog: ReactNode } {
  const { platform, connection } = useSession();
  const apps = platform.connectedApps;
  const t = useDesktopStrings().connectedApps.proposals;
  const [count, setCount] = useState(0);
  const [reviewing, setReviewing] = useState(false);

  const refresh = useCallback(async () => {
    if (!apps) return 0;
    const { proposals } = await apps.proposals();
    return proposals.filter((p) => p.root === connection.root && (p.status === "pending" || p.status === "conflicted")).length;
  }, [apps, connection.root]);

  useEffect(() => {
    if (!apps) return;
    let live = true;
    let stop: (() => void) | undefined;
    const show = () => void refresh().then((n) => live && setCount(n), () => undefined);
    show();
    void apps.onProposals(show).then((remove) => (live ? (stop = remove) : remove()));
    return () => {
      live = false;
      stop?.();
    };
  }, [apps, refresh]);

  if (!apps) return { pinned: null, dialog: null };
  return {
    pinned: count > 0 ? { count, title: t.entry(count), body: t.entryBody, onOpen: () => setReviewing(true) } : null,
    dialog: reviewing ? <ProposalsReview connectedApps={apps} onClose={() => setReviewing(false)} /> : null,
  };
}
