import { useRef, useState, useSyncExternalStore } from "react";
import { ContextMenu, type MenuItem } from "@thoth/app-ui/order/ContextMenu.tsx";
import { focusTreeItemSoon } from "@thoth/app-ui/order/tree-keys.ts";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { tip } from "@thoth/app-ui/ui/Tooltip.tsx";
import { useShortcutHint } from "@thoth/app-ui/keyboard/hints.ts";
import { workspaceKey } from "@thoth/app-ui/workspace/directory.ts";
import { requestShowSidebar } from "@thoth/app-ui/ui/sidebar-hidden.ts";
import { useSession } from "../../app/context.ts";
import { loadSidebarLayout, saveSectionCollapsed } from "../../app/sidebar-store.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { serverSection } from "./sections.ts";

const leaf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
/** How many recent Private Spaces the menu lists; the picker has them all. */
const SHOWN = 6;

/**
 * The logo row (0.2.6): "Thoth · <this Private Space> ▾". It opens one short menu to move between spaces: the recent
 * Private Spaces (this one checked), Open folder…, the workspaces (their section opens and the row takes focus), and
 * All Private Spaces, the full picker that the logo used to open (ADR-0029, amendment of 2026-10-29).
 */
export function SpaceSwitcher({ onHome, onSwitch }: { onHome(): void; onSwitch(root: string): void }) {
  const { platform, connection, servers } = useSession();
  const t = useDesktopStrings().shell;
  const homeKeys = useShortcutHint("home.open");
  const directory = useSyncExternalStore(servers.subscribe, servers.getState);
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; recent: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    const r = button.current!.getBoundingClientRect();
    const recent = await platform.recentVaults().catch(() => [] as string[]);
    setMenu({ at: { x: r.left, y: r.bottom + 4 }, recent: [connection.root, ...recent.filter((root) => root !== connection.root)].slice(0, SHOWN) });
  };

  const pick = async () => {
    setError(null);
    try {
      const root = await platform.pickVaultFolder();
      if (root && root !== connection.root) onSwitch(root);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  /** Shows a workspace in the sidebar: its server's section and the workspace open, focus on its row. */
  const goTo = (server: string, workspace: string) => {
    requestShowSidebar();
    const section = serverSection(server);
    const collapsed = loadSidebarLayout(connection.root).collapsed;
    if (collapsed.includes(section)) saveSectionCollapsed(connection.root, collapsed.filter((id) => id !== section));
    servers.expand(server, workspace);
    focusTreeItemSoon(`${workspaceKey(server, workspace)}\n`);
  };

  const items = (recent: readonly string[]): MenuItem[] => {
    const workspaces = directory.servers.flatMap((s) => (s.workspaces ?? []).map((w) => ({ server: s.info.id, serverLabel: s.info.label, workspace: w })));
    const many = new Set(workspaces.map((w) => w.server)).size > 1;
    return [
      ...recent.map((root) => ({ id: `space:${root}`, label: leaf(root), checked: root === connection.root, onSelect: () => root !== connection.root && onSwitch(root) })),
      { id: "open-folder", label: t.switcher.openFolder, onSelect: () => void pick() },
      ...workspaces.map((w, i) => ({
        id: `ws:${w.server}:${w.workspace.id}`,
        label: many ? t.switcher.workspaceOn(w.workspace.name, w.serverLabel) : w.workspace.name,
        ...(i === 0 ? { separator: true } : {}),
        onSelect: () => goTo(w.server, w.workspace.id),
      })),
      { id: "all", label: t.switcher.all, separator: true, ...(homeKeys ? { hint: homeKeys.keys } : {}), onSelect: onHome },
    ];
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="ws-home"
        aria-label={t.switcher.label(connection.label)}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-keyshortcuts={homeKeys?.aria}
        {...tip(t.switcher.tip)}
        onClick={() => void open()}
      >
        <Mark size={18} />
        <span className="ws-name">Thoth</span>
        <span className="ws-space" title={connection.root}>
          {connection.label}
        </span>
        <svg className="ws-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 3.8L5 6.3l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menu && (
        <ContextMenu
          label={t.switcher.menu}
          at={menu.at}
          items={items(menu.recent)}
          onClose={(restore) => {
            setMenu(null);
            if (restore) button.current?.focus();
          }}
        />
      )}
      {error && (
        <p role="alert" className="tree-note tree-error">
          {error}
        </p>
      )}
    </>
  );
}
