import { useCallback, useMemo } from "react";
import { PageFrame } from "@thoth/app-ui/editor/PageFrame.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { Backlinks } from "./Backlinks.tsx";
import { loadLinkLookup, vaultPageStore } from "./vault-store.ts";

/** A page of the Private Space: a Markdown file in the vault. */
export function PageView({ path }: { path: string }) {
  const { vault, connection, revision, openPage, refresh } = useSession();
  const strings = useDesktopStrings();
  const t = strings.page;
  const store = useMemo(() => vaultPageStore(vault, path), [vault, path]);
  const loadLinks = useCallback(() => loadLinkLookup(vault, path), [vault, path]);
  const onWritten = useCallback(() => void refresh().catch(() => undefined), [refresh]);
  return (
    <PageFrame
      label={path}
      store={store}
      modeKey={{ space: connection.root, page: path }}
      crumbs={{ badge: <span className="badge badge-private">{strings.shell.local}</span>, parts: path.split("/") }}
      checkTick={revision}
      onWritten={onWritten}
      loadLinks={loadLinks}
      linkTick={revision}
      openLink={openPage}
      openCopy={openPage}
      readOnlyNote={t.readOnly}
      missing={{ title: t.goneTitle, detail: t.goneDetail(path) }}
      footer={<Backlinks path={path} />}
    />
  );
}
