/**
 * Settings → Thoth assistant → Mascot: show it or not, its size (Compact, Full, Auto), its scale (80–140%), its motion
 * (Full, Calm, Off), snapping to the edges, and putting it back in its corner. Changes apply at once to the mascot on
 * screen (one store per window) and are kept per user (prefs.ts).
 */
import { useState, useSyncExternalStore } from "react";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { MascotArt, STAGE } from "./MascotArt.tsx";
import { MASCOT_MOTIONS, MASCOT_SIZES, SCALE_MAX, SCALE_MIN, SCALE_STEP } from "./prefs.ts";
import { boxSize } from "./placement.ts";
import { useReducedMotion } from "./hooks.ts";
import "./mascot.css";

export function MascotSettings() {
  const { assistant } = useSession();
  const t = useDesktopStrings().mascot.settings;
  const store = assistant?.prefs;
  const prefs = useSyncExternalStore(store?.subscribe ?? (() => () => undefined), () => store?.get() ?? null);
  const reduced = useReducedMotion();
  const [reset, setReset] = useState(false);
  if (!store || !prefs) return null;
  const version = prefs.size === "compact" ? "compact" : "full";
  const stage = Math.round(STAGE * (prefs.scale / 100));
  const box = boxSize(version, prefs.scale);
  return (
    <section className="agents-sub mascot-settings" aria-labelledby="mascot-settings-heading">
      <h3 id="mascot-settings-heading">{t.heading}</h3>
      <p className="muted">{t.lede}</p>
      <div className="mascot-settings-grid">
        <div className="mascot-settings-controls">
          <div className="set-toggle">
            <input id="mascot-show" type="checkbox" role="switch" checked={prefs.show} onChange={(e) => store.update({ show: e.target.checked })} />
            <label htmlFor="mascot-show">{t.show}</label>
          </div>
          <fieldset className="set-segmented" aria-describedby="mascot-size-hint">
            <legend>{t.size}</legend>
            <div className="set-segments">
              {MASCOT_SIZES.map((size) => (
                <label key={size} className="set-segment">
                  <input type="radio" name="mascot-size" value={size} checked={prefs.size === size} onChange={() => store.update({ size })} />
                  <span>{t.sizes[size]}</span>
                </label>
              ))}
            </div>
            <small id="mascot-size-hint" className="muted">
              {t.sizeHint}
            </small>
          </fieldset>
          <div className="field mascot-scale">
            <label htmlFor="mascot-scale">{t.scale}</label>
            <div className="mascot-scale-row">
              <input
                id="mascot-scale"
                type="range"
                min={SCALE_MIN}
                max={SCALE_MAX}
                step={SCALE_STEP}
                value={prefs.scale}
                aria-valuetext={t.scaleValue(prefs.scale)}
                onChange={(e) => store.update({ scale: Number(e.target.value) })}
              />
              <output htmlFor="mascot-scale" className="mono small" aria-hidden="true">
                {t.scaleValue(prefs.scale)}
              </output>
            </div>
          </div>
          <fieldset className="set-segmented" aria-describedby="mascot-motion-hint">
            <legend>{t.motion}</legend>
            <div className="set-segments">
              {MASCOT_MOTIONS.map((motion) => (
                <label key={motion} className="set-segment">
                  <input type="radio" name="mascot-motion" value={motion} checked={prefs.motion === motion} onChange={() => store.update({ motion })} />
                  <span>{t.motions[motion]}</span>
                </label>
              ))}
            </div>
            <small id="mascot-motion-hint" className="muted">
              {t.motionHint}
            </small>
          </fieldset>
          <div className="set-toggle">
            <input id="mascot-snap" type="checkbox" role="switch" checked={prefs.snap} onChange={(e) => store.update({ snap: e.target.checked })} aria-describedby="mascot-snap-hint" />
            <label htmlFor="mascot-snap">{t.snap}</label>
            <small id="mascot-snap-hint" className="muted">
              {t.snapHint}
            </small>
          </div>
          <div className="set-actions">
            <Button
              variant="ghost"
              small
              onClick={() => {
                store.update({ position: null });
                setReset(true);
              }}
            >
              {t.reset}
            </Button>
            <span role="status" className="muted small">
              {reset ? t.resetDone : ""}
            </span>
          </div>
        </div>
        <figure className="mascot-preview" aria-label={t.preview}>
          <div className="mascot-preview-stage" style={{ width: stage, height: stage }}>
            <div style={{ width: stage, height: stage, transform: version === "compact" ? `translateY(${-(stage - box) / 2}px)` : undefined }}>
              <MascotArt state="idle" version={version} motion={reduced ? "off" : prefs.motion} />
            </div>
          </div>
        </figure>
      </div>
    </section>
  );
}
