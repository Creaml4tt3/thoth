/**
 * Scopes the app's CSS under `.thoth-demo`, so nothing leaks onto the host page (the site embeds this bundle). The app's
 * stylesheets are written for a page of their own: `:root`, `html`, `body` and `#root` become the demo element itself, the
 * theme selectors (`[data-theme=...]`) apply to it, every other rule becomes a descendant of it. `::view-transition-*` rules
 * (a whole-page effect) are dropped. Keyframe names stay global; they all start with `thoth-`.
 */
/** The little of PostCSS this uses (it is not a direct dependency here; Vite brings it). */
interface Rule {
  selector: string;
  selectors: string[];
  parent?: { type: string; name?: string } | undefined;
  remove(): void;
}
interface Root {
  walkRules(visit: (rule: Rule) => void): void;
  source?: { input?: { file?: string } } | undefined;
}

export const SCOPE = ".thoth-demo";

export function scopeSelector(selector: string): string {
  const s = selector.trim();
  if (s.startsWith(SCOPE)) return s; // the demo's own rules are written against the root already
  if (/^(:root|html|body|#root)(?![\w-])/.test(s)) return s.replace(/^(:root|html|body|#root)/, SCOPE);
  if (s.startsWith("[data-theme")) return SCOPE + s;
  return `${SCOPE} ${s}`;
}

export function scopeCss() {
  return {
    postcssPlugin: "thoth-demo-scope",
    Once(root: Root) {
      // The test page's own inline <style> (index.html?html-proxy) styles that page, not the demo.
      if (root.source?.input?.file?.includes("index.html")) return;
      root.walkRules((rule) => {
        const parent = rule.parent;
        if (parent?.type === "atrule" && /keyframes$/i.test(parent.name ?? "")) return;
        if (rule.selector.includes("::view-transition")) {
          rule.remove();
          return;
        }
        rule.selectors = [...new Set(rule.selectors.map(scopeSelector))];
      });
    },
  };
}
