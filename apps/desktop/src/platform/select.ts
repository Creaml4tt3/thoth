/**
 * Picks the `Platform` for this runtime: an injected bridge first, then Tauri,
 * otherwise an inert platform that explains what is missing.
 */
import type { Platform } from "@thoth/platform";
import { loadTauriPlatform } from "./load-tauri.ts";

const MESSAGE = "No Thoth host is connected. Run the desktop app, or inject a Platform as window.__THOTH_PLATFORM__ (dev and e2e bridge).";

/** A platform with nothing behind it, so the UI can explain instead of crash. */
export function createUnavailablePlatform(): Platform {
  const fail = (): never => {
    throw new Error(MESSAGE);
  };
  return {
    kind: "bridge",
    pickVaultFolder: async () => fail(),
    recentVaults: async () => [],
    openVault: async () => fail(),
    pickImportSource: async () => fail(),
    openImportSource: async () => fail(),
    servers: {
      list: async () => [],
      add: async () => fail(),
      remove: async () => fail(),
      signIn: async () => fail(),
      cancelSignIn: async () => undefined,
      useToken: async () => fail(),
      signOut: async () => fail(),
      call: async () => fail(),
    },
  };
}

export async function selectPlatform(win: Window = window): Promise<Platform> {
  const injected = win.__THOTH_PLATFORM__;
  if (injected) return typeof injected === "function" ? await injected() : injected;
  if (win.__TAURI_INTERNALS__ !== undefined) {
    return await loadTauriPlatform();
  }
  return createUnavailablePlatform();
}
