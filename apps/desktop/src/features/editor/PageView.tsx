import { useCallback, useMemo } from "react";
import { basename, stripExtension } from "@thoth/domain";
import { PageFrame } from "@thoth/app-ui/editor/PageFrame.tsx";
import { FavoriteButton } from "@thoth/app-ui/favorites/FavoriteButton.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { PRIVATE_SECTION } from "../shell/sections.ts";
import { requestShowSidebar } from "@thoth/app-ui/ui/sidebar-hidden.ts";
import { Backlinks } from "./Backlinks.tsx";
import { loadLinkLookup, vaultPageStore } from "./vault-store.ts";
import { vaultPageMedia } from "./vault-media.ts";

/** Focuses what `find` returns once it is on screen (the sidebar opens a folder a moment after it is asked to), and scrolls it into view. */
function focusWhenShown(find: () => HTMLElement | null, tries = 40): void {
  const el = find();
  if (el && !el.closest("[hidden]")) {
    el.focus();
    el.scrollIntoView?.({ block: "nearest" });
  } else if (tries > 0) setTimeout(() => focusWhenShown(find, tries - 1), 30);
}

/** A page of the Private Space: a Markdown file in the vault. */
export function PageView({ path }: { path: string }) {
  const { vault, connection, revision, openPage, openFolder, refresh, notifications } = useSession();
  const strings = useDesktopStrings();
  const t = strings.page;
  const store = useMemo(() => vaultPageStore(vault, path), [vault, path]);
  const media = useMemo(() => vaultPageMedia(vault, path), [vault, path]);
  const loadLinks = useCallback(() => loadLinkLookup(vault, path), [vault, path]);
  const onWritten = useCallback(() => void refresh().catch(() => undefined), [refresh]);
  // A save conflict is a notification (ADR-0018): the page's name and where it is, nothing of its text.
  const onConflict = useCallback(
    (event: { kind: "shown" } | { kind: "resolved" }) => {
      if (event.kind === "shown") notifications.push({ kind: "saveConflict", page: stripExtension(basename(path)), open: { kind: "page", path } });
    },
    [notifications, path],
  );
  return (
    <PageFrame
      label={path}
      store={store}
      media={media}
      modeKey={{ space: connection.root, page: path }}
      crumbs={{
        badge: <span className="badge badge-private">{strings.shell.local}</span>,
        parts: path.split("/"),
        // A folder crumb opens that folder in the sidebar and moves focus to its row; the badge goes to the section.
        onCrumb: (index) => {
          const folder = path.split("/").slice(0, index + 1).join("/");
          openFolder(folder, { openFirstPage: false });
          focusWhenShown(() => [...document.querySelectorAll<HTMLElement>(".private-tree [data-tree-id]")].find((el) => el.dataset["treeId"] === folder) ?? null);
        },
        onBadge: () => {
          requestShowSidebar();
          focusWhenShown(() => document.querySelector<HTMLElement>(`[data-section="${PRIVATE_SECTION}"] .sec-toggle`));
        },
      }}
      checkTick={revision}
      onWritten={onWritten}
      loadLinks={loadLinks}
      linkTick={revision}
      openLink={openPage}
      openCopy={openPage}
      onConflict={onConflict}
      readOnlyNote={t.readOnly}
      missing={{ title: t.goneTitle, detail: t.goneDetail(path) }}
      footer={<Backlinks path={path} />}
      actions={<FavoriteButton target={{ kind: "private", path }} />}
    />
  );
}
