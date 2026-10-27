/**
 * The desktop's transfer service: one `TransferEngine` per open Private Space, wired to the vault and to the
 * servers the host knows (every request goes through `ServerDirectory.client`, where the host adds the
 * credential). The service itself is shared with the web client (`@thoth/app-ui/transfer/service.ts`).
 */
import type { Vault } from "@thoth/local-store";
import type { ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import { createTransferService as createService, serverAccess, type TransferService } from "@thoth/app-ui/transfer/service.ts";
import { TransferEngine, type OperationRecord } from "@thoth/transfer";

export { pendingCleanups, unfinished, type TransferService, type TransferState } from "@thoth/app-ui/transfer/service.ts";

export function createTransferService(
  vault: Vault,
  servers: ServerDirectory,
  /** `onSettled`: a started or resumed transfer ended (or was interrupted); not called for an undo. */
  options: { now?: () => Date; onChanged?: () => void; onSettled?: (record: OperationRecord, interrupted: boolean) => void } = {},
): TransferService {
  const { now, ...rest } = options;
  return createService((onProgress) => new TransferEngine({ vault, server: serverAccess(servers), ...(now ? { now } : {}), onProgress }), rest);
}
