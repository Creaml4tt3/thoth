/** Sends the window's uncaught errors to the host's local log (ADR-0040): at most `limit` per window load, repeats dropped. */
import type { Diagnostics } from "@thoth/platform";

const text = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
};

export function createErrorReporter(send: Diagnostics["report"], limit = 20): (event: ErrorEvent | PromiseRejectionEvent) => void {
  let sent = 0;
  let last = "";
  return (event) => {
    try {
      let kind: "error" | "rejection";
      let message: string;
      let stack: unknown;
      if ("reason" in event) {
        kind = "rejection";
        const reason: unknown = event.reason;
        if (reason instanceof Error) [message, stack] = [reason.message, reason.stack];
        else message = typeof reason === "string" ? reason : text(reason);
      } else {
        kind = "error";
        message = event.message;
        stack = (event.error as { stack?: unknown } | null | undefined)?.stack;
      }
      const key = `${kind}\n${message}`;
      if (sent >= limit || key === last) return;
      last = key;
      sent++;
      send({ kind, message, ...(typeof stack === "string" ? { stack } : {}) }).catch(() => {});
    } catch {
      // never throw out of an error handler
    }
  };
}
