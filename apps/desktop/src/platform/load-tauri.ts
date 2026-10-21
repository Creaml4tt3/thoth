/**
 * The one place that names `@thoth/platform/tauri`. It binds the transport to
 * the app's own `@tauri-apps/api` (rather than Tauri internals), and is
 * imported dynamically so non-Tauri runs never load it; tests stub this file.
 */
import type { Platform } from "@thoth/platform";

export async function loadTauriPlatform(): Promise<Platform> {
  const [{ createTauriPlatform }, { invoke }, { listen }] = await Promise.all([import("@thoth/platform/tauri"), import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
  return createTauriPlatform({
    invoke: (command, args, options) => invoke(command, args, options),
    listen: (event, handler) => listen(event, handler),
  });
}
