/**
 * The Thoth mascot, the hooded ibis (owner, 2026-11-15: Option 1 replaces Moon Crown everywhere): a small scribe in an
 * orange moon-spotted cloak. Each state is its own painted pose (art/<state>.webp), with a Night copy that carries a
 * paper outline so the dark cloak edges still read on a dark panel (art/<state>-night.webp), and a round head badge for
 * the compact version (art/<state>-head.webp). The paintings come from the approved concept art (thoth .tmp/
 * mascot-humanoid/app-states, cut out and exported at 316 px high, so 2x at the largest stage).
 *
 * Both versions are drawn in one 88×88 stage, so a switch between them is a morph, never a pop: the figure shrinks into
 * the badge's corner while the badge grows in. The compact version fills the bottom-left 52×52 of the stage;
 * `facing="left"` mirrors the stage and `vertical="top"` lifts the badge to the top corner, so it shrinks toward the
 * corner the mascot is docked in.
 */
export const MASCOT_STATES = ["idle", "listening", "working", "review", "done", "error", "sleeping"] as const;
export type MascotState = (typeof MASCOT_STATES)[number];
export type MascotVersion = "full" | "compact";
export type MascotMotion = "full" | "calm" | "off";

/** The stage is 88 user units square; at 100% one unit is one CSS pixel. */
export const STAGE = 88;
/** The compact badge's box inside the stage (bottom-left, before mirroring). */
export const COMPACT_BOX = 52;

const files = import.meta.glob<string>("./art/*.webp", { query: "?url", import: "default", eager: true });
const art = (name: string) => files[`./art/${name}.webp`] ?? "";
/** States that are waiting on the person or busy for them: the badge shows a small orange cue. */
const ENGAGED: ReadonlySet<MascotState> = new Set(["listening", "working", "review"]);

interface Props {
  state: MascotState;
  version: MascotVersion;
  facing?: "right" | "left";
  vertical?: "top" | "bottom";
  motion?: MascotMotion;
  className?: string;
}

export function MascotArt({ state, version, facing = "right", vertical = "bottom", motion = "full", className }: Props) {
  return (
    <svg
      className={["mascot-art", className ?? ""].filter(Boolean).join(" ")}
      viewBox={`0 0 ${STAGE} ${STAGE}`}
      data-state={state}
      data-version={version}
      data-facing={facing}
      data-vertical={vertical}
      data-motion={motion}
      aria-hidden="true"
      focusable="false"
    >
      <g className="m-face">
        <g className="m-offset">
          <g className="m-rig">
            <g className="m-figure" data-part="full" data-state={state}>
              <image className="m-paper-only" href={art(state)} x="0" y="1" width={STAGE} height={STAGE - 1} preserveAspectRatio="xMidYMax meet" />
              <image className="m-night-only" href={art(`${state}-night`)} x="0" y="1" width={STAGE} height={STAGE - 1} preserveAspectRatio="xMidYMax meet" />
            </g>
            <g className="m-badge" data-part="compact" data-state={state}>
              <image href={art(`${state}-head`)} x="2" y="38" width="48" height="48" />
              {ENGAGED.has(state) && (
                <g className="m-cue">
                  <circle className="m-cue-ring" cx="44" cy="43" r="6" />
                  <circle className="m-cue-engaged" cx="44" cy="43" r="4" />
                </g>
              )}
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
