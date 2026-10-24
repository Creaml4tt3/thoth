import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { Notice } from "@thoth/app-ui/ui/Notice.tsx";
import type { WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";
import { WorkspacePage } from "@thoth/app-ui/workspace/WorkspacePage.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { ServerCard } from "./ServersSettings.tsx";

/**
 * A workspace page in the desktop app: the shared `WorkspacePage`, plus what is the desktop's own business,
 * signing in again over the open page through the host.
 */
export function WorkspacePageView({ target }: { target: WorkspacePageRef }) {
  const { servers, openWorkspacePage, openSettings } = useSession();
  const t = useDesktopStrings().servers;
  const directory = useSyncExternalStore(servers.subscribe, servers.getState);
  const entry = directory.servers.find((s) => s.info.id === target.server);
  const signedOut = entry?.info.auth === "signed-out";
  /** Signing in over the open page, so unsaved edits stay where they are. */
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    if (!signedOut) setSigningIn(false);
  }, [signedOut]);

  return (
    <>
      <WorkspacePage
        directory={servers}
        target={target}
        modeSpace={entry?.info.url ?? target.server}
        openPage={openWorkspacePage}
        goneNotice={<Notice title={t.removedTitle} detail={t.removedDetail} />}
        signedOutNotice={
          <Notice title={t.signedOutOf(entry?.info.label ?? "")} detail={t.signInAgainDetail}>
            <Button variant="primary" small onClick={() => openSettings("servers")}>
              {t.signIn}
            </Button>
          </Notice>
        }
        signedOutAction={
          <Button variant="quiet" small onClick={() => setSigningIn(true)}>
            {t.signIn}
          </Button>
        }
      />
      {signingIn && signedOut && entry && (
        <Modal title={t.signInTo(entry.info.label)} onClose={() => setSigningIn(false)}>
          <p className="muted">{t.editsStay}</p>
          <ServerCard info={entry.info} error={null} directory={servers} signInOnly />
        </Modal>
      )}
    </>
  );
}
