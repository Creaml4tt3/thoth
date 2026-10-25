import { useSyncExternalStore } from "react";
import type { NotificationKind } from "@thoth/app-ui/notifications/core.ts";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import "./notifications.css";

// The new-version kind is not here: it has no system notification (ADR-0022), so it has its own switch below.
const GROUPS: { id: "agent" | "transfer" | "import" | "editor"; kinds: NotificationKind[]; agents?: true }[] = [
  { id: "agent", kinds: ["agentReview", "agentFinished", "agentFailed", "agentLimit"], agents: true },
  { id: "transfer", kinds: ["transferDone", "transferFailed"] },
  { id: "import", kinds: ["importDone", "importFailed"] },
  { id: "editor", kinds: ["saveConflict"] },
];

/** Settings → Notifications (ADR-0018): system notifications on or off, and per kind. The user's own settings. */
export function NotificationSettings() {
  const { notificationPrefs: store, agents } = useSession();
  const t = useDesktopStrings().notifications;
  const prefs = useSyncExternalStore(store.subscribe, store.get);
  return (
    <section aria-labelledby="set-notifications" className="set-section notif-settings" data-testid="notification-settings">
      <h2 id="set-notifications">{t.title}</h2>
      <div className="set-toggle">
        <input id="notif-system" type="checkbox" role="switch" checked={prefs.system} onChange={(e) => store.setSystem(e.target.checked)} aria-describedby="notif-system-hint" />
        <label htmlFor="notif-system">{t.system}</label>
        <small id="notif-system-hint" className="muted">
          {t.systemHint}
        </small>
      </div>
      <fieldset className="notif-kinds" disabled={!prefs.system}>
        <legend>{t.kinds}</legend>
        {/* The assistant's kinds are offered only where agents can run (they never happen elsewhere). */}
        {GROUPS.filter((g) => !g.agents || agents).map((group) => (
          <fieldset key={group.id} className="notif-group">
            <legend className="label">{t.groups[group.id]}</legend>
            {group.kinds.map((kind) => (
              <label key={kind} className="notif-kind">
                <input type="checkbox" checked={prefs.kinds[kind]} onChange={(e) => store.setKind(kind, e.target.checked)} />
                <span>{t.kind[kind]}</span>
              </label>
            ))}
          </fieldset>
        ))}
      </fieldset>
      {/* A new version is told in the app only, never as a system notification, so this switch is not about those. */}
      <label className="notif-kind notif-update">
        <input type="checkbox" checked={prefs.kinds.update} onChange={(e) => store.setKind("update", e.target.checked)} />
        <span>{t.updateEntry}</span>
      </label>
      <p className="muted small">{t.privacy}</p>
      <p className="muted small">{t.click}</p>
    </section>
  );
}
