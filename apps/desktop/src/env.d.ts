/// <reference types="vite/client" />

interface Window {
  /**
   * Injection point for the dev and e2e bridge: a `Platform`, or a (possibly
   * async) factory for one. Checked before any other platform.
   */
  __THOTH_PLATFORM__?: import("@thoth/platform").Platform | (() => import("@thoth/platform").Platform | Promise<import("@thoth/platform").Platform>);
  /**
   * Injection point for the e2e bridge: stands in for `@tauri-apps/plugin-notification`, so a test sees each
   * system notification the app would show. Checked before Tauri's plugin.
   */
  __THOTH_NOTIFICATION_PLUGIN__?: import("@thoth/app-ui/notifications/core.ts").NotificationPlugin;
  /** Present only inside a Tauri webview. */
  __TAURI_INTERNALS__?: unknown;
}
