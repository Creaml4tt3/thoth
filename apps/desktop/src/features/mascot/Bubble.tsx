/**
 * The mascot's prompt bubble: a small non-modal dialog anchored to the mascot and kept inside the window.
 *
 * Before a run: context chips (the current page by default, the text selected in the editor if any, and "+" for more
 * pages, folders, the whole Private Space or read-only workspace pages, with the existing context picker), the task,
 * the agent (Claude Code or Codex with its detection state), options (model, time limit, spending limit: off for Codex,
 * as before) and Start. While it runs: a compact streamed transcript and Cancel. After: the outcome, the result of
 * applying, and New task. When the run waits for review, it says so and opens the review tab (as a click on the mascot
 * does then).
 *
 * Esc closes it and gives focus back to the mascot; a press outside closes it too. Everything a run does still goes
 * through the Agent service (review before apply, compare-and-swap, read-only workspace copies).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { AgentEvent, AgentInstallationStatus } from "@thoth/agent-core";
import { BUDGET_CHOICES_USD, TIME_LIMIT_MINUTES } from "@thoth/agent-core";
import { basename, stripExtension } from "@thoth/domain";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { IconButton } from "@thoth/app-ui/ui/IconButton.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { ContextPicker } from "../agents/ContextPicker.tsx";
import { EventLine, Outcome, StoppedNotice, providerOf } from "../agents/parts.tsx";
import { MAX_EXCERPT, PROVIDER_FEATURES, workspaceChoiceKey, type AgentsService, type AgentsState } from "../agents/service.ts";
import { AGENT_PROVIDERS } from "../agents/settings.ts";
import type { Insets, Size } from "./placement.ts";

const GAP = 10;
const MARGIN = 8;
const WIDTH = 380;
/** The newest transcript lines shown in the bubble; the whole transcript is in the review tab and the history. */
const SHOWN_EVENTS = 40;

export interface BubbleAnchor {
  left: number;
  top: number;
  size: number;
  h: "left" | "right";
  v: "top" | "bottom";
}

/** The text selected in a page editor, if any. */
export function editorSelection(): string | null {
  const selection = globalThis.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const node = selection.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  if (!element?.closest(".ProseMirror, .cm-editor")) return null;
  const text = selection.toString().trim();
  return text === "" ? null : text.slice(0, MAX_EXCERPT);
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

function useDefaultContext(agents: AgentsService, excerpt: string | null) {
  const { tabs, servers } = useSession();
  useLayoutEffect(() => {
    const s = agents.getState();
    if (s.phase !== "idle") return;
    const { draft, settings } = s;
    const target = tabs.active.target;
    const empty = draft.selection.length === 0 && !draft.wholeSpace && draft.workspace.length === 0;
    if (empty && target.kind === "page" && settings.allowPrivate) agents.setDraft({ selection: [target.path] });
    if (empty && target.kind === "workspace" && settings.allowWorkspace) {
      const ws = servers.workspace(target.server, target.workspace);
      const page = servers.getState().trees[`${target.server}\n${target.workspace}`]?.nodes.find((n) => n.id === target.page);
      if (ws && page) agents.addWorkspacePage({ server: target.server, workspace: target.workspace, page: target.page, title: page.title, workspaceName: ws.name });
    }
    if (excerpt) agents.setDraft({ excerpt: { text: excerpt, from: target.kind === "page" ? target.path : null } });
    // Once per opening of the bubble.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function Chips({ state, agents, onAdd, adding }: { state: AgentsState; agents: AgentsService; onAdd(): void; adding: boolean }) {
  const t = useDesktopStrings().mascot.bubble;
  const { draft } = state;
  const chips: { key: string; label: string; title?: string; remove(): void; kind: string }[] = [];
  if (draft.wholeSpace) chips.push({ key: "whole", label: t.wholeSpace, kind: "whole", remove: () => agents.setDraft({ wholeSpace: false }) });
  else
    for (const path of draft.selection)
      chips.push({ key: `p:${path}`, label: path.endsWith(".md") ? stripExtension(basename(path)) : `${basename(path)}/`, title: path, kind: path.endsWith(".md") ? "page" : "folder", remove: () => agents.setDraft({ selection: draft.selection.filter((p) => p !== path) }) });
  for (const c of draft.workspace) chips.push({ key: `w:${workspaceChoiceKey(c)}`, label: t.workspacePage(c.title), title: c.workspaceName, kind: "workspace", remove: () => agents.removeWorkspacePage(workspaceChoiceKey(c)) });
  if (draft.excerpt) chips.push({ key: "excerpt", label: t.selection(words(draft.excerpt.text)), title: draft.excerpt.text.slice(0, 200), kind: "excerpt", remove: () => agents.setDraft({ excerpt: null }) });
  return (
    <div className="bubble-context">
      <span className="bubble-label" id="bubble-context-label">
        {t.context}
      </span>
      <ul className="bubble-chips" aria-labelledby="bubble-context-label">
        {chips.map((c) => (
          <li key={c.key} className="bubble-chip" data-kind={c.kind} title={c.title}>
            <span className="bubble-chip-text">{c.label}</span>
            <button type="button" className="bubble-chip-remove" aria-label={t.remove(c.label)} onClick={c.remove}>
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
                <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </li>
        ))}
        {chips.length === 0 && <li className="bubble-chip-none muted small">{t.contextNone}</li>}
        <li>
          <IconButton icon="plus" label={t.add} className="bubble-add" aria-expanded={adding} aria-controls="bubble-picker" onClick={onAdd} />
        </li>
      </ul>
    </div>
  );
}

function shortStatus(status: AgentInstallationStatus | undefined, checking: boolean, t: ReturnType<typeof useDesktopStrings>["agents"]["picker"]["short"]): string {
  if (!status || checking) return t.checking;
  return status.state === "ready" ? t.ready(status.version) : t[status.state];
}

function Form({ state, agents, focusNonce }: { state: AgentsState; agents: AgentsService; focusNonce: number }) {
  const all = useDesktopStrings().agents;
  const t = useDesktopStrings().mascot.bubble;
  const f = all.form;
  const p = all.providers[state.provider];
  const [adding, setAdding] = useState(false);
  const [tried, setTried] = useState(false);
  const task = useRef<HTMLTextAreaElement>(null);
  const problems = agents.draftProblems();
  const ready = state.status?.state === "ready";
  const busy = state.phase === "starting";
  const { draft, settings } = state;
  const budgetOn = PROVIDER_FEATURES[state.provider].budget;
  useEffect(() => {
    task.current?.focus();
  }, [focusNonce]);
  const start = () => {
    setTried(true);
    if (problems.length === 0) void agents.start();
  };
  const notice = state.notice;
  const noticeText = (() => {
    if (!notice) return null;
    if (notice.kind === "reviewGone" || notice.kind === "workspaceOff") return all.notice[notice.kind] as string;
    const entry = all.notice[notice.refusal];
    return typeof entry === "function" ? entry(notice.workspace) : (entry ?? null);
  })();
  const defaultTime = f.timeOption(settings.timeMinutes);
  const defaultBudget = settings.budgetUsd === null ? f.noLimit : f.budgetOption(settings.budgetUsd);
  return (
    <form
      className="bubble-form"
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <Chips state={state} agents={agents} adding={adding} onAdd={() => setAdding((a) => !a)} />
      {adding && (
        <div id="bubble-picker" className="bubble-picker agents">
          {settings.allowPrivate ? <ContextPicker state={state} agents={agents} disabled={busy} /> : <p className="muted small">{f.privateOff}</p>}
          <div className="set-actions">
            <Button variant="ghost" small onClick={() => setAdding(false)}>
              {t.addDone}
            </Button>
          </div>
        </div>
      )}
      <label className="field bubble-task">
        <span className="bubble-label">{f.task}</span>
        <textarea ref={task} className="input" rows={3} value={draft.prompt} placeholder={t.taskHint} onChange={(e) => agents.setDraft({ prompt: e.target.value })} disabled={busy} onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            start();
          }
        }} />
      </label>
      <div className="bubble-row">
        <label className="field bubble-agent">
          <span className="bubble-label">{t.agent}</span>
          <select className="input" value={state.provider} onChange={(e) => agents.selectProvider(e.target.value as (typeof AGENT_PROVIDERS)[number])} disabled={busy} data-testid="bubble-agent">
            {AGENT_PROVIDERS.map((id) => (
              <option key={id} value={id} data-state={state.statuses[id]?.state ?? "checking"}>
                {t.agentOption(all.providers[id].name, shortStatus(state.statuses[id], state.checking, all.picker.short))}
              </option>
            ))}
          </select>
        </label>
      </div>
      {state.status && state.status.state !== "ready" && !state.checking && (
        <p className="alert alert-warning small" role="status" data-testid="bubble-agent-status" data-state={state.status.state}>
          {shortStatus(state.status, false, all.picker.short)}. <SettingsLink />
        </p>
      )}
      <details className="bubble-options">
        <summary>{t.options}</summary>
        <div className="bubble-options-grid">
          <div className="field">
            <label htmlFor="bubble-model">{f.model}</label>
            <input id="bubble-model" className="input" value={draft.model} list="bubble-models" onChange={(e) => agents.setDraft({ model: e.target.value })} disabled={busy} aria-describedby="bubble-model-hint" spellCheck={false} autoCapitalize="off" />
            <datalist id="bubble-models">
              {PROVIDER_FEATURES[state.provider].models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <small id="bubble-model-hint" className="muted">
              {p.modelHint}
            </small>
          </div>
          <label className="field">
            <span>{f.timeLimit}</span>
            <select className="input" value={String(draft.timeMinutes)} disabled={busy} onChange={(e) => agents.setDraft({ timeMinutes: e.target.value === "default" ? "default" : Number(e.target.value) })}>
              <option value="default">{f.useDefault(defaultTime)}</option>
              {TIME_LIMIT_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {f.timeOption(m)}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <label htmlFor="bubble-budget">{f.budget}</label>
            {budgetOn ? (
              <select id="bubble-budget" className="input" value={String(draft.budget)} disabled={busy} onChange={(e) => agents.setDraft({ budget: e.target.value === "default" ? "default" : e.target.value === "none" ? "none" : Number(e.target.value) })} aria-describedby="bubble-budget-hint">
                <option value="default">{f.useDefault(defaultBudget)}</option>
                {BUDGET_CHOICES_USD.map((b) => (
                  <option key={b} value={b}>
                    {f.budgetOption(b)}
                  </option>
                ))}
                <option value="none">{f.noLimit}</option>
              </select>
            ) : (
              // Codex has no spending limit: the field says so instead of offering one that would not be enforced.
              <select id="bubble-budget" className="input" value="unsupported" disabled aria-describedby="bubble-budget-hint" data-testid="agent-budget-unsupported">
                <option value="unsupported">{p.noBudget}</option>
              </select>
            )}
            <small id="bubble-budget-hint" className="muted">
              {p.budgetHint}
            </small>
          </div>
        </div>
      </details>
      {tried && problems.length > 0 && (
        <ul role="alert" className="alert alert-danger agents-problems small">
          {problems.map((problem) => (
            <li key={problem}>{problem === "badModel" ? p.badModel : f[problem]}</li>
          ))}
        </ul>
      )}
      {noticeText && (
        <p role="alert" className="alert alert-danger small" data-testid="agent-notice" data-kind={notice?.kind === "refused" ? notice.refusal : notice?.kind}>
          {noticeText}
        </p>
      )}
      {state.error && (
        <p role="alert" className="alert alert-danger small">
          {state.error}
        </p>
      )}
      <p className="muted small bubble-caution">{p.caution}</p>
      <div className="bubble-actions">
        <SettingsLink />
        <Button variant="primary" type="submit" disabled={!ready || busy}>
          {busy ? f.starting : f.start}
        </Button>
      </div>
    </form>
  );
}

function SettingsLink() {
  const { openSettings } = useSession();
  const t = useDesktopStrings().mascot.bubble;
  return (
    <button type="button" className="sec-link" onClick={() => openSettings("agents")}>
      {t.settings}
    </button>
  );
}

function Transcript({ events, p, t }: { events: readonly AgentEvent[]; p: ReturnType<typeof providerOf>; t: ReturnType<typeof useDesktopStrings>["agents"]["run"] }) {
  const shown = useMemo(() => events.filter((e) => e.type !== "log" && e.type !== "exit").slice(-SHOWN_EVENTS), [events]);
  const end = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = end.current?.parentElement;
    if (list) list.scrollTop = list.scrollHeight;
  }, [shown.length]);
  return (
    <div role="log" aria-label={t.transcript} aria-live="polite" className="bubble-log">
      <ol className="agents-log" ref={end}>
        {shown.map((event, i) => (
          <EventLine key={i} event={event} t={t} p={p} />
        ))}
      </ol>
    </div>
  );
}

function Running({ state, agents, focusNonce }: { state: AgentsState; agents: AgentsService; focusNonce: number }) {
  const all = useDesktopStrings().agents;
  const t = useDesktopStrings().mascot.bubble;
  const p = providerOf(all, state.record?.provider.id ?? state.provider);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), [focusNonce]);
  return (
    <div className="bubble-run" aria-busy="true">
      {state.record && <p className="bubble-prompt">{state.record.task.prompt.split("\n")[0]}</p>}
      <p role="status" className="muted small">
        {state.phase === "cancelling" ? all.run.cancelling : t.working}
      </p>
      <Transcript events={state.events} p={p} t={all.run} />
      <div className="bubble-actions">
        <span />
        <Button ref={cancel} variant="danger" onClick={() => void agents.cancel()} disabled={state.phase !== "running"}>
          {state.phase === "cancelling" ? all.run.cancelling : all.run.cancel}
        </Button>
      </div>
    </div>
  );
}

function ReviewReady({ state, focusNonce, onOpen }: { state: AgentsState; focusNonce: number; onOpen(): void }) {
  const all = useDesktopStrings().agents;
  const t = useDesktopStrings().mascot.bubble;
  const record = state.record!;
  const p = providerOf(all, record.provider.id);
  const open = useRef<HTMLButtonElement>(null);
  useEffect(() => open.current?.focus(), [focusNonce]);
  return (
    <div className="bubble-run">
      <p className="bubble-prompt">{record.task.prompt.split("\n")[0]}</p>
      <StoppedNotice record={record} t={all.run} />
      <p role="status">{t.reviewReady}</p>
      {state.events.length > 0 && <Transcript events={state.events} p={p} t={all.run} />}
      <div className="bubble-actions">
        <span />
        <Button ref={open} variant="primary" onClick={onOpen}>
          {t.openReview}
        </Button>
      </div>
    </div>
  );
}

function Finished({ state, agents, focusNonce }: { state: AgentsState; agents: AgentsService; focusNonce: number }) {
  const all = useDesktopStrings().agents;
  const t = useDesktopStrings().mascot.bubble;
  const { openAgentReview } = useSession();
  const record = state.record!;
  const p = providerOf(all, record.provider.id);
  const next = useRef<HTMLButtonElement>(null);
  useEffect(() => next.current?.focus(), [focusNonce]);
  const applied = state.results?.filter((r) => r.result === "applied").length ?? 0;
  return (
    <div className="bubble-run">
      <p className="bubble-prompt">{record.task.prompt.split("\n")[0]}</p>
      <StoppedNotice record={record} t={all.run} />
      {/* The outcome says it all; the whole transcript stays in the review tab and the history. */}
      {state.results === null ? <Outcome record={record} t={all.run} p={p} /> : <p role="status">{record.state === "discarded" ? all.applied.discarded : t.appliedSummary(applied)}</p>}
      <div className="bubble-actions">
        {state.results !== null ? (
          <Button variant="quiet" small onClick={() => openAgentReview()}>
            {t.openResult}
          </Button>
        ) : (
          <span />
        )}
        <Button ref={next} variant="primary" onClick={() => void agents.newTask()}>
          {all.applied.newTask}
        </Button>
      </div>
    </div>
  );
}

export function Bubble({
  agents,
  state,
  anchor,
  view,
  insets,
  focusNonce,
  onClose,
  mascot,
  excerpt = null,
}: {
  agents: AgentsService;
  state: AgentsState;
  anchor: BubbleAnchor;
  view: Size;
  insets: Insets;
  focusNonce: number;
  onClose(refocus: boolean): void;
  mascot: RefObject<HTMLButtonElement | null>;
  excerpt?: string | null;
}) {
  const t = useDesktopStrings().mascot.bubble;
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useDefaultContext(agents, excerpt);
  useEffect(() => {
    if (!state.status && !state.checking) void agents.detect();
    // Once: detection is slow and its result stays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kept in the window: above the mascot when it sits in the bottom half, below it otherwise, flush with its outer edge.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setHeight(el.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = Math.min(WIDTH, view.width - 2 * MARGIN);
  const above = anchor.v === "bottom";
  const room = above ? anchor.top - GAP - insets.top : view.height - (anchor.top + anchor.size + GAP) - MARGIN;
  const maxHeight = Math.max(200, room);
  const shownHeight = Math.min(height, maxHeight);
  let top = above ? anchor.top - GAP - shownHeight : anchor.top + anchor.size + GAP;
  top = Math.max(insets.top, Math.min(top, view.height - MARGIN - shownHeight));
  let left = anchor.h === "right" ? anchor.left + anchor.size - width : anchor.left;
  left = Math.max(MARGIN, Math.min(left, view.width - MARGIN - width));
  const tail = Math.max(18, Math.min(width - 18, anchor.left + anchor.size / 2 - left));

  // A press outside (not on the mascot, which toggles it itself) closes the bubble.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || box.current?.contains(target) || mascot.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".tooltip")) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose, mascot]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onClose(true);
  };

  const { openAgentReview } = useSession();
  const running = state.phase === "starting" || state.phase === "running" || state.phase === "cancelling";
  const reviewing = (state.phase === "review" || state.phase === "applying") && state.record !== null;
  const finished = state.phase === "finished" && state.record !== null;
  return (
    <div
      ref={box}
      id="mascot-bubble"
      role="dialog"
      aria-modal="false"
      aria-labelledby="mascot-bubble-title"
      className="mascot-bubble"
      data-side={above ? "above" : "below"}
      style={{ left: Math.round(left), top: Math.round(top), width, maxHeight, ["--tail-x" as string]: `${Math.round(tail)}px`, transformOrigin: `${Math.round(tail)}px ${above ? "100%" : "0"}` }}
      onKeyDown={onKeyDown}
    >
      <div className="bubble-head">
        <h2 id="mascot-bubble-title">{t.title}</h2>
        <IconButton icon="close" label={t.close} onClick={() => onClose(true)} />
      </div>
      <div className="bubble-body">
        {running ? (
          <Running state={state} agents={agents} focusNonce={focusNonce} />
        ) : reviewing ? (
          <ReviewReady
            state={state}
            focusNonce={focusNonce}
            onOpen={() => {
              onClose(false);
              openAgentReview();
            }}
          />
        ) : finished ? <Finished state={state} agents={agents} focusNonce={focusNonce} /> : <Form state={state} agents={agents} focusNonce={focusNonce} />}
      </div>
    </div>
  );
}
