/**
 * The Thoth mascot, drawn by hand as one inline SVG (design/mascot): a round lunar-orange moon body with a near-black
 * ibis head, neck and long decurved beak (the full version), or the head and neck rising out of the moon disc, close to
 * the Moon Ibis mark (the compact version).
 *
 * Both versions are the same drawing on one 88×88 stage, so they always show the same state and a switch between them
 * is a morph, never a pop: the moon body shrinks into the badge disc and the head moves with it (one head, one disc,
 * moved by CSS transforms), the legs, wing and short neck fade out while the long neck fades in. Every part is drawn
 * with its pivot at its own origin, so a pose (a head tilt, a raised wing) is one rotation and the mode is one
 * translate-and-scale around it. Colours are CSS variables (mascot.css): an ink silhouette on light, a warm-white one on
 * dark, and the orange disc in both.
 *
 * The compact version fills the bottom-left 52×52 of the stage, facing right; `facing="left"` mirrors the stage and
 * `vertical="top"` lifts the badge to the top corner, so it shrinks toward the corner the mascot is docked in.
 */
import { useId } from "react";

export const MASCOT_STATES = ["idle", "listening", "working", "review", "done", "error", "sleeping"] as const;
export type MascotState = (typeof MASCOT_STATES)[number];
export type MascotVersion = "full" | "compact";
export type MascotMotion = "full" | "calm" | "off";

/** The stage is 88 user units square; at 100% one unit is one CSS pixel. */
export const STAGE = 88;
/** The compact badge's box inside the stage (bottom-left, before mirroring). */
export const COMPACT_BOX = 52;

interface Props {
  state: MascotState;
  version: MascotVersion;
  facing?: "right" | "left";
  vertical?: "top" | "bottom";
  motion?: MascotMotion;
  /** Fewer details (no craters, no eye highlight, a bolder eye) for 32px and below. */
  tiny?: boolean;
  className?: string;
}

export function MascotArt({ state, version, facing = "right", vertical = "bottom", motion = "full", tiny = false, className }: Props) {
  const id = useId().replace(/:/g, "");
  const clip = `m-clip-${id}`;
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
      <defs>
        <clipPath id={clip}>
          <circle cx="24" cy="64" r="20" />
        </clipPath>
      </defs>
      <g className="m-face">
        <g className="m-offset">
          <ellipse className="m-floor" data-part="full" cx="34" cy="86.4" rx="17" ry="1.6" />
          <g className="m-rig">
            {/* The full version: legs, body, short neck, wing. */}
            <g className="m-legs" data-part="full" data-state={state}>
              <path d="M29 79.5 L28 85.6 M28 85.6 L24.2 86.1 M28 85.6 L31.6 86.4" />
              <path d="M39.4 79.5 L40.4 85.6 M40.4 85.6 L36.8 86.2 M40.4 85.6 L44.6 86.2" />
            </g>
            <g className="m-disc-pos">
              <g className="m-disc">
                <circle className="m-moon" r="1" />
                <g className="m-craters">
                  <circle className="m-crater" cx="-0.44" cy="-0.06" r="0.2" />
                  <circle className="m-moon" cx="-0.38" cy="-0.13" r="0.165" />
                  <circle className="m-crater" cx="0.2" cy="0.46" r="0.1" />
                  <circle className="m-crater" cx="0.44" cy="-0.18" r="0.07" />
                  <circle className="m-crater" cx="-0.18" cy="0.62" r="0.055" />
                </g>
              </g>
            </g>
            <path
              className="m-ink m-neck-full"
              data-part="full"
              d="M21.6 17.6 C20 23.6 22.6 27.4 24.6 30.6 C26 33 25.8 36.2 24.4 39.4 C27.6 42.6 33.6 42.4 35.6 39 C35.4 34.4 33.6 30.4 31.6 27.4 C30.2 25.2 29.8 22.2 30.8 18.2 Z"
            />
            {/* The compact version: the long neck rising out of the disc, as in the mark. */}
            <g clipPath={`url(#${clip})`} className="m-neck-compact-wrap" data-part="compact" data-state={state}>
              <path className="m-ink m-neck-compact" d="M12.8 50.4 C10.6 55.6 12.6 59.6 14.8 63 C16.8 66.2 16.4 70.2 13.8 74 C11.4 77.6 8.2 80.6 4.6 83.4 L22.6 90 C26.4 85.4 27.4 79 25.4 72.6 C24 67.8 21.4 63.8 20.6 59.6 C20 56.4 20.6 53.6 21.6 50.8 Z" />
            </g>
            {/* Props held or watched: drawn under the wing and the head. */}
            <g className="m-pp m-pp-page">
              <g className="m-page">
                <path className="m-paper" d="M-6 -7.5 H2.6 L6 -4.1 V7.5 H-6 Z" />
                <path className="m-fold" d="M2.6 -7.5 V-4.1 H6" />
                <g className="m-page-lines">
                  <path d="M-3.6 -2.6 H3.2 M-3.6 0.6 H3.2 M-3.6 3.8 H1.2" />
                </g>
                <g className="m-page-review">
                  <circle className="m-accent-fill" cx="-2.2" cy="-3.6" r="1.7" />
                  <path d="M-3.6 1.2 H3.2 M-3.6 4.2 H1.6" />
                </g>
              </g>
            </g>
            <g className="m-wing-pos" data-part="full">
              <g className="m-wing">
                <path className="m-ink" d="M-1 0 C4.6 1 7.6 7 6.4 14.4 C6 17.2 3.4 18.2 1.8 15.8 C-0.8 11.6 -3.2 5.2 -1 0 Z" />
              </g>
            </g>
            <g className="m-head-pos">
              <g className="m-head">
                <circle className="m-ink" cx="0" cy="-9" r="9" />
                <path className="m-ink m-beak" d="M7.4 -13.6 C21.6 -13.8 36.6 -5.4 44.4 17.6 C44.8 18.9 43.5 19.7 42.7 18.7 C35.6 3.4 22.4 -6.4 8.4 -7.2 Z" />
                {/* At 32px and below the beak is bolder, so it does not vanish when rasterized. */}
                <path className="m-ink m-beak-bold" d="M7.2 -14.8 C21.8 -15 37.6 -6 45.6 17.2 C46.2 19.4 43.8 20.8 42.4 19.2 C35 3.6 22 -5 8.4 -5.4 Z" />
                <g className="m-eye-pos">
                  <g className="m-eye">
                    <g className="m-eye-open">
                      <circle className="m-sclera" r="3.3" />
                      <g className="m-pupil">
                        <circle className="m-pupil-dot" cx="0.8" r="1.85" />
                        <circle className="m-glint" cx="1.4" cy="-0.8" r="0.62" />
                      </g>
                    </g>
                    <path className="m-eye-line m-eye-happy" d="M-2.8 0.9 Q0 -3.2 2.8 0.9" />
                    <path className="m-eye-line m-eye-closed" d="M-2.8 -0.4 Q0 2.8 2.8 -0.4" />
                  </g>
                  <path className="m-eye-line m-brow" d="M-3.6 -4.6 L2.8 -6.6" />
                </g>
              </g>
            </g>
            <g className="m-pp m-pp-orbit">
              <circle className="m-orbit-ring" r="12" />
              <g className="m-orbit">
                <path className="m-accent-fill" transform="translate(12 0)" d="M1.6 -3 A3.4 3.4 0 1 0 1.6 3 A2.7 2.7 0 0 1 1.6 -3 Z" />
              </g>
            </g>
            <g className="m-pp m-pp-ticks">
              <g className="m-ticks">
                <path d="M0 -5.6 V-2.6 M-5 -2 L-3.2 -0.4 M5 -2 L3.2 -0.4" />
              </g>
            </g>
            <g className="m-pp m-pp-sparkle">
              <g className="m-sparkle">
                <path className="m-accent-fill" d="M0 -5.4 C0.7 -1.4 1.4 -0.7 5.4 0 C1.4 0.7 0.7 1.4 0 5.4 C-0.7 1.4 -1.4 0.7 -5.4 0 C-1.4 -0.7 -0.7 -1.4 0 -5.4 Z" />
                <circle className="m-accent-fill" cx="6.4" cy="-5.2" r="1.1" />
              </g>
            </g>
            <g className="m-pp m-pp-bang">
              <g className="m-bang">
                <rect className="m-accent-fill" x="-1.7" y="-8" width="3.4" height="9" rx="1.7" transform="rotate(12)" />
                <circle className="m-accent-fill" cx="-1" cy="4.4" r="1.9" />
              </g>
            </g>
            <g className="m-pp m-pp-moon">
              <g className="m-sleep-moon">
                <path className="m-accent-fill" d="M2.4 -4.4 A5 5 0 1 0 2.4 4.4 A4 4 0 0 1 2.4 -4.4 Z" />
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
