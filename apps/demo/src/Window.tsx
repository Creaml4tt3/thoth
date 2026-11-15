/** A working Thoth window: the sample vault as a tree, pages in tabs, the real editor with its Blocks | Plain switch. */
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PageFrame } from "@thoth/app-ui/editor/PageFrame.tsx";
import { createLinkSuggester } from "@thoth/app-ui/editor/link-suggest.ts";
import { buildLinkLookup } from "@thoth/app-ui/editor/links.ts";
import { Disclosure, FolderIcon, PageIcon } from "@thoth/app-ui/order/icons.tsx";
import { TreeGroup } from "@thoth/app-ui/order/TreeGroup.tsx";
import { treeKeyDown, useRovingTabStop } from "@thoth/app-ui/order/tree-keys.ts";
import { STRINGS, type Lang } from "@thoth/app-ui/strings/index.ts";
import { Icon } from "@thoth/app-ui/ui/Icon.tsx";
import type { Vault } from "./store.ts";

const noop = () => undefined;

interface Node {
  kind: "folder" | "page";
  path: string;
  title: string;
  children: Node[];
}

/** Folders first, then pages, each A to Z: the app's order for a vault with no order of its own. */
function buildTree(vault: Vault, lang: Lang): Node[] {
  const collator = new Intl.Collator(lang, { numeric: true, sensitivity: "base" });
  const root: Node = { kind: "folder", path: "", title: "", children: [] };
  const folders = new Map([["", root]]);
  const folder = (path: string): Node => {
    let node = folders.get(path);
    if (!node) {
      const cut = path.lastIndexOf("/");
      node = { kind: "folder", path, title: path.slice(cut + 1), children: [] };
      folder(cut < 0 ? "" : path.slice(0, cut)).children.push(node);
      folders.set(path, node);
    }
    return node;
  };
  for (const f of vault.folders) folder(f);
  for (const s of vault.summaries) {
    const cut = s.path.lastIndexOf("/");
    folder(cut < 0 ? "" : s.path.slice(0, cut)).children.push({ kind: "page", path: s.path, title: s.title, children: [] });
  }
  const sort = (node: Node) => {
    node.children.sort((a, b) => (a.kind === b.kind ? collator.compare(a.title, b.title) : a.kind === "folder" ? -1 : 1));
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function Tree({ nodes, label, current, open, toggle, openPage }: { nodes: Node[]; label: string; current: string | null; open: Set<string>; toggle(path: string, to?: boolean): void; openPage(path: string): void }) {
  const list = useRef<HTMLUListElement>(null);
  useRovingTabStop(list);
  const row = (n: Node, depth: number, index: number, size: number) => {
    const isFolder = n.kind === "folder";
    const expanded = open.has(n.path);
    const selected = !isFolder && current === n.path;
    return (
      <li key={n.path} role="none">
        <button
          type="button"
          role="treeitem"
          aria-selected={selected}
          aria-current={selected ? "page" : undefined}
          {...(isFolder ? { "aria-expanded": expanded } : {})}
          aria-level={depth + 1}
          aria-posinset={index}
          aria-setsize={size}
          data-tree-id={n.path}
          data-kind={n.kind}
          className="tree-item"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (isFolder ? toggle(n.path) : openPage(n.path))}
          onKeyDown={(event: KeyboardEvent<HTMLElement>) => treeKeyDown(event, { expandable: isFolder, expanded, expand: () => toggle(n.path, true), collapse: () => toggle(n.path, false) })}
        >
          <Disclosure open={expanded} hidden={!isFolder} />
          {isFolder ? <FolderIcon open={expanded} /> : <PageIcon />}
          <span className="tree-label">{n.title}</span>
        </button>
        {isFolder && (
          <TreeGroup open={expanded} count={n.children.length} label={n.title}>
            {n.children.map((c, i) => row(c, depth + 1, i + 1, n.children.length))}
          </TreeGroup>
        )}
      </li>
    );
  };
  return (
    <div className="tree-wrap">
      <ul role="tree" aria-label={label} ref={list}>
        {nodes.map((n, i) => row(n, 0, i + 1, nodes.length))}
      </ul>
    </div>
  );
}

function Tabs({ tabs, active, titleOf, label, closeLabel, activate, close, idBase }: { tabs: string[]; active: string | null; titleOf(path: string): string; label: string; closeLabel: string; activate(path: string): void; close(path: string): void; idBase: string }) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focus = (path: string | undefined) => setTimeout(() => path && buttons.current.get(path)?.focus(), 0);
  const keys = (event: KeyboardEvent, path: string) => {
    const at = tabs.indexOf(path);
    const go = (to: number) => {
      const next = tabs[(to + tabs.length) % tabs.length]!;
      activate(next);
      buttons.current.get(next)?.focus();
    };
    switch (event.key) {
      case "ArrowRight": return event.preventDefault(), go(at + 1);
      case "ArrowLeft": return event.preventDefault(), go(at - 1);
      case "Home": return event.preventDefault(), go(0);
      case "End": return event.preventDefault(), go(tabs.length - 1);
      // The close "button" is for the pointer, as in the app (a tablist owns tabs only); the keyboard closes with Delete.
      case "Delete": event.preventDefault(); focus(tabs[at + 1] ?? tabs[at - 1]); return close(path);
    }
  };
  return (
    <div className="tabstrip">
      <div role="tablist" aria-label={label} aria-orientation="horizontal" className="tablist">
        {tabs.map((path, i) => (
          <div key={path} role="none" className="tab" data-selected={path === active || undefined}>
            <button
              ref={(el) => void (el ? buttons.current.set(path, el) : buttons.current.delete(path))}
              type="button"
              role="tab"
              id={`${idBase}-tab-${i}`}
              aria-selected={path === active}
              aria-controls={`${idBase}-panel`}
              tabIndex={path === active ? 0 : -1}
              className="tab-label"
              onClick={() => activate(path)}
              onKeyDown={(event) => keys(event, path)}
            >
              <span className="tab-text">{titleOf(path)}</span>
            </button>
            <span className="tab-close" aria-hidden="true" title={closeLabel} onClick={() => close(path)}>
              <Icon name="close" size={12} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Page({ vault, path, lang, open }: { vault: Vault; path: string; lang: Lang; open(path: string): void }) {
  const t = STRINGS[lang].workspace;
  const loadLinks = useMemo(() => {
    const links = { lookup: buildLinkLookup(path, [], vault.summaries, vault.folders), suggester: createLinkSuggester(path, vault.summaries, vault.folders) };
    return async () => links;
  }, [vault, path]);
  return (
    <PageFrame
      label={vault.titleOf(path)}
      store={vault.storeFor(path)}
      modeKey={{ space: "demo", page: path }}
      crumbs={{ badge: vault.name, parts: path.replace(/\.md$/, "").split("/") }}
      checkTick={0}
      onWritten={noop}
      loadLinks={loadLinks}
      linkTick={0}
      openLink={(target) => vault.has(target) && open(target)}
      openCopy={noop}
      readOnlyNote=""
      missing={{ title: t.missingTitle, detail: t.missingDetail }}
    />
  );
}

export function Window({ vault, lang }: { vault: Vault; lang: Lang }) {
  const strings = STRINGS[lang];
  const idBase = useId();
  const nodes = useMemo(() => buildTree(vault, lang), [vault, lang]);
  const [open, setOpen] = useState(() => new Set(vault.folders));
  const [tabs, setTabs] = useState([vault.first]);
  const [active, setActive] = useState<string | null>(vault.first);

  const toggle = useCallback((path: string, to?: boolean) => {
    setOpen((was) => {
      const next = new Set(was);
      if (to ?? !was.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);
  // A page that has a tab is focused; any other opens in a new tab after the current one.
  const openPage = useCallback(
    (path: string) => {
      setTabs((was) => (was.includes(path) ? was : [...was, path]));
      setActive(path);
    },
    [],
  );
  const close = (path: string) => {
    const at = tabs.indexOf(path);
    setTabs(tabs.filter((p) => p !== path));
    if (active === path) setActive(tabs[at + 1] ?? tabs[at - 1] ?? null);
  };

  return (
    <div className="shell demo-window">
      <nav className="sidebar" aria-label={vault.name}>
        <div className="sec">
          <span className="sec-name">{vault.name}</span>
        </div>
        <Tree nodes={nodes} label={vault.name} current={active} open={open} toggle={toggle} openPage={openPage} />
      </nav>
      <div className="main">
        {tabs.length > 0 && <Tabs tabs={tabs} active={active} titleOf={vault.titleOf} label={strings.tabs.list} closeLabel={strings.tabs.close} activate={setActive} close={close} idBase={idBase} />}
        {active ? (
          <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${tabs.indexOf(active)}`} className="tab-panel">
            <Page key={active} vault={vault} path={active} lang={lang} open={openPage} />
          </div>
        ) : (
          <div className="tab-panel">
            <div className="empty">
              <h1>{strings.tabs.blank}</h1>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
