import { describe, expect, it } from "vitest";
import type { ReconcileReport } from "@thoth/local-store";
import { createReconciler } from "../src/app/reconciler.ts";

const empty: ReconcileReport = { added: [], updated: [], removed: [], unchanged: 0, warnings: [], recoveredJournalEntries: 0 };

function setup() {
  const runs: unknown[] = [];
  const reconciler = createReconciler(
    {
      reconcile: async (options?: unknown) => {
        runs.push(options);
        return empty;
      },
    },
    { debounceMs: 1, onReconciled: () => undefined, onError: () => undefined },
  );
  return { runs, reconciler };
}

describe("reconciler", () => {
  it("passes a burst's changed paths along, once each", async () => {
    const { runs, reconciler } = setup();
    reconciler.trigger({ rescan: false, paths: ["A.md"] });
    reconciler.trigger({ rescan: false, paths: ["A.md", "B.md"] });
    await reconciler.idle();
    expect(runs).toEqual([{ changed: ["A.md", "B.md"] }]);
  });

  it("checks everything when an event names no paths, and fully on a rescan", async () => {
    const { runs, reconciler } = setup();
    reconciler.trigger({ rescan: false, paths: ["A.md"] });
    reconciler.trigger({ rescan: false, paths: [] });
    await reconciler.idle();
    reconciler.trigger({ rescan: true, paths: ["A.md"] });
    await reconciler.idle();
    reconciler.trigger({ rescan: false, paths: ["C.md"] });
    await reconciler.idle();
    expect(runs).toEqual([{}, { full: true }, { changed: ["C.md"] }]);
  });
});
