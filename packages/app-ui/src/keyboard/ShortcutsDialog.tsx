import { useMemo } from "react";
import { useStrings } from "../strings/index.ts";
import { Modal } from "../ui/Modal.tsx";
import { allShortcuts, currentPlatform, differsOnWeb, formatShortcut, type Client, type Platform, type ShortcutGroup } from "./shortcuts.ts";

const GROUPS: readonly ShortcutGroup[] = ["general", "tabs", "tree", "editor"];

/**
 * Cmd/Ctrl+/: every shortcut, written from the shortcut table, so the list is what the keys do. On the web it shows
 * the keys the browser leaves to the page, and marks the ones that differ from the desktop app (and says what the
 * desktop uses); on the desktop it marks the ones that have other keys on the web.
 */
export function ShortcutsDialog({ client, platform = currentPlatform(), onClose }: { client: Client; platform?: Platform; onClose(): void }) {
  const t = useStrings().keyboard;
  const other: Client = client === "web" ? "desktop" : "web";
  const defs = allShortcuts();
  const groups = useMemo(() => GROUPS.map((group) => ({ group, items: defs.filter((d) => d.group === group) })).filter((g) => g.items.length > 0), [defs]);
  return (
    <Modal title={t.title} onClose={onClose} wide>
      <p className="muted">{t.intro}</p>
      {client === "web" && <p className="muted">{t.webNote}</p>}
      <div className="shortcut-groups">
        {groups.map(({ group, items }) => (
          <section key={group} aria-labelledby={`shortcuts-${group}`} className="shortcut-group">
            <h3 id={`shortcuts-${group}`}>{t.groups[group]}</h3>
            <dl className="shortcut-list">
              {items.map((def) => {
                const differs = differsOnWeb(def) && formatShortcut(def, "web", platform) !== formatShortcut(def, "desktop", platform);
                return (
                  <div key={def.id} className="shortcut-row" data-shortcut={def.id} {...(differs ? { "data-differs": "" } : {})}>
                    <dt>{t.names[def.id]}</dt>
                    <dd>
                      <kbd className="shortcut">{formatShortcut(def, client, platform)}</kbd>
                      {differs && <span className="muted shortcut-other">{client === "web" ? t.desktopKeys(formatShortcut(def, other, platform)) : t.webKeys(formatShortcut(def, other, platform))}</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
