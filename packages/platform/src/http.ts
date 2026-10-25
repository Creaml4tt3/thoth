/**
 * Browser `Transport` for the e2e dev bridge: commands go to a local HTTP relay
 * that forwards them to the Rust host harness (`tests/e2e/bridge.ts`).
 * TEST INFRASTRUCTURE: the desktop app never uses it; it only exists so a real
 * browser can drive the real UI against the real Rust host.
 */
import type { ConnectedApps, Platform, Windows } from "./index.ts";
import type { CommandName, Commands, McpRequest, Transport, VaultChangedEvent } from "./ipc.ts";
import { HostCallError, createRemotePlatform, decodeBase64, encodeBase64, isHostErrorShape, remoteConnectedApps } from "./remote.ts";

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
      // `owner`: which window asks (ADR-0019), as the desktop shell knows the webview that calls.
      body: JSON.stringify({ command, args, owner: thisWindow(), ...(bytes ? { bytes: encodeBase64(bytes) } : {}) }),
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

/** This page's window id (`?window=`), "main" by default. */
function thisWindow(): string {
  return new URLSearchParams(globalThis.location?.search ?? "").get("window") ?? "main";
}

/**
 * Thoth's windows for the bridge (ADR-0019): a new window is a browser window on the same page with the address the
 * desktop shell would build (`?window=…&root=…&tabs=…`), so a test can drive both against the one Rust host. A page
 * that goes away tells the others on a BroadcastChannel. This window never closes itself (`closeThis` is false) and is
 * never asked to.
 */
function bridgeWindows(): Windows {
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("thoth-bridge-windows") : null;
  const self = thisWindow();
  globalThis.addEventListener?.("pagehide", () => channel?.postMessage({ closed: self }));
  return {
    async open({ id, root, tabs }) {
      const page = `${location.origin}${location.pathname}?window=${encodeURIComponent(id)}&root=${encodeURIComponent(root)}&tabs=${encodeURIComponent(tabs)}`;
      if (!window.open(page, id)) throw new Error("The window could not be opened");
    },
    closeThis: async () => false,
    // A browser window has no close button the page could answer for.
    onCloseRequested: async () => () => undefined,
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

/**
 * Connected apps (ADR-0021) for the bridge: the `mcp.*` commands, and the host's `mcp.request` and `mcp.pending` events
 * as named events on the bridge's event stream.
 */
function bridgeConnectedApps(transport: HttpTransport, base: string, token: string): ConnectedApps {
  // One stream for every listener of this page: browsers allow only a few connections per host, and two windows'
  // streams must not use up the ones their commands need.
  let source: EventSource | null = null;
  let listeners = 0;
  const on = async <T>(event: string, listener: (payload: T) => void): Promise<() => void> => {
    source ??= new EventSource(`${base}/events?token=${encodeURIComponent(token)}`);
    const stream = source;
    const receive = (e: Event) => listener(JSON.parse((e as MessageEvent<string>).data) as T);
    stream.addEventListener(event, receive);
    listeners++;
    return () => {
      stream.removeEventListener(event, receive);
      if (--listeners === 0 && source === stream) {
        stream.close();
        source = null;
      }
    };
  };
  return remoteConnectedApps(transport, {
    onRequest: (listener) => on<McpRequest>("mcp.request", listener),
    onPending: (listener) => on<{ apps: string[] }>("mcp.pending", (payload) => listener(payload.apps)),
  });
}

export function createHttpPlatform(base: string, token: string): Platform {
  const transport = new HttpTransport(base, token);
  return { ...createRemotePlatform(transport, "bridge"), windows: bridgeWindows(), connectedApps: bridgeConnectedApps(transport, base, token) };
}
