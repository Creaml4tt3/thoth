/**
 * The mascot's preferences: whether it shows, its size (Compact, Full, or Auto: full, compact while typing in the
 * editor or in a narrow window), its scale, its motion, whether it snaps to the edges, and where it was put.
 *
 * Kept per user, not per Private Space, with the other desktop preferences in the webview's localStorage (like the
 * language, the theme and the Agent settings): how big the assistant is, how much it moves and which corner it lives
 * in are about this person's screen and taste, not about the notes in a vault. A position is stored as distances from
 * the nearest window edges, so it stays in its corner when the window is resized.
 */
export const MASCOT_SIZES = ["compact", "full", "auto"] as const;
export type MascotSize = (typeof MASCOT_SIZES)[number];
export const MASCOT_MOTIONS = ["full", "calm", "off"] as const;
export type MascotMotionPref = (typeof MASCOT_MOTIONS)[number];

export const SCALE_MIN = 80;
export const SCALE_MAX = 140;
export const SCALE_STEP = 10;

/** Where the mascot is: which edges it is measured from, and how far (CSS pixels) from each. */
export interface MascotPosition {
  h: "left" | "right";
  x: number;
  v: "top" | "bottom";
  y: number;
}

export interface MascotPrefs {
  show: boolean;
  size: MascotSize;
  /** Percent, 80–140 in steps of 10. */
  scale: number;
  motion: MascotMotionPref;
  snap: boolean;
  /** Null: the default place, bottom-right. */
  position: MascotPosition | null;
}

export const MASCOT_PREFS_KEY = "thoth.desktop.mascot";
export const DEFAULT_MASCOT_PREFS: MascotPrefs = { show: true, size: "auto", scale: 100, motion: "full", snap: true, position: null };

/** A scale within the bounds, on a step. */
export function clampScale(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_MASCOT_PREFS.scale;
  const stepped = Math.round(n / SCALE_STEP) * SCALE_STEP;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, stepped));
}

const MAX_OFFSET = 100_000;
function parsePosition(value: unknown): MascotPosition | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_OFFSET;
  if ((o["h"] !== "left" && o["h"] !== "right") || (o["v"] !== "top" && o["v"] !== "bottom") || !num(o["x"]) || !num(o["y"])) return null;
  return { h: o["h"], x: Math.round(o["x"] as number), v: o["v"], y: Math.round(o["y"] as number) };
}

/** Preferences from stored text; anything missing or out of bounds falls back to its default (the scale is clamped). */
export function parseMascotPrefs(raw: string | null | undefined): MascotPrefs {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  const o = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const d = DEFAULT_MASCOT_PREFS;
  return {
    show: typeof o["show"] === "boolean" ? o["show"] : d.show,
    size: (MASCOT_SIZES as readonly unknown[]).includes(o["size"]) ? (o["size"] as MascotSize) : d.size,
    scale: "scale" in o ? clampScale(o["scale"]) : d.scale,
    motion: (MASCOT_MOTIONS as readonly unknown[]).includes(o["motion"]) ? (o["motion"] as MascotMotionPref) : d.motion,
    snap: typeof o["snap"] === "boolean" ? o["snap"] : d.snap,
    position: parsePosition(o["position"]),
  };
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadMascotPrefs(): MascotPrefs {
  try {
    return parseMascotPrefs(storage()?.getItem(MASCOT_PREFS_KEY));
  } catch {
    return { ...DEFAULT_MASCOT_PREFS };
  }
}

export function saveMascotPrefs(prefs: MascotPrefs): void {
  try {
    storage()?.setItem(MASCOT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // quota or privacy mode: the preferences last for the session
  }
}

/** One store per window, so the mascot and the settings section see the same values at once. */
export interface MascotPrefsStore {
  subscribe(listener: () => void): () => void;
  get(): MascotPrefs;
  update(patch: Partial<MascotPrefs>): void;
}

export function createMascotPrefsStore(initial: MascotPrefs = loadMascotPrefs(), save: (prefs: MascotPrefs) => void = saveMascotPrefs): MascotPrefsStore {
  let prefs = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => prefs,
    update(patch) {
      const next = parseMascotPrefs(JSON.stringify({ ...prefs, ...patch }));
      prefs = next;
      save(next);
      for (const listener of [...listeners]) listener();
    },
  };
}
