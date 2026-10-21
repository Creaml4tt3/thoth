/**
 * App-wide session handed to every feature. Owned by the shell (`src/app`);
 * features read it through `useSession()` and never construct ports themselves.
 */
import { createContext, useContext } from "react";
import type { Vault } from "@thoth/local-store";
import type { Platform, VaultConnection } from "@thoth/platform";

export interface Session {
  platform: Platform;
  connection: VaultConnection;
  vault: Vault;
  /** Bumped after any change to the index (save, reconcile, import) so views re-query. */
  revision: number;
  /** Call after mutating the vault outside the shell (e.g. an import) to refresh views. */
  refresh(): Promise<void>;
  /** Opens a page in the editor. */
  openPage(path: string): void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession() outside an open vault");
  return session;
}
