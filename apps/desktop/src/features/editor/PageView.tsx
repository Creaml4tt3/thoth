import { useCallback, useMemo } from "react";
import { PageFrame } from "@thoth/app-ui/editor/PageFrame.tsx";
import { useSession } from "../../app/context.ts";
import { Backlinks } from "./Backlinks.tsx";
import { loadLinkLookup, vaultPageStore } from "./vault-store.ts";

/** A page of the Private Space: a Markdown file in the vault. */
export function PageView({ path }: { path: string }) {
  const { vault, connection, revision, openPage, refresh } = useSession();
  const store = useMemo(() => vaultPageStore(vault, path), [vault, path]);
  const loadLinks = useCallback(() => loadLinkLookup(vault, path), [vault, path]);
  const onWritten = useCallback(() => void refresh().catch(() => undefined), [refresh]);
  return (
    <PageFrame
      label={path}
      store={store}
      modeKey={{ space: connection.root, page: path }}
      crumbs={{ badge: <span className="badge badge-private">Local</span>, parts: path.split("/") }}
      checkTick={revision}
      onWritten={onWritten}
      loadLinks={loadLinks}
      linkTick={revision}
      openLink={openPage}
      openCopy={openPage}
      readOnlyNote="This file is not valid UTF-8, so Thoth shows it read-only and will never write to it. Open it in another editor to change it."
      missing={{ title: "This page is gone", detail: `${path} no longer exists on disk.` }}
      footer={<Backlinks path={path} />}
    />
  );
}
