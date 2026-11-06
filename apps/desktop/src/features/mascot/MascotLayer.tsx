import { lazy, Suspense, useSyncExternalStore } from "react";
import { useSession } from "../../app/context.ts";

// The mascot's drawing and bubble load once it is shown, not with the app: it can be switched off, and it is not on
// screen before the Private Space is.
const MascotShown = lazy(() => import("./Mascot.tsx").then((m) => ({ default: m.MascotShown })));

/** Mount once in the shell. Nothing on the web, nothing where agents cannot run, nothing when switched off. */
export function MascotLayer() {
  const { agents, assistant } = useSession();
  const prefs = useSyncExternalStore(assistant?.prefs.subscribe ?? (() => () => undefined), () => assistant?.prefs.get() ?? null);
  if (!agents || !assistant || !prefs?.show) return null;
  return (
    <Suspense fallback={null}>
      <MascotShown agents={agents} assistant={assistant} />
    </Suspense>
  );
}
