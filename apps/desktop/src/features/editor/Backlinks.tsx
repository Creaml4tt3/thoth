import { useEffect, useState } from "react";
import type { Backlink } from "@thoth/local-store";
import { useSession } from "../../app/context.ts";

/** Pages that link here, from the index. Re-queries when the session revision changes. */
export function Backlinks({ path }: { path: string }) {
  const { vault, revision, openPage } = useSession();
  const [links, setLinks] = useState<Backlink[] | null>(null);

  useEffect(() => {
    let live = true;
    vault
      .backlinks(path)
      .then((result) => live && setLinks(result))
      .catch(() => live && setLinks([]));
    return () => {
      live = false;
    };
  }, [vault, path, revision]);

  const pages = links ? [...new Map(links.map((l) => [l.sourcePath, l])).values()] : [];
  return (
    <section className="backlinks" aria-labelledby="backlinks-title">
      <h2 id="backlinks-title">Backlinks{links ? ` (${pages.length})` : ""}</h2>
      {links && pages.length === 0 ? (
        <p className="muted">No page links here yet.</p>
      ) : (
        <ul>
          {pages.map((link) => (
            <li key={link.sourcePath}>
              <button type="button" onClick={() => openPage(link.sourcePath)}>
                <span>{link.sourceTitle}</span>
                <span className="muted mono">{link.sourcePath}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
