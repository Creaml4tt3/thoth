/**
 * When the real bundle may load. This is all that runs at page load, so it stays tiny (main.tsx is just `arm()`).
 * The root's own HTML (the site's static capture) stays as it is until the editor is mounted, and for good where the
 * gate says no: phones, Save-Data and a reduced-data preference never load the bundle, not even from the button.
 */
export interface Gate {
  document: Document;
  window: Pick<Window, "matchMedia" | "innerHeight">;
  connection?: { saveData?: boolean } | undefined;
  /** Loads and mounts the demo into `root`. */
  load(root: HTMLElement): void;
}

export function mayLoad({ window, connection }: Pick<Gate, "window" | "connection">): boolean {
  return !window.matchMedia("(max-width: 640px)").matches && !connection?.saveData && !window.matchMedia("(prefers-reduced-data: reduce)").matches;
}

/** Loads each demo root when it comes within about one screen of the viewport, or when its "Try it here" button is clicked. */
export function arm(gate: Gate): void {
  const roots = [...gate.document.querySelectorAll<HTMLElement>("[data-thoth-demo]")];
  if (roots.length === 0 || !mayLoad(gate)) return;
  const once = (root: HTMLElement) => {
    if (root.dataset["thothDemoState"] || !mayLoad(gate)) return;
    root.dataset["thothDemoState"] = "loading";
    gate.load(root);
  };
  const watcher =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) =>
            entries.forEach((entry) => {
              if (!entry.isIntersecting) return;
              watcher?.unobserve(entry.target);
              once(entry.target as HTMLElement);
            }),
          { rootMargin: `${gate.window.innerHeight}px 0px` },
        );
  for (const root of roots) {
    watcher?.observe(root);
    root.querySelector("[data-thoth-demo-load]")?.addEventListener("click", () => once(root));
  }
}
