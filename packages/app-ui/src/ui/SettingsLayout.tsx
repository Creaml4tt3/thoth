import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useStrings } from "../strings/index.ts";
import { motionOff } from "./presence.ts";

export interface SettingsSectionLink {
  /** The id of the section's heading (`<h2 id>`). */
  id: string;
  label: string;
}

/**
 * Settings as one long page with a list of its sections beside it (above it in a narrow window). A link scrolls to
 * its section (at once under reduced motion) and moves focus to the heading; the section in view is marked
 * `aria-current`. Sections whose heading is not on the page (a feature this build lacks) are left out of the list.
 */
export function SettingsLayout({ sections, children }: { sections: readonly SettingsSectionLink[]; children: ReactNode }) {
  const t = useStrings().settingsNav;
  const content = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState<readonly string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const wanted = sections.map((s) => s.id).join("\n");

  // Which headings are on the page; some sections show up later (they load their state first).
  useLayoutEffect(() => {
    const box = content.current;
    if (!box) return;
    const ids = wanted.split("\n");
    const read = () => {
      const here = ids.filter((id) => box.querySelector(`[id="${id}"]`) !== null);
      setPresent((prev) => (prev.join("\n") === here.join("\n") ? prev : here));
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(box, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [wanted]);

  // The first section with a part in the upper half of the scroller is the one being read.
  useEffect(() => {
    const box = content.current;
    if (!box || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const order = present;
    const scroller = box.closest(".page-scroll");
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.querySelector("h2")?.id ?? "";
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        const first = order.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { root: scroller, rootMargin: "0px 0px -50% 0px" },
    );
    for (const id of order) {
      const section = box.querySelector(`[id="${id}"]`)?.closest("section");
      if (section) io.observe(section);
    }
    return () => io.disconnect();
  }, [present]);

  const go = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    event.preventDefault();
    const heading = content.current?.querySelector<HTMLElement>(`[id="${id}"]`);
    if (!heading) return;
    (heading.closest("section") ?? heading).scrollIntoView({ behavior: motionOff() ? "auto" : "smooth", block: "start" });
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
    setActive(id);
  };

  const current = active !== null && present.includes(active) ? active : (present[0] ?? null);
  return (
    <div className="page-scroll settings-scroll">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t}>
          <ul>
            {sections
              .filter((s) => present.includes(s.id))
              .map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} aria-current={s.id === current ? "true" : undefined} onClick={(event) => go(event, s.id)}>
                    {s.label}
                  </a>
                </li>
              ))}
          </ul>
        </nav>
        <div ref={content} className="page-col settings">
          {children}
        </div>
      </div>
    </div>
  );
}
