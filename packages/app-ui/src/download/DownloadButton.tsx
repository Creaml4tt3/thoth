import { useContext, useState, useSyncExternalStore } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import { useStrings } from "../strings/index.ts";
import { PageHostContext } from "../editor/host.ts";
import { workspaceKey, type DirectoryState, type ServerDirectory, type WorkspacePageRef } from "../workspace/directory.ts";
import { markdownFileName } from "./download.ts";

/**
 * Downloads a page as Markdown: pending edits are written first, then its text is saved as one `.md` file named after
 * its title. `download` is null where the host cannot save files. `said` is what happened, for a status region.
 */
export function useDownload(): { download: ((title: string, read: () => Promise<string>) => Promise<void>) | null; said: string } {
  const host = useContext(PageHostContext);
  const t = useStrings().download;
  const [said, setSaid] = useState("");
  const save = host?.saveFile;
  if (!save) return { download: null, said };
  const download = async (title: string, read: () => Promise<string>) => {
    setSaid("");
    try {
      if (host?.flushAll && !(await host.flushAll())) return;
      const name = markdownFileName(title);
      if (await save(name, await read())) setSaid(t.saved(name));
    } catch (failure) {
      setSaid(t.failed(failure instanceof Error ? failure.message : String(failure)));
    }
  };
  return { download, said };
}

/** A status line a screen reader reads: what a download did. */
export function DownloadStatus({ said }: { said: string }) {
  return (
    <span className="sr-only" aria-live="polite" aria-atomic="true" data-download-said>
      {said}
    </span>
  );
}

/** "Download as Markdown" in a page's header. Nothing where the host cannot save files. */
export function DownloadButton({ title, read }: { title: string; read(): Promise<string> }) {
  const t = useStrings().download;
  const { download, said } = useDownload();
  if (!download) return null;
  return (
    <>
      <IconButton icon="import" label={t.button} onClick={() => void download(title, read)} />
      <DownloadStatus said={said} />
    </>
  );
}

/**
 * The same for a workspace page: its current text from the server. Hidden where the workspace does not let its pages be
 * copied out (export restriction, ADR-0009), as Copy to Private Space is refused there.
 */
export function WorkspaceDownloadButton({ directory, target }: { directory: ServerDirectory; target: WorkspacePageRef }) {
  const state = useSyncExternalStore(directory.subscribe, directory.getState);
  if (!workspaceCanDownload(state, target)) return null;
  const title = state.trees[workspaceKey(target.server, target.workspace)]?.nodes.find((n) => n.id === target.page)?.title ?? "";
  return <DownloadButton title={title} read={() => readWorkspaceMarkdown(directory, target)} />;
}

/** A workspace page can be downloaded where its workspace lets pages be copied out (ADR-0009). */
export function workspaceCanDownload(state: DirectoryState, target: { server: string; workspace: string }): boolean {
  const workspace = state.servers.find((s) => s.info.id === target.server)?.workspaces?.find((w) => w.id === target.workspace);
  return workspace !== undefined && !workspace.exportRestricted;
}

/** The page's current text on the server. */
export const readWorkspaceMarkdown = async (directory: ServerDirectory, target: WorkspacePageRef): Promise<string> => (await directory.client(target.server).getPage(target.workspace, target.page)).markdown;
