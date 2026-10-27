import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Tab } from "../tabs/model.ts";
import { recentOf, type RecentEntry, type RecentStore } from "./recent.ts";

/**
 * The recent pages (ADR-0029), newest first. The page of the current tab is recorded when the tab becomes current or
 * starts showing another page; never on an edit.
 */
export function useRecentPages(store: RecentStore, active: Tab): readonly RecentEntry[] {
  const version = useSyncExternalStore(store.subscribe, store.version);
  const ref = recentOf(active.target);
  const key = ref ? JSON.stringify(ref) : null;
  useEffect(() => {
    if (ref) store.record(ref);
    // `key` is `ref` by value: a new object for the same page records nothing more.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, active.id, key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => store.get(), [store, version]);
}
