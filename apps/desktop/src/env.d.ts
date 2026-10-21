/// <reference types="vite/client" />

interface Window {
  /**
   * Injection point for the dev and e2e bridge: a `Platform`, or a (possibly
   * async) factory for one. Checked before any other platform.
   */
  __THOTH_PLATFORM__?: import("@thoth/platform").Platform | (() => import("@thoth/platform").Platform | Promise<import("@thoth/platform").Platform>);
  /** Present only inside a Tauri webview. */
  __TAURI_INTERNALS__?: unknown;
}
