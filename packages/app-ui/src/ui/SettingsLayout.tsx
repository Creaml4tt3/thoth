import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useStrings } from "../strings/index.ts";
import { Icon, type IconName } from "./Icon.tsx";

export interface SettingsSectionLink {
  /** The id of the section's heading (`<h2 id>`). */
  id: string;
  label: string;
  icon: IconName;
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

/** The section chosen last, for the rest of the session (not stored: a new session opens at the first section). */
let lastChosen: string | null = null;

/**
 * Settings, one section at a time: a vertical tab list of the sections beside the page (a scrolling row above it in a
 * narrow window), and the chosen section's page. Arrow keys, Home and End move between tabs and choose them. Sections
 * whose heading is not on the page (a feature this build lacks) are left out of the list. `initial` opens that section
 * (a deep link) once its heading is on the page, even when it shows up late; a new `request` asks for it again.
 *
 * The search box above the list searches every section, hidden ones too: a section whose heading matches shows whole;
 * otherwise only its parts whose text (labels, hints, options) matches show, under the heading. Nothing to keep in
 * sync: a new setting is searchable by being on the page. Escape clears it and the chosen section comes back.
 */
export function SettingsLayout({ sections, initial, request, children }: { sections: readonly SettingsSectionLink[]; initial?: string | undefined; request?: object | undefined; children: ReactNode }) {
  const strings = useStrings();
  const t = strings.settingsNav;
  const s = strings.settingsSearch;
  const content = useRef<HTMLDivElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  /** The sections with a match, in page order; null while the box is empty. */
  const [found, setFound] = useState<readonly string[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(lastChosen);
  /** A deep link waiting for its section to be on the page. */
  const pending = useRef<string | null>(null);
  const wanted = sections.map((s) => s.id).join("\n");

  const choose = (id: string) => {
    pending.current = null;
    lastChosen = id;
    setChosen(id);
    setQuery("");
    content.current?.closest(".page-scroll")?.scrollTo?.({ top: 0 }); // `?.`: jsdom has no Element.scrollTo
  };

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

  useLayoutEffect(() => {
    pending.current = initial ?? null;
  }, [initial, request]);
  useLayoutEffect(() => {
    if (pending.current !== null && present.includes(pending.current)) choose(pending.current);
  }, [present, initial, request]);

  const current = chosen !== null && present.includes(chosen) ? chosen : (present[0] ?? null);

  // Shows the chosen section, or filters every section while searching. Runs again when sections appear or change
  // (MutationObserver), but ignores its own `hidden` edits.
  useLayoutEffect(() => {
    const box = content.current;
    if (!box) return;
    const ids = wanted.split("\n");
    const apply = () => {
      const hits: string[] = [];
      for (const section of box.querySelectorAll<HTMLElement>(":scope > section")) {
        const heading = section.querySelector<HTMLElement>(":scope > h2");
        const parts = [...section.querySelectorAll<HTMLElement>(PARTS)];
        const id = heading?.id ?? "";
        if (ids.includes(id)) {
          section.id = `${id}-panel`;
          section.setAttribute("role", "tabpanel");
          section.setAttribute("aria-labelledby", `${id}-tab`);
        }
        if (!query.trim()) {
          section.hidden = id !== current;
          for (const part of parts) part.hidden = false;
          continue;
        }
        const whole = heading !== null && matchesQuery(heading.textContent ?? "", query);
        let any = whole;
        for (const part of parts) {
          // A form control's chosen value is not text: options and labels are (a Select lists its options in
          // `data-search`), so "dark" finds the theme.
          const hit = whole || matchesQuery(`${part.textContent ?? ""} ${[...part.querySelectorAll("[aria-label],[title],[data-search]")].map((el) => `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${el.getAttribute("data-search") ?? ""}`).join(" ")}`, query);
          part.hidden = !hit;
          any ||= hit;
        }
        section.hidden = !any;
        if (any && id) hits.push(id);
      }
      setFound((prev) => {
        const next = query.trim() ? hits : null;
        return prev?.join("\n") === next?.join("\n") ? prev : next;
      });
    };
    apply();
    const watch = new MutationObserver((records) => {
      if (records.some((r) => r.type === "childList" || r.type === "characterData")) apply();
    });
    watch.observe(box, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
  }, [query, current, wanted]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  };

  const listed = found === null ? present : present.filter((id) => found.includes(id));
  const tabs = sections.filter((x) => listed.includes(x.id));
  // The tab that takes Tab focus: the chosen one, or the first while a search hides it.
  const focusable = tabs.some((x) => x.id === current) ? current : (tabs[0]?.id ?? null);

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const to = { ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: last }[event.key];
    if (to === undefined || last < 0) return;
    event.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length]!;
    choose(next.id);
    tabList.current?.querySelector<HTMLElement>(`[id="${next.id}-tab"]`)?.focus();
  };

  return (
    <div className="page-scroll settings-scroll">
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
          <div ref={tabList} role="tablist" aria-orientation="vertical" aria-label={t} className="settings-nav">
            {tabs.map((x, index) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                id={`${x.id}-tab`}
                aria-controls={`${x.id}-panel`}
                aria-selected={x.id === current}
                tabIndex={x.id === focusable ? 0 : -1}
                className="settings-tab"
                onClick={() => choose(x.id)}
                onKeyDown={(event) => onTabKey(event, index)}
              >
                <Icon name={x.icon} />
                {x.label}
              </button>
            ))}
          </div>
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
