/** The shared transfer dialog (`@thoth/app-ui/transfer`), wired to this window's session. */
import { TransferDialog as Shared, type TransferTarget } from "@thoth/app-ui/transfer/TransferDialog.tsx";
import { useSession } from "../../app/context.ts";

export { problemText, type TransferTarget } from "@thoth/app-ui/transfer/TransferDialog.tsx";

export function TransferDialog({ target, onClose }: { target: TransferTarget; onClose(): void }) {
  const { servers, transfers, openPage, openWorkspacePage } = useSession();
  return <Shared target={target} onClose={onClose} servers={servers} transfers={transfers} openPage={openPage} openWorkspacePage={openWorkspacePage} />;
}
