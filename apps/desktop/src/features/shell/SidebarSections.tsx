/**
 * The sidebar's sections in the order the person chose (ADR-0019 amendment): the Private Space, each workspace server
 * and, where the app has it, the agents. Each is a named region with a header:
 *
 * - a grip (shown on hover and focus, always on touch screens) that is dragged to move the section and opens its menu
 *   when clicked (Move section up, Move section down);
 * - the section's name, a button that folds the section away and back (`aria-expanded`);
 * - the section's own actions.
 *
 * The header itself can be dragged too; the grip, the name and the actions keep their clicks. While a section is
 * dragged the others slide aside to open the gap where it would land (transform only), and when the drag ends each
 * slides from where it was shown to its place (FLIP; nothing moves under reduced motion). Alt/Option+Shift+Up/Down on
 * the header's grip or name moves the section one place, the Menu key or Shift+F10 opens its menu, and every move is
 * announced. The order and the folded sections are kept per Private Space (`sidebar-store.ts`).
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { HintContext } from "@thoth/app-ui/keyboard/hints.ts";
import { chordsFor, currentPlatform, formatChordShort, shortcutById } from "@thoth/app-ui/keyboard/shortcuts.ts";
import { ContextMenu, type MenuItem } from "@thoth/app-ui/order/ContextMenu.tsx";
import { Disclosure } from "@thoth/app-ui/order/icons.tsx";
import { Icon } from "@thoth/app-ui/ui/Icon.tsx";
import { motionOff } from "@thoth/app-ui/ui/presence.ts";
import { tip, tipIfClipped } from "@thoth/app-ui/ui/Tooltip.tsx";
import { loadSidebarLayout, saveSectionCollapsed, saveSectionOrder, subscribeSidebarLayout, type SidebarLayout } from "../../app/sidebar-store.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { arrangeSections, moveSection } from "./sections.ts";
import { useListDrag } from "@thoth/app-ui/order/list-drag.ts";

export interface SidebarSection {
  /** `private`, `server:<id>` or `agents` (sections.ts). */
  id: string;
  /** What the header says, and the name in the menu and the announcements. */
  name: string;
  /** The region's accessible name. */
  label: string;
  /** A longer hint on the name (for example the folder's path or the server's address). */
  title?: string;
  /** Controls at the end of the header (they keep their clicks; a press on them never drags the section). */
  actions?: ReactNode;
  /** Drop handlers for the header (the Private Space header takes workspace pages, ADR-0006 amendment). */
  drop?: Pick<HTMLAttributes<HTMLElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop">;
  /** The header is lit as the place a drop would land. */
  dropLit?: boolean;
  children: ReactNode;
}

const KEYS = "Alt+Shift+ArrowUp Alt+Shift+ArrowDown Shift+F10";
const domId = (id: string) => `thoth-section-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

/** The stored layout of `root`, read again when it changes here or in another window on the same Private Space. */
function useSidebarLayout(root: string): SidebarLayout {
  const [layout, setLayout] = useState(() => loadSidebarLayout(root));
  useEffect(() => {
    setLayout(loadSidebarLayout(root));
    return subscribeSidebarLayout(root, () => setLayout(loadSidebarLayout(root)));
  }, [root]);
  return layout;
}

/** The motion tokens the sections slide with (0 under reduced motion, where the tokens are 0). */
function slideTiming(el: Element): { duration: number; easing: string } {
  const style = getComputedStyle(el);
  const raw = style.getPropertyValue("--thoth-dur-fast").trim();
  const n = Number.parseFloat(raw);
  const duration = raw === "" || Number.isNaN(n) ? 140 : raw.endsWith("ms") ? n : n * 1000;
  return { duration, easing: style.getPropertyValue("--thoth-ease-out").trim() || "cubic-bezier(0.2, 0.8, 0.2, 1)" };
}

export function SidebarSections({ root, sections }: { root: string; sections: readonly SidebarSection[] }) {
  const t = useDesktopStrings().shell;
  const platform = useContext(HintContext)?.platform ?? currentPlatform();
  const layout = useSidebarLayout(root);
  const present = sections.map((s) => s.id);
  const order = arrangeSections(layout.order, present);
  const byId = new Map(sections.map((s) => [s.id, s]));
  const collapsed = new Set(layout.collapsed);
  const host = useRef<HTMLDivElement>(null);
  const boxes = useRef(new Map<string, HTMLElement>());
  const flip = useRef<Map<string, number> | null>(null);
  const [said, setSaid] = useState("");
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number }; from: "grip" | "toggle" } | null>(null);

  const rememberPlaces = () => {
    if (motionOff()) return;
    const places = new Map<string, number>();
    for (const [key, el] of boxes.current) places.set(key, el.getBoundingClientRect().top);
    flip.current = places;
  };

  // FLIP: each section shown somewhere else (moved, or shifted by the drag) slides from there to its place.
  useLayoutEffect(() => {
    const first = flip.current;
    flip.current = null;
    if (!first || !host.current) return;
    const timing = slideTiming(host.current);
    if (timing.duration <= 0) return;
    for (const [id, el] of boxes.current) {
      const was = first.get(id);
      if (was === undefined) continue;
      const dy = was - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) continue;
      el.animate?.([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration: timing.duration, easing: timing.easing });
    }
  });

  /** Moves a section to index `to` of what is shown, stores the order and says so. */
  const move = (id: string, to: number) => {
    const at = Math.max(0, Math.min(to, order.length - 1));
    if (at === order.indexOf(id)) return false;
    saveSectionOrder(root, moveSection(layout.order, present, id, at));
    setSaid(t.sectionMoved(byId.get(id)?.name ?? id, at + 1, order.length));
    return true;
  };

  /** The grip or the name button of a section. */
  const control = (id: string, part: "grip" | "toggle") => [...(host.current?.querySelectorAll<HTMLElement>("[data-section]") ?? [])].find((el) => el.dataset["section"] === id)?.querySelector<HTMLElement>(`.sec-${part}`) ?? null;
  /** After the sections re-render (React moving a focused node can drop its focus), the same control has focus again. */
  const focusSoon = (id: string, part: "grip" | "toggle") => setTimeout(() => control(id, part)?.focus(), 0);

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    saveSectionCollapsed(root, [...next]);
  };

  const { drag, onPointerDown, swallowClick } = useListDrag({
    order,
    scroller: () => host.current?.closest<HTMLElement>(".tree-wrap") ?? host.current,
    item: (id) => boxes.current.get(id) ?? null,
    onMove: (id, to) => void move(id, to),
    onEnd: rememberPlaces,
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    const part = (event.target as Element).closest(".sec-grip") ? "grip" : (event.target as Element).closest(".sec-toggle") ? "toggle" : null;
    if (!part) return; // the section's own actions keep their keys
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      handled();
      if (move(id, order.indexOf(id) + (event.key === "ArrowDown" ? 1 : -1))) focusSoon(id, part);
      return;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)) {
      handled();
      const r = (event.target as Element).getBoundingClientRect();
      setMenu({ id, at: { x: r.left + 8, y: r.bottom }, from: part });
    }
  };

  const menuItems = (id: string): MenuItem[] => {
    const at = order.indexOf(id);
    const def = shortcutById("section.move");
    const keys = def ? chordsFor(def, "desktop").map((c) => formatChordShort(c, platform)) : [];
    return [
      { id: "up", label: t.moveSectionUp, ...(keys[0] ? { hint: keys[0] } : {}), disabled: at <= 0, onSelect: () => (move(id, at - 1), focusSoon(id, menu?.from ?? "grip")) },
      { id: "down", label: t.moveSectionDown, ...(keys[1] ? { hint: keys[1] } : {}), disabled: at >= order.length - 1, onSelect: () => (move(id, at + 1), focusSoon(id, menu?.from ?? "grip")) },
    ];
  };

  return (
    <div ref={host} className="side-sections" data-section-dragging={drag ? "" : undefined}>
      {order.map((id) => {
        const s = byId.get(id)!;
        const folded = collapsed.has(id);
        const shift = drag?.shifts[id];
        const body = `${domId(id)}-body`;
        return (
          <section
            key={id}
            ref={(el) => {
              if (el) boxes.current.set(id, el);
              else boxes.current.delete(id);
            }}
            className="side-section"
            data-section={id}
            aria-label={s.label}
            data-dragging={drag?.id === id ? "" : undefined}
            data-collapsed={folded || undefined}
            style={shift === undefined ? undefined : { transform: `translateY(${shift}px)` }}
          >
            <div
              className={s.drop ? "sec sec-drop" : "sec"}
              data-drop={s.dropLit ? "inside" : undefined}
              {...s.drop}
              onPointerDown={(event) => onPointerDown(event, id)}
              onKeyDown={(event) => onKeyDown(event, id)}
              onContextMenu={(event) => {
                if ((event.target as Element).closest(".sec-actions")) return;
                event.preventDefault();
                setMenu({ id, at: { x: event.clientX, y: event.clientY }, from: "grip" });
              }}
            >
              <button
                type="button"
                className="sec-toggle"
                aria-expanded={!folded}
                aria-controls={body}
                aria-keyshortcuts={KEYS}
                onClick={() => {
                  if (swallowClick.current) return;
                  toggle(id);
                }}
              >
                <Disclosure open={!folded} />
                <span className="sec-name" {...(s.title ? { title: s.title } : {})} {...tipIfClipped(s.name)}>
                  {s.name}
                </span>
              </button>
              {/* After the name, so showing it on hover moves nothing that is read. */}
              <button
                type="button"
                className="sec-grip"
                aria-label={t.sectionOptions(s.name)}
                aria-haspopup="menu"
                aria-keyshortcuts={KEYS}
                {...tip(t.sectionGripTip)}
                onClick={(event) => {
                  if (swallowClick.current) return;
                  const r = event.currentTarget.getBoundingClientRect();
                  setMenu({ id, at: { x: r.left, y: r.bottom }, from: "grip" });
                }}
              >
                <Icon name="grip" size={14} />
              </button>
              {s.actions && <span className="sec-actions">{s.actions}</span>}
            </div>
            <div id={body} className="side-section-body" hidden={folded}>
              {s.children}
            </div>
          </section>
        );
      })}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-sections-said="">
        {said}
      </div>
      {menu && byId.has(menu.id) && (
        <ContextMenu
          label={t.sectionMenu(byId.get(menu.id)!.name)}
          at={menu.at}
          items={menuItems(menu.id)}
          onClose={(restore) => {
            const { id, from } = menu;
            setMenu(null);
            if (restore) control(id, from)?.focus();
          }}
        />
      )}
    </div>
  );
}
