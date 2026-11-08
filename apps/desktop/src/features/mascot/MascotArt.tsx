/**
 * The Thoth mascot, "Moon Crown" (design round 9, owner approved): a paper-white ibis standing in front of a lunar
 * orange moon (the full version), or the logo mark, the ibis head cut out of the moon, with a small state cue beside
 * it (the compact version). Each state has its own drawing (art/<state>-<size>.svg), its pose drawn in.
 *
 * The art files are the designer's files with what the app does not need taken out (their <style>, every fill and the
 * transforms on the -pos groups: mascot.css sets those, so there is one stylesheet for every copy on a page). Ids
 * carry the placeholder `__m__`, replaced per instance so two copies never share a clip or a mask.
 *
 * Both versions are drawn in one 88×88 stage, so a switch between them is a morph, never a pop: the figure and the
 * badge are moved and scaled so their moons lie on each other, and one fades out while the other fades in. The
 * compact version fills the bottom-left 52×52 of the stage, facing right; `facing="left"` mirrors the stage and
 * `vertical="top"` lifts the badge to the top corner, so it shrinks toward the corner the mascot is docked in.
 */
import { useId, useMemo } from "react";

export const MASCOT_STATES = ["idle", "listening", "working", "review", "done", "error", "sleeping"] as const;
export type MascotState = (typeof MASCOT_STATES)[number];
export type MascotVersion = "full" | "compact";
export type MascotMotion = "full" | "calm" | "off";

/** The stage is 88 user units square; at 100% one unit is one CSS pixel. */
export const STAGE = 88;
/** The compact badge's box inside the stage (bottom-left, before mirroring). */
export const COMPACT_BOX = 52;
/** Below this stage size (CSS px) the full version uses the simplified 64 px figure. */
export const SMALL_STAGE = 76;

const files = import.meta.glob<string>("./art/*.svg", { query: "?raw", import: "default", eager: true });
/** The drawing inside a file's root <svg>. */
const art = (name: string) => {
  const raw = files[`./art/${name}.svg`] ?? "";
  return raw.slice(raw.indexOf(">") + 1, raw.lastIndexOf("</svg>"));
};
/**
 * A figure's top-level elements in paint order, in runs: the moon and the head (they lie on the badge's moon) and the
 * rest of the bird (body, wing, legs, cue), so the morph can fade the two apart.
 */
const figureParts = (drawing: string) => {
  const parts: { moon: boolean; __html: string }[] = [];
  let depth = 0;
  let start = 0;
  for (const tag of drawing.matchAll(/<(\/?)[^>]*?(\/?)>/g)) {
    if (tag[1]) depth--;
    else if (!tag[2]) depth++;
    if (depth !== 0) continue;
    const end = tag.index + tag[0].length;
    const el = drawing.slice(start, end);
    start = end;
    const moon = /class="m-(disc|head)-pos"/.test(el);
    const last = parts.at(-1);
    if (last?.moon === moon) last.__html += el;
    else parts.push({ moon, __html: el });
  }
  return parts;
};

interface Props {
  state: MascotState;
  version: MascotVersion;
  facing?: "right" | "left";
  vertical?: "top" | "bottom";
  motion?: MascotMotion;
  /** The simplified figure (thicker legs, one plume, a larger eye), for a stage under `SMALL_STAGE`. */
  tiny?: boolean;
  className?: string;
}

export function MascotArt({ state, version, facing = "right", vertical = "bottom", motion = "full", tiny = false, className }: Props) {
  const id = `m${useId().replace(/[^\w-]/g, "")}-`;
  const figure = useMemo(() => figureParts(art(`${state}-${tiny ? 64 : 88}`).replaceAll("__m__", id)), [state, tiny, id]);
  const badge = useMemo(() => ({ __html: art(`${state}-48`).replaceAll("__m__", id) }), [state, id]);
  return (
    <svg
      className={["mascot-art", className ?? ""].filter(Boolean).join(" ")}
      viewBox={`0 0 ${STAGE} ${STAGE}`}
      data-state={state}
      data-version={version}
      data-facing={facing}
      data-vertical={vertical}
      data-motion={motion}
      data-detail={tiny ? "low" : "high"}
      aria-hidden="true"
      focusable="false"
    >
      <g className="m-face">
        <g className="m-offset">
          <g className="m-rig">
            {/* The figure is drawn in 1040 units to the stage, with its origin 355, 100 units in. */}
            <g className="m-figure" data-part="full" data-state={state}>
              <g transform="scale(0.0846154) translate(355 100)">
                {figure.map(({ moon, __html }, i) => (
                  <g key={i} className={moon ? "m-figure-moon" : "m-figure-bird"} dangerouslySetInnerHTML={{ __html }} />
                ))}
              </g>
            </g>
            {/* The badge is drawn on a 48 px square. */}
            <g className="m-badge" data-part="compact" data-state={state} dangerouslySetInnerHTML={badge} />
          </g>
        </g>
      </g>
    </svg>
  );
}
