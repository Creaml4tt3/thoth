import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useStrings } from "../strings/index.ts";
import { motionOff } from "./presence.ts";

export interface SettingsSectionLink {
  /** The id of the section's heading (`<h2 id>`). */
  id: string;
  label: string;
}

/**
 * Scrolls the page area around `target` (its `.page-scroll`) so the target's top, less its scroll margin, is at the top.
 * Only that area moves: `scrollIntoView` also scrolls every clipped ancestor once the area is at its end (a short last
 * section), and on WebKit without `overflow: clip` nothing could scroll the shell back.
 */
export function scrollToSection(target: HTMLElement, behavior: ScrollBehavior = "auto") {
  const box = target.closest<HTMLElement>(".page-scroll");
  if (!box) return;
  const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - margin;
  box.scrollTo?.({ top: Math.max(0, top), behavior }); // `?.`: jsdom has no Element.scrollTo
}

/** Lower case, without diacritics and extra spaces, so "Theme", "thème" and "THEME " all match. Thai has no case and keeps its marks. */
export const searchable = (text: string): string => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Whether every word of `query` is in `text` (both through `searchable`), in any order. */
export function matchesQuery(text: string, query: string): boolean {
  const words = searchable(query).split(" ").filter(Boolean);
  const hay = searchable(text);
  return words.every((w) => hay.includes(w));
}

/**
 * The parts of a section the search looks at one by one: its direct children, except the heading (which matches the
 * whole section) and a part that only groups others (a sub-section with its own `h3`, searched as one part).
 */
const PARTS = ":scope > :not(h2)";

/**
 * Settings as one long page with a list of its sections beside it (above it in a narrow window). A link scrolls to
 * its section (at once under reduced motion) and moves focus to the heading; the section in view is marked
 * `aria-current`. Sections whose heading is not on the page (a feature this build lacks) are left out of the list.
 *
 * The search box above the list filters the page as it is: a section whose heading matches stays whole; otherwise
 * only its parts whose text (labels, hints, options) matches stay, under the heading. Nothing to keep in sync: a new
 * setting is searchable by being on the page. Escape clears it.
 */
export function SettingsLayout({ sections, children }: { sections: readonly SettingsSectionLink[]; children: ReactNode }) {
  const strings = useStrings();
  const t = strings.settingsNav;
  const s = strings.settingsSearch;
  const content = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  /** The sections with a match, in page order; null while the box is empty. */
  const [found, setFound] = useState<readonly string[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  /** A link chose a section: the one in view does not replace it until the person scrolls (a short last section never
   * reaches the top, so the one above it stays in view). */
  const held = useRef(false);
  const release = () => {
    held.current = false;
  };
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

  // Filters the page. Runs again when sections appear or change (MutationObserver), but ignores its own `hidden` edits.
  useLayoutEffect(() => {
    const box = content.current;
    if (!box) return;
    const apply = () => {
      const hits: string[] = [];
      for (const section of box.querySelectorAll<HTMLElement>(":scope > section")) {
        const heading = section.querySelector<HTMLElement>(":scope > h2");
        const parts = [...section.querySelectorAll<HTMLElement>(PARTS)];
        if (!query.trim()) {
          section.hidden = false;
          for (const part of parts) part.hidden = false;
          continue;
        }
        const whole = heading !== null && matchesQuery(heading.textContent ?? "", query);
        let any = whole;
        for (const part of parts) {
          // A form control's chosen value is not text: options and labels are, so "dark" finds the theme.
          const hit = whole || matchesQuery(`${part.textContent ?? ""} ${[...part.querySelectorAll("[aria-label],[title]")].map((el) => `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`).join(" ")}`, query);
          part.hidden = !hit;
          any ||= hit;
        }
        section.hidden = !any;
        if (any && heading?.id) hits.push(heading.id);
      }
      setFound((prev) => {
        const next = query.trim() ? hits : null;
        return prev?.join("\n") === next?.join("\n") ? prev : next;
      });
    };
    apply();
    const watch = new MutationObserver((records) => {
      if (records.some((r) => r.type === "childList" || (r.type === "characterData"))) apply();
    });
    watch.observe(box, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
  }, [query]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  };

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
        if (first && !held.current) setActive(first);
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
    scrollToSection(heading.closest("section") ?? heading, motionOff() ? "auto" : "smooth");
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
    held.current = true;
    setActive(id);
  };

  const listed = found === null ? present : present.filter((id) => found.includes(id));
  const current = active !== null && listed.includes(active) ? active : (listed[0] ?? null);
  return (
    // What the person does to scroll (wheel, touch, keys, the scrollbar) gives the mark back to the section in view; the
    // keydown and pointerdown of a link's own Enter or click come before its click, which holds the mark again.
    <div className="page-scroll settings-scroll" onWheel={release} onTouchMove={release} onKeyDown={release} onPointerDown={release}>
      <div className="settings-layout">
        <div className="settings-side">
          <input
            type="search"
            className="input settings-search"
            placeholder={s.placeholder}
            aria-label={s.label}
            aria-controls="settings-content"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          <nav className="settings-nav" aria-label={t}>
            <ul>
              {sections
                .filter((x) => listed.includes(x.id))
                .map((x) => (
                  <li key={x.id}>
                    <a href={`#${x.id}`} aria-current={x.id === current ? "true" : undefined} onClick={(event) => go(event, x.id)}>
                      {x.label}
                    </a>
                  </li>
                ))}
            </ul>
          </nav>
        </div>
        <div ref={content} id="settings-content" className="page-col settings">
          {children}
          {found !== null && found.length === 0 && <p className="muted settings-none">{s.none(query.trim())}</p>}
        </div>
        <p role="status" className="sr-only">
          {found === null ? "" : s.results(found.length)}
        </p>
      </div>
    </div>
  );
}
