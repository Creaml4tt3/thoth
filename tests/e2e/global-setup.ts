/**
 * Builds the desktop UI and the bridge bundle once, before any worker starts. With `--workers=4` every worker used to run
 * `buildAll()` in its `beforeAll` (and again after a restart), so four Vite builds emptied and rewrote the same `dist`
 * and bridge folders while other workers' pages were loading from them: a page then got a half-written file and never
 * showed the start screen (a `beforeEach` timeout, or "Cannot write headers after they are sent" in the bridge).
 * The workers inherit `THOTH_E2E_PREBUILT` and `buildAll()` then only builds the Rust harness (a no-op for cargo).
 */
import { buildAll } from "./setup.ts";

export default async function globalSetup(): Promise<void> {
  await buildAll();
  process.env.THOTH_E2E_PREBUILT = "1";
}
