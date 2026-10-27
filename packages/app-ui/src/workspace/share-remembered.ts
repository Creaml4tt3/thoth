/**
 * Share links made on this device (ADR-0023 amendment of 2026-10-28). The server keeps only a hash of a link's token,
 * so it can never give an address back; the app keeps the address of each link it makes, here in this device's
 * storage, so the Share dialog can show and copy it later. Links made on another device or before this version have
 * no address to show. Keyed by the link's ID (server-made, unique); forgotten when revoked.
 */
export const REMEMBERED_KEY = "thoth.shareLinks.v1";
/** At most this many addresses are kept; the oldest go first. */
const MAX = 500;

type Store = Record<string, string>;

function read(): Store {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(REMEMBERED_KEY) ?? "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].startsWith("https://")));
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    globalThis.localStorage?.setItem(REMEMBERED_KEY, JSON.stringify(store));
  } catch {
    // Storage full or off: the address is simply not shown again.
  }
}

export function rememberedUrl(id: string): string | undefined {
  return read()[id];
}

export function rememberLink(id: string, url: string): void {
  const entries = Object.entries(read()).filter(([key]) => key !== id);
  entries.push([id, url]);
  write(Object.fromEntries(entries.slice(-MAX)));
}

export function forgetLink(id: string): void {
  const store = read();
  if (!(id in store)) return;
  delete store[id];
  write(store);
}
