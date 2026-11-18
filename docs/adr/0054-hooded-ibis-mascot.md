# ADR-0054: The hooded ibis replaces Moon Crown as the mascot

- **Status:** Accepted (owner). On 2026-11-13 the owner chose Option 1, the hooded ibis scribe, over Option 7 ("I think
  option 1 look better") and asked for it in new content. On 2026-11-15: "I think I will change all mascot to new one."
- **Date:** 2026-11-18
- **Deciders:** project owner (the character and its use everywhere); the asset details are this ADR's.
- **Amends:** ADR-0053 rule 8, which kept the app's Moon Crown mascot and said a change of mascot would be its own ADR.

## Context

Moon Crown (the ink ibis before the moon, side view, 2026-11-06) was the mascot in the app, the site and videos. The
owner then explored a humanoid mascot in a soft, outlined style. Two options went to 3D and a live test page, and the
owner chose Option 1, the hooded ibis. The site has shown it since 2026-11-13 (hero, Agent Hub tile, 404, section
poses) and the videos since Story #1.

## Decision

1. **The hooded ibis is the one mascot** in the desktop app, the site and videos. Moon Crown is retired.
2. **The mark does not change.** The Moon Ibis mark (logo, favicon, app icon) is a separate thing from the mascot and
   stays as ADR-0053 describes it.
3. **In the app** it replaces Moon Crown in `MascotArt`: the existing states (idle, typing, done, and the rest) plus
   listening, working, error and sleeping, as raster images with a night-outline copy and a head badge. The states,
   the sizes, the settings and the "it reacts, it never lip-syncs" rule stay as they were.
4. **It is decorative.** The art has empty alt text; what the mascot says stays in its bubble text.

## Consequences

- The Moon Crown SVG rig is no longer used by the app. It stays in the history and in older videos.
- New art comes from the same base and concept views, so the character stays the same across the app, the site and
  videos.
- Older posts that show Moon Crown are not re-edited.
