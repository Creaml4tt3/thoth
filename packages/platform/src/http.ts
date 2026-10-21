/**
 * Browser `Transport` for the e2e dev bridge: commands go to a local HTTP relay
 * that forwards them to the Rust host harness (`tests/e2e/bridge.ts`).
 * TEST INFRASTRUCTURE: the desktop app never uses it; it only exists so a real
 * browser can drive the real UI against the real Rust host.
 */
import type { Platform } from "./index.ts";
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

export function createHttpPlatform(base: string, token: string): Platform {
  return createRemotePlatform(new HttpTransport(base, token), "bridge");
}
