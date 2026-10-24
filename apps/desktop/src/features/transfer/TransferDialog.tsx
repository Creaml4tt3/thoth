/**
 * Copy or move pages between the Private Space and a workspace (spec §9.1–9.4, ADR-0006, ADR-0009).
 *
 * Three phases in one dialog:
 * 1. choose: destination (workspace and parent, or a vault folder) and copy or move;
 * 2. preview: who will see the pages, how every link is classified, what blocks and what deserves a warning.
 *    Nothing has left the computer (or been written) yet, and the dialog says so;
 * 3. run: progress through the ADR-0006 states, then a result that states plainly what happened, including
 *    `destination_committed_source_cleanup_pending` (originals kept) and a retry or undo when interrupted.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TransferState as EngineState } from "@thoth/domain";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { nestWorkspaceTree, type WorkspaceTreeItem } from "@thoth/app-ui/workspace/tree.ts";
import { workspaceKey } from "@thoth/app-ui/workspace/directory.ts";
import type { OperationRecord, Preview, Problem, Warning } from "@thoth/transfer";
import type { Workspace } from "@thoth/workspace-protocol";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings, type DesktopStrings } from "../../strings/index.ts";

type T = DesktopStrings["transfer"];

export type TransferTarget =
  | { direction: "to_workspace"; paths: string[]; mode: "copy" | "move" }
  | { direction: "from_workspace"; server: string; workspace: string; pageId: string; title: string; mode: "copy" | "move" };

const STEPS: readonly EngineState[] = ["validate", "stage", "transfer", "verify", "commit_destination", "finalize_source"];

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function problemText(p: Problem, t: T): string {
  switch (p.code) {
    case "unreachable":
      return t.problems.unreachable(p.message);
    case "forbidden":
      return t.problems.forbidden(t.roles[p.role]);
    case "not_editable":
      return t.problems.not_editable(p.path);
    case "malformed_frontmatter":
      return t.problems.malformed_frontmatter(p.path);
    case "page_too_large":
      return t.problems.page_too_large(p.path, bytes(p.size), bytes(p.limit));
    case "too_large_total":
      return t.problems.too_large_total(bytes(p.size), bytes(p.limit));
    case "quota":
      return t.problems.quota(p.limit, p.current, p.adding);
    default:
      return t.problems[p.code];
  }
}

function warningText(w: Warning, t: T): string {
  switch (w.code) {
    case "attachment_too_large":
      return t.warnings.attachment_too_large(w.path, bytes(w.size), bytes(w.limit));
    case "quota_near":
      return t.warnings.quota_near(w.limit, w.current, w.adding);
    default:
      return t.warnings[w.code](w.count);
  }
}

interface Destination {
  server: string;
  workspace: string;
}

/** Workspaces the user is signed in to, across servers. */
function useWorkspaces(): { server: string; serverLabel: string; workspace: Workspace }[] {
  const { servers } = useSession();
  const state = useSyncExternalStore(servers.subscribe, servers.getState);
  return useMemo(
    () => state.servers.flatMap((s) => (s.info.auth === "signed-out" ? [] : (s.workspaces ?? []).map((workspace) => ({ server: s.info.id, serverLabel: s.info.label, workspace })))),
    [state.servers],
  );
}

function flatten(items: WorkspaceTreeItem[], depth = 0): { id: string; title: string; depth: number }[] {
  return items.flatMap((i) => [{ id: i.id, title: i.title, depth }, ...flatten(i.children, depth + 1)]);
}

export function TransferDialog({ target, onClose }: { target: TransferTarget; onClose(): void }) {
  const { servers, transfers, openPage, openWorkspacePage } = useSession();
  const t = useDesktopStrings().transfer;
  const all = useWorkspaces();
  const writable = all.filter((w) => w.workspace.role !== "viewer");
  const [mode, setMode] = useState(target.mode);
  const [dest, setDest] = useState<Destination | null>(() => (target.direction === "to_workspace" && writable[0] ? { server: writable[0].server, workspace: writable[0].workspace.id } : null));
  const [parentId, setParentId] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [attachments, setAttachments] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<{ id: string | null; record: OperationRecord | null; interrupted: string | null; busy: boolean }>({ id: null, record: null, interrupted: null, busy: false });
  const live = useSyncExternalStore(transfers.subscribe, transfers.getState);
  const record = (run.id ? live.records[run.id] : null) ?? run.record;
  const resultRef = useRef<HTMLDivElement>(null);

  const directory = useSyncExternalStore(servers.subscribe, servers.getState);
  const tree = dest ? directory.trees[workspaceKey(dest.server, dest.workspace)] : undefined;
  useEffect(() => {
    if (dest && target.direction === "to_workspace" && !tree) void servers.loadTree(dest.server, dest.workspace);
  }, [dest, servers, target.direction, tree]);
  const parents = useMemo(() => flatten(nestWorkspaceTree(tree?.nodes ?? [])), [tree]);

  // Re-check whenever a choice changes. Reads only.
  const request = useMemo(() => {
    if (target.direction === "to_workspace") return dest ? { kind: "to" as const, req: { server: dest.server, workspace: dest.workspace, parentId, mode, paths: target.paths, attachments } } : null;
    return { kind: "from" as const, req: { server: target.server, workspace: target.workspace, mode, pageIds: [target.pageId], folder } };
  }, [target, dest, parentId, mode, attachments, folder]);
  useEffect(() => {
    if (!request || run.id) return;
    let current = true;
    setChecking(true);
    setError(null);
    const timer = setTimeout(() => {
      const work = request.kind === "to" ? transfers.engine.previewToWorkspace(request.req) : transfers.engine.previewFromWorkspace(request.req);
      work
        .then((p) => current && setPreview(p))
        .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => current && setChecking(false));
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [request, run.id, transfers]);

  const finished = record !== null && ["done", "destination_committed_source_cleanup_pending", "failed", "aborted"].includes(record.state);
  useEffect(() => {
    if (finished || run.interrupted) resultRef.current?.focus();
  }, [finished, run.interrupted]);

  const start = async () => {
    if (!preview?.canStart) return;
    setRun({ id: null, record: null, interrupted: null, busy: true });
    try {
      const outcome = await transfers.start(preview);
      setRun({ id: outcome.record.id, record: outcome.record, interrupted: outcome.interrupted, busy: false });
    } catch (e) {
      setRun({ id: null, record: null, interrupted: null, busy: false });
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const retry = async () => {
    if (!run.id) return;
    setRun((r) => ({ ...r, busy: true, interrupted: null }));
    const outcome = await transfers.resume(run.id).catch((e: unknown) => ({ record: run.record!, interrupted: e instanceof Error ? e.message : String(e) }));
    setRun({ id: run.id, record: outcome.record, interrupted: outcome.interrupted, busy: false });
  };
  const undo = async () => {
    if (!run.id) return;
    setRun((r) => ({ ...r, busy: true }));
    const done = await transfers.abort(run.id).catch(() => run.record!);
    setRun({ id: run.id, record: done, interrupted: null, busy: false });
  };

  const title = target.direction === "to_workspace" ? t.titleTo(mode, target.paths.length) : t.titleFrom(mode, target.title);
  const running = run.busy || (record !== null && !finished && !run.interrupted);
  const where = record ? (record.direction === "to_workspace" ? record.workspace.name : t.privateSpace) : "";

  return (
    <Modal title={title} wide {...(running ? {} : { onClose })}>
      <div className="xfer">
        {record === null && !run.busy ? (
          <>
            {target.direction === "to_workspace" ? (
              <fieldset className="xfer-section">
                <legend className="label">{t.destination}</legend>
                {writable.length === 0 ? (
                  <p className="muted">{t.noWorkspaces}</p>
                ) : (
                  <div className="xfer-grid">
                    <label className="field">
                      <span>{t.workspace}</span>
                      <select
                        data-autofocus
                        className="input"
                        value={dest ? `${dest.server}\n${dest.workspace}` : ""}
                        onChange={(e) => {
                          const [server, workspace] = e.target.value.split("\n") as [string, string];
                          setDest({ server, workspace });
                          setParentId(null);
                        }}
                      >
                        {writable.map((w) => (
                          <option key={`${w.server}\n${w.workspace.id}`} value={`${w.server}\n${w.workspace.id}`}>
                            {all.some((o) => o.server !== w.server) ? `${w.workspace.name} · ${w.serverLabel}` : w.workspace.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>{t.parent}</span>
                      <select className="input" value={parentId ?? ""} onChange={(e) => setParentId(e.target.value === "" ? null : e.target.value)}>
                        <option value="">{t.topLevel}</option>
                        {parents.map((p) => (
                          <option key={p.id} value={p.id}>
                            {`${"  ".repeat(p.depth)}${t.under(p.title)}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </fieldset>
            ) : (
              <fieldset className="xfer-section">
                <legend className="label">{t.destination}</legend>
                <label className="field">
                  <span>{t.folder}</span>
                  <input data-autofocus className="input" value={folder} onChange={(e) => setFolder(e.target.value)} />
                </label>
                <p className="muted small">{t.folderHint}</p>
              </fieldset>
            )}

            <fieldset className="mode-choices xfer-section">
              <legend className="label">{t.mode}</legend>
              {(["copy", "move"] as const).map((m) => {
                const text = m === "copy" ? t.copy : target.direction === "to_workspace" ? t.moveToWs : t.moveFromWs;
                return (
                  <label key={m} className="mode-choice">
                    <input type="radio" name="xfer-mode" checked={mode === m} onChange={() => setMode(m)} />
                    <b>{text.title}</b>
                    <span>{text.hint}</span>
                  </label>
                );
              })}
            </fieldset>

            {target.direction === "to_workspace" && (
              <label className="xfer-check">
                <input type="checkbox" checked={attachments} onChange={(e) => setAttachments(e.target.checked)} />
                <span>{t.attachments}</span>
              </label>
            )}

            <PreviewPanel preview={preview} checking={checking} error={error} t={t} />

            <div className="modal-actions">
              <Button variant="quiet" onClick={onClose}>
                {t.cancel}
              </Button>
              <Button variant="primary" disabled={!preview?.canStart || checking} onClick={() => void start()}>
                {mode === "copy" ? t.startCopy : t.startMove}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Progress record={record} t={t} />
            {(finished || run.interrupted) && record && (
              <div ref={resultRef} tabIndex={-1} className="xfer-result" role={record.state === "failed" || run.interrupted ? "alert" : "status"}>
                <Result record={record} interrupted={run.interrupted} where={where} t={t} />
              </div>
            )}
            <div className="modal-actions">
              {run.interrupted && record && !finished && (
                <>
                  {["plan", "validate", "stage", "transfer", "verify"].includes(record.state) && (
                    <Button variant="quiet" disabled={run.busy} onClick={() => void undo()}>
                      {t.stop}
                    </Button>
                  )}
                  <Button variant="primary" disabled={run.busy} onClick={() => void retry()}>
                    {t.retry}
                  </Button>
                </>
              )}
              {finished && record && (record.state === "done" || record.state === "destination_committed_source_cleanup_pending") && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    const first = record.items.find((i) => i.state !== "failed");
                    onClose();
                    if (!first) return;
                    if (record.direction === "to_workspace") openWorkspacePage({ server: record.server.id, workspace: record.workspace.id, page: first.destId });
                    else if (first.destPath) openPage(first.destPath);
                  }}
                >
                  {t.openResult}
                </Button>
              )}
              {(finished || run.interrupted) && (
                <Button variant="primary" data-autofocus onClick={onClose}>
                  {t.close}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function PreviewPanel({ preview, checking, error, t }: { preview: Preview | null; checking: boolean; error: string | null; t: T }) {
  if (error) return <p role="alert" className="alert alert-danger">{error}</p>;
  if (!preview) return <p className="muted" role="status">{t.checking}</p>;
  const ws = preview.workspace;
  const order = ["included", "already_at_destination", "left_at_source", "external", "unresolved"] as const;
  const total = order.reduce((n, k) => n + preview.links.counts[k], 0);
  return (
    <section className="xfer-preview" aria-label={t.whoCanSee} aria-busy={checking}>
      {ws && (
        <div className="xfer-section">
          <h3 className="label">{t.whoCanSee}</h3>
          <p>{ws.members ? t.visibleTo(ws.memberCount) : t.membersHidden(ws.memberCount)}</p>
          {ws.members && ws.members.length > 1 && (
            <ul className="xfer-members">
              {ws.members.map((m) => (
                <li key={m.userId}>
                  <span>{m.displayName}</span> <span className="badge badge-muted">{t.roles[m.role]}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">{t.you(t.roles[ws.role])}</p>
        </div>
      )}

      {preview.pages.length > 0 && (
        <div className="xfer-section">
          <h3 className="label">{t.pagesHeading}</h3>
          <ul className="xfer-list">
            {preview.direction === "to_workspace"
              ? preview.pages.map((p) => (
                  <li key={p.path} title={p.path}>
                    {p.title} <span className="muted small">{p.path}</span>
                  </li>
                ))
              : preview.pages.map((p) => <li key={p.pageId}>{p.title}</li>)}
          </ul>
          {preview.direction === "to_workspace" && preview.attachments.length > 0 && <p className="muted small">{t.attachmentsHeading(preview.attachments.length)}</p>}
        </div>
      )}

      {preview.pages.length > 0 && (
        <div className="xfer-section">
          <h3 className="label">{t.linksHeading}</h3>
          {total === 0 ? (
            <p className="muted">{t.noLinks}</p>
          ) : (
            <ul className="xfer-links">
              {order
                .filter((k) => preview.links.counts[k] > 0)
                .map((k) => (
                  <li key={k} data-class={k}>
                    <b>{preview.links.counts[k]}</b> {t.links[k]}
                  </li>
                ))}
            </ul>
          )}
          {preview.links.flagged.length > 0 && (
            <details className="xfer-flagged">
              <summary>{t.flaggedTitle}</summary>
              <ul>
                {preview.links.flagged.slice(0, 50).map((f, i) => (
                  <li key={i}>
                    <code>{f.target}</code> <span className="muted small">{`${f.sourcePath}:${f.line}`}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {preview.problems.length > 0 && (
        <ul className="xfer-problems" role="alert">
          {preview.problems.map((p, i) => (
            <li key={i} className="alert alert-danger">
              {problemText(p, t)}
            </li>
          ))}
        </ul>
      )}
      {preview.warnings.length > 0 && (
        <ul className="xfer-warnings">
          {preview.warnings.map((w, i) => (
            <li key={i} className="alert alert-warning">
              {warningText(w, t)}
            </li>
          ))}
        </ul>
      )}
      {preview.problems.length === 0 && <p className="wz-safe">{preview.direction === "to_workspace" ? t.nothingLeaves : t.nothingLeavesFrom}</p>}
    </section>
  );
}

function Progress({ record, t }: { record: OperationRecord | null; t: T }) {
  const state = record?.state ?? "plan";
  const failedAt = record?.failedAt ?? null;
  const at = STEPS.indexOf(failedAt ?? state);
  const steps = record?.mode === "copy" ? STEPS.filter((s) => s !== "finalize_source") : STEPS;
  const done = ["done", "destination_committed_source_cleanup_pending"].includes(state);
  const value = done ? steps.length : Math.max(0, at);
  return (
    <div className="xfer-progress">
      <p className="label" aria-live="polite">
        {t.states[state]}
      </p>
      <progress aria-label={t.progressLabel} max={steps.length} value={value} />
      <ol className="xfer-steps">
        {steps.map((s, i) => (
          <li key={s} data-state={done || i < value ? "done" : i === value ? "current" : "todo"}>
            {t.states[s]}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Result({ record, interrupted, where, t }: { record: OperationRecord; interrupted: string | null; where: string; t: T }) {
  if (interrupted && !["done", "destination_committed_source_cleanup_pending", "failed", "aborted"].includes(record.state)) return <p>{t.resultInterrupted(interrupted)}</p>;
  const conflicts = record.items.filter((i) => i.conflictCopy).length;
  switch (record.state) {
    case "done":
      return (
        <>
          <p>{t.resultDone(record.mode, record.items.length, where)}</p>
          {conflicts > 0 && <p className="muted">{t.conflictCopies(conflicts)}</p>}
        </>
      );
    case "destination_committed_source_cleanup_pending": {
      const kept = record.items.filter((i) => i.state === "cleanup_pending");
      return (
        <>
          <p>
            <b>{t.states.destination_committed_source_cleanup_pending}.</b> {t.resultPending(record.items.length - kept.filter((i) => i.error === "hash_mismatch").length, kept.length, where)}
          </p>
          <h3 className="label">{t.keptItems}</h3>
          <ul className="xfer-list">
            {kept.map((i) => (
              <li key={i.sourceId}>
                {record.direction === "to_workspace" ? i.sourcePath : i.title} <span className="muted small">{t.keptReason[i.error ?? ""] ?? t.keptOther}</span>
              </li>
            ))}
          </ul>
          {conflicts > 0 && <p className="muted">{t.conflictCopies(conflicts)}</p>}
        </>
      );
    }
    case "aborted":
      return <p>{t.resultAborted}</p>;
    default:
      return <p>{t.resultFailed(record.error?.message ?? "")}</p>;
  }
}
