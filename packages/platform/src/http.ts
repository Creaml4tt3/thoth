/**
 * Browser `Transport` for the e2e dev bridge: commands go to a local HTTP relay
 * that forwards them to the Rust host harness (`tests/e2e/bridge.ts`).
 * TEST INFRASTRUCTURE: the desktop app never uses it; it only exists so a real
 * browser can drive the real UI against the real Rust host.
 */
import type { Platform, Windows } from "./index.ts";
import type { CommandName, Commands, Transport, VaultChangedEvent } from "./ipc.ts";
import { HostCallError, createRemotePlatform, decodeBase64, encodeBase64, isHostErrorShape } from "./remote.ts";

export class HttpTransport implements Transport {
  private readonly base: string;
  private readonly token: string;

  constructor(base: string, token: string) {
    this.base = base;
    this.token = token;
  }

  async call<C extends CommandName>(command: C, args: Commands[C]["args"], bytes?: Uint8Array): Promise<Commands[C]["result"]> {
    const response = await fetch(`${this.base}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-thoth-bridge": this.token },
      body: JSON.stringify({ command, args, ...(bytes ? { bytes: encodeBase64(bytes) } : {}) }),
    });
    const message = (await response.json()) as { ok: boolean; result?: unknown; bytes?: string; error?: unknown };
    if (message.ok) return (typeof message.bytes === "string" ? decodeBase64(message.bytes) : (message.result ?? null)) as Commands[C]["result"];
    if (isHostErrorShape(message.error)) throw new HostCallError(message.error.code, message.error.message);
    throw new HostCallError("INTERNAL", "Malformed bridge response");
  }

  async listen(_event: "vault.changed", handler: (payload: VaultChangedEvent) => void): Promise<() => void> {
    const source = new EventSource(`${this.base}/events?token=${encodeURIComponent(this.token)}`);
    source.onmessage = (event: { data: string }) => handler(JSON.parse(event.data) as VaultChangedEvent);
    return () => source.close();
  }
}

/**
 * Thoth's windows for the bridge (ADR-0019): a new window is a browser window on the same page with the address the
 * desktop shell would build (`?window=…&root=…&tabs=…`), so a test can drive both against the one Rust host. A page
 * that goes away tells the others on a BroadcastChannel. This window never closes itself (`closeThis` is false).
 */
function bridgeWindows(): Windows {
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("thoth-bridge-windows") : null;
  const self = new URLSearchParams(globalThis.location?.search ?? "").get("window") ?? "main";
  globalThis.addEventListener?.("pagehide", () => channel?.postMessage({ closed: self }));
  return {
    async open({ id, root, tabs }) {
      const page = `${location.origin}${location.pathname}?window=${encodeURIComponent(id)}&root=${encodeURIComponent(root)}&tabs=${encodeURIComponent(tabs)}`;
      if (!window.open(page, id)) throw new Error("The window could not be opened");
    },
    closeThis: async () => false,
    async onClosed(listener) {
      const receive = (event: MessageEvent) => {
        const closed = (event.data as { closed?: unknown } | null)?.closed;
        if (typeof closed === "string") listener(closed);
      };
      channel?.addEventListener("message", receive);
      return () => channel?.removeEventListener("message", receive);
    },
  };
}

export function createHttpPlatform(base: string, token: string): Platform {
  return { ...createRemotePlatform(new HttpTransport(base, token), "bridge"), windows: bridgeWindows() };
}
