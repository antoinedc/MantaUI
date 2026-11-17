// ===== KnowledgeCard (shared-knowledge spec §4, §8, §11.6) =====
//
// Settings → Knowledge: the master switch, a one-line background-work budget status (the budget
// itself is the Background work card in Models), the global defaults and a per-project list for
// repo rules and sharing, status lines from the settings payload, "View knowledge" (opens the store in the Explorer)
// and the Recent changes list with Undo.
//
// Every control reports its outcome (AGENTS.md "never stub a control"): a save
// shows "Saved" or the box's error, an undo shows success or the specific
// refusal, a failed open says why. A status line appears only when the payload
// carries its field; absent data renders nothing, never a fabricated zero.
//
// Radio groups are native `<fieldset>`/`<legend>` + `input[type=radio]` tinted
// with `accent-color` (modern-web-guidance: forms, brand-consistent-forms).
//
// A radio group never auto-submits on an arrow key (forms guide: no auto-submit on radio change). Repo rules AND
// Sharing groups (default + per project) hold a pending selection until Apply. A confirm step guards the choices
// with a real consequence: Pull request / Direct (Manta writes to a repository) and moving to a mode that shares more.
// While a save runs a group is `aria-busy` rather than `disabled`, so keyboard focus stays where it was
// (accessibility guide: `disabled` removes the control from the focus order).

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  KnowledgeChange,
  KnowledgeProjectRow,
  KnowledgeRepoRules,
  KnowledgeSettings,
  KnowledgeSettingsPatch,
  KnowledgeSharing,
} from "../../shared/api";
import { BackgroundStatusLine } from "../BackgroundStatusLine";
import { Button } from "../Button";
import { LABEL_CLS } from "../Field";
import { SettingsRow } from "../SettingsRow";
import { Tag } from "../Tag";
import { Toggle } from "../Toggle";
import { UpdateBoxNote } from "../components/UpdateBoxNote";
import { dispatchOpenFile } from "../explorer/types";
import { useStore } from "../store";
import { useBackgroundStatus } from "../useBackgroundStatus";
import {
  KNOWLEDGE_DIR,
  REPO_RULES_OPTIONS,
  SHARING_OPTIONS,
  changeWhere,
  describeSaveError,
  describeUndoFailure,
  formatChangeTime,
  formatChangeTimeFull,
  isOverride,
  kindLabel,
  outwardLost,
  repoRulesLabel,
  sharingConfirmText,
  statusLines,
} from "./knowledgeFormat";

type Notice = { tone: "ok" | "error"; text: string };
const NOTICE_CLS = { ok: "text-ok", error: "text-danger" } as const;
const STATUS_CLS = { info: "text-text-muted", warn: "text-warn" } as const;

const errText = (e: unknown): string => String((e as Error)?.message ?? e ?? "") || "Something went wrong.";
const isUnsupported = (e: unknown): boolean => /unknown rpc channel/i.test(errText(e));

type Load =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
  | { kind: "ok"; settings: KnowledgeSettings };

type ChangesState =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
  | { kind: "ok"; items: KnowledgeChange[]; nextCursor: string | null };

type UndoState = { busy: boolean; failure?: string; warning?: string };

type RadioOption<V extends string> = {
  value: V;
  label: string;
  description?: string;
  disabled?: boolean;
};

function RadioGroup<V extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  busy,
  note,
  noteTone = "warn",
  footer,
}: {
  legend: string;
  name: string;
  options: ReadonlyArray<RadioOption<V>>;
  value: V;
  onChange: (v: V) => void;
  /** A save is running: the group reports aria-busy and ignores picks, but stays focusable. */
  busy: boolean;
  /** Controls under the options (the Repo rules Apply / confirm row). */
  footer?: ReactNode;
  /** Visible text under the options, tied to every disabled option. */
  note?: string;
  noteTone?: "warn" | "faint";
}) {
  const noteId = useId();
  return (
    <fieldset className="min-w-0 space-y-2" aria-busy={busy ? true : undefined}>
      <legend className={`${LABEL_CLS} mb-1`}>{legend}</legend>
      {options.map((o) => (
        <label
          key={o.value}
          className={"flex items-start gap-2 " + (o.disabled ? "cursor-not-allowed opacity-60" : busy ? "cursor-progress" : "cursor-pointer")}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={o.disabled}
            aria-describedby={o.disabled && note ? noteId : undefined}
            onChange={() => {
              if (!busy) onChange(o.value);
            }}
            style={{ accentColor: "var(--accent-solid)" }}
            className="mt-[3px] h-4 w-4 flex-none cursor-[inherit] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          />
          <span className="min-w-0">
            <span className="block text-body text-text">{o.label}</span>
            {o.description && <span className="block text-meta text-text-faint">{o.description}</span>}
          </span>
        </label>
      ))}
      {note && (
        <div id={noteId} className={`text-meta break-words ${noteTone === "warn" ? "text-warn" : "text-text-faint"}`}>
          {note}
        </div>
      )}
      {footer}
    </fieldset>
  );
}

const repoRulesConfirmText = (v: string, what: string): string | null =>
  v === "pull-request"
    ? `Manta will open one pull request with its learned rules in the repository for ${what}. It never merges it.`
    : v === "direct"
      ? `Manta will commit its learned rules straight to the default branch of the repository for ${what} and push. A rejected push becomes a pull request.`
      : null;

/**
 * A radio group that holds a PENDING pick: nothing is saved until Apply, and a pick that `confirmText` words (a
 * choice with a real consequence) asks for a confirmation first. `savedValue` is what the box has (the group snaps
 * back to it whenever it changes). Apply is `aria-disabled` (not `disabled`) when it can't act, with the reason in its
 * title, so keyboard focus never drops. Focus moves to Confirm when the panel opens and back to Apply when it closes.
 *
 * `confirmText(pending, saved)` → the sentence to confirm, or null for a pick that applies straight away.
 */
function PendingGroup<V extends string>({
  legend,
  name,
  options,
  savedValue,
  busy,
  note,
  confirmText,
  onApply,
}: {
  legend: string;
  name: string;
  options: ReadonlyArray<RadioOption<V>>;
  savedValue: V;
  busy: boolean;
  note?: string;
  confirmText: (pending: V, saved: V) => string | null;
  onApply: (v: V) => void;
}) {
  const [pending, setPending] = useState<V>(savedValue);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [focusNext, setFocusNext] = useState<"apply" | "confirm" | null>(null);
  const confirmId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setPending(savedValue);
    setConfirming(null);
  }, [savedValue]);
  useEffect(() => {
    if (!focusNext) return;
    wrap.current?.querySelector<HTMLElement>(focusNext === "confirm" ? ".manta-knowledge-confirm" : ".manta-knowledge-apply")?.focus();
    setFocusNext(null);
  }, [focusNext, confirming]);
  const dirty = pending !== savedValue;
  const applyReason = busy ? "Saving — wait for it to finish." : !dirty ? "Choose a different option first." : undefined;
  const apply = () => {
    if (busy || !dirty) return;
    const text = confirmText(pending, savedValue);
    if (text) {
      setConfirming(text);
      setFocusNext("confirm");
    } else onApply(pending);
  };
  const close = () => {
    setConfirming(null);
    setFocusNext("apply");
  };
  return (
    <RadioGroup
      legend={legend}
      name={name}
      options={options}
      value={pending}
      busy={busy}
      note={note}
      onChange={(v) => {
        setPending(v);
        setConfirming(null);
      }}
      footer={
        <div ref={wrap} className="space-y-2 pt-1">
          <Button tone="default" hook="manta-knowledge-apply" ariaDisabled={busy || !dirty} title={applyReason} onClick={apply}>
            {busy ? "Applying…" : "Apply"}
          </Button>
          {confirming && (
            <div role="group" aria-labelledby={confirmId} className="rounded-md border border-warn px-3 py-2 space-y-2" data-testid={`${name}-confirm`}>
              <div id={confirmId} className="text-meta text-text break-words">
                {confirming}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  tone="primary"
                  hook="manta-knowledge-confirm"
                  ariaDisabled={busy}
                  title={busy ? "Saving — wait for it to finish." : undefined}
                  onClick={() => {
                    if (busy) return;
                    close();
                    onApply(pending);
                  }}
                >
                  Confirm
                </Button>
                <Button tone="default" onClick={close}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      }
    />
  );
}

const DEFAULT_VALUE = "default" as const;

function ProjectRow({
  row,
  defaults,
  busy,
  onPatch,
}: {
  row: KnowledgeProjectRow;
  defaults: Pick<KnowledgeSettings, "repoRules" | "sharing">;
  busy: boolean;
  onPatch: (patch: KnowledgeSettingsPatch) => void;
}) {
  const repoOverride = isOverride(row, "repoRules", defaults);
  const sharingOverride = isOverride(row, "sharing", defaults);
  const repoOptions: RadioOption<KnowledgeRepoRules | typeof DEFAULT_VALUE>[] = [
    { value: DEFAULT_VALUE, label: `Use default (${repoRulesLabel(defaults.repoRules)})` },
    ...REPO_RULES_OPTIONS.map((o) => ({ value: o.value, label: o.label, disabled: o.outward && !row.outwardAllowed })),
  ];
  const sharingOptions: RadioOption<KnowledgeSharing | typeof DEFAULT_VALUE>[] = [
    { value: DEFAULT_VALUE, label: `Use default (${SHARING_OPTIONS.find((o) => o.value === defaults.sharing)?.label ?? defaults.sharing})` },
    ...SHARING_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
  ];
  const outwardNote = row.outwardAllowed
    ? undefined
    : `${outwardLost(row) ? `Acting as Box only. ` : ""}${row.outwardReason ?? "Pull request and Direct aren't available for this project."}`;
  return (
    <fieldset className="min-w-0 rounded-md border border-border px-3 py-3" data-testid={`knowledge-project-${row.slug}`}>
      <legend className="px-1 text-label font-medium text-text">{row.displayName}</legend>
      <div className="text-meta text-text-faint font-mono truncate" title={row.canonicalId}>
        {row.canonicalId}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4">
        <PendingGroup
          legend="Repo rules"
          name={`knowledge-${row.slug}-repoRules`}
          options={repoOptions}
          savedValue={repoOverride ? row.repoRules : DEFAULT_VALUE}
          busy={busy}
          note={outwardNote}
          confirmText={(v) => repoRulesConfirmText(v, row.displayName)}
          onApply={(v) => onPatch({ projects: { [row.slug]: { repoRules: v === DEFAULT_VALUE ? null : v } } })}
        />
        <PendingGroup
          legend="Sharing"
          name={`knowledge-${row.slug}-sharing`}
          options={sharingOptions}
          savedValue={sharingOverride ? row.sharing : DEFAULT_VALUE}
          busy={busy}
          confirmText={(pending, saved) => {
            const effective = (v: KnowledgeSharing | typeof DEFAULT_VALUE) => (v === DEFAULT_VALUE ? defaults.sharing : v);
            return sharingConfirmText(effective(saved), effective(pending), row.displayName);
          }}
          onApply={(v) => onPatch({ projects: { [row.slug]: { sharing: v === DEFAULT_VALUE ? null : v } } })}
        />
      </div>
    </fieldset>
  );
}

export function KnowledgeCard({ onNavigated }: { onNavigated?: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [changes, setChanges] = useState<ChangesState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [undoById, setUndoById] = useState<Record<string, UndoState>>({});
  const [undoneIds, setUndoneIds] = useState<Record<string, number>>({});
  const [viewBusy, setViewBusy] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const alive = useRef(true);
  const budget = useBackgroundStatus(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The active chat window: the Explorer lives inside a session, so "View knowledge" needs one.
  const projects = useStore((s) => s.projects);
  const activeProjectName = useStore((s) => s.activeProjectName);
  const activeWindowByProject = useStore((s) => s.activeWindowByProject);
  const owner = useMemo(() => {
    if (!activeProjectName) return null;
    const proj = projects.find((p) => p.tmuxSession === activeProjectName);
    if (!proj) return null;
    const idx = activeWindowByProject[activeProjectName] ?? proj.windows.find((w) => w.active)?.index ?? proj.windows[0]?.index;
    const win = proj.windows.find((w) => w.index === idx);
    if (!win?.opencodeSessionId) return null;
    return { sessionId: win.opencodeSessionId, cwd: win.paneCurrentPath || proj.defaultCwd };
  }, [projects, activeProjectName, activeWindowByProject]);

  const fetchSettings = () => {
    setLoad({ kind: "loading" });
    window.api
      .knowledgeSettingsGet()
      .then((settings) => {
        if (!alive.current) return;
        // A transport that answers nothing (the demo) has no knowledge settings to show.
        if (!settings || !Array.isArray(settings.projects)) {
          setLoad({ kind: "unsupported" });
          return;
        }
        setLoad({ kind: "ok", settings });
      })
      .catch((e) => {
        if (!alive.current) return;
        setLoad(isUnsupported(e) ? { kind: "unsupported" } : { kind: "error", message: errText(e) });
      });
  };
  useEffect(fetchSettings, []);

  const fetchChanges = () => {
    setChanges({ kind: "loading" });
    setMoreError(null);
    window.api
      .knowledgeChanges({})
      .then((page) => {
        if (!alive.current) return;
        if (!page || !Array.isArray(page.items)) {
          setChanges({ kind: "unsupported" });
          return;
        }
        setChanges({ kind: "ok", items: page.items, nextCursor: page.nextCursor ?? null });
      })
      .catch((e) => {
        if (!alive.current) return;
        setChanges(isUnsupported(e) ? { kind: "unsupported" } : { kind: "error", message: errText(e) });
      });
  };
  useEffect(fetchChanges, []);

  const loadMore = async () => {
    if (changes.kind !== "ok" || !changes.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await window.api.knowledgeChanges({ cursor: changes.nextCursor });
      if (!page || !Array.isArray(page.items)) throw new Error("The box didn't return more changes.");
      if (!alive.current) return;
      setChanges((cur) => {
        if (cur.kind !== "ok") return cur;
        const seen = new Set(cur.items.map((i) => i.id));
        return { kind: "ok", items: [...cur.items, ...page.items.filter((i) => !seen.has(i.id))], nextCursor: page.nextCursor ?? null };
      });
    } catch (e) {
      if (alive.current) setMoreError(`Couldn't load more changes: ${errText(e)}`);
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  };

  const save = async (patch: KnowledgeSettingsPatch, okText: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      let next = await window.api.knowledgeSettingsSet({ patch });
      if (!next || !Array.isArray(next.projects)) next = await window.api.knowledgeSettingsGet();
      if (!next || !Array.isArray(next.projects)) throw new Error("The box didn't return the settings.");
      if (!alive.current) return;
      setLoad({ kind: "ok", settings: next });
      setNotice({ tone: "ok", text: okText });
    } catch (e) {
      if (alive.current) setNotice({ tone: "error", text: `Couldn't save: ${describeSaveError(e)}` });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const undo = async (c: KnowledgeChange) => {
    setUndoById((m) => ({ ...m, [c.id]: { busy: true } }));
    try {
      const r = await window.api.knowledgeUndo({ id: c.id });
      if (!alive.current) return;
      if (r && r.ok === true) {
        setUndoneIds((m) => ({ ...m, [c.id]: Date.now() }));
        const warning = typeof r.warning === "string" && r.warning.trim() ? r.warning.trim() : undefined;
        setUndoById((m) => ({ ...m, [c.id]: { busy: false, ...(warning ? { warning } : {}) } }));
      } else if (r && r.ok === false) {
        setUndoById((m) => ({ ...m, [c.id]: { busy: false, failure: describeUndoFailure(r) } }));
      } else {
        throw new Error("The box didn't confirm the undo.");
      }
    } catch (e) {
      if (alive.current) setUndoById((m) => ({ ...m, [c.id]: { busy: false, failure: `Couldn't undo: ${describeSaveError(e)}` } }));
    }
  };

  const viewKnowledge = async () => {
    if (!owner || viewBusy) return;
    setViewBusy(true);
    setViewError(null);
    try {
      const res = await window.api.fsResolvePaths({ base: owner.cwd, paths: [KNOWLEDGE_DIR] });
      const hit = res?.results?.[0];
      if (!hit) throw new Error("The box didn't answer.");
      if (!hit.ok) {
        throw new Error(
          hit.reason === "missing"
            ? "The knowledge folder doesn't exist yet. It is created the first time something is learned."
            : `The knowledge folder couldn't be opened (${hit.reason}).`,
        );
      }
      if (hit.kind !== "dir") throw new Error("The knowledge location isn't a folder.");
      dispatchOpenFile({ abs: hit.abs, kind: "dir", owner });
      onNavigated?.();
    } catch (e) {
      if (alive.current) setViewError(errText(e));
    } finally {
      if (alive.current) setViewBusy(false);
    }
  };

  if (load.kind === "loading") return <div className="text-meta text-text-faint">Reading the knowledge settings…</div>;
  if (load.kind === "unsupported") return <UpdateBoxNote />;
  if (load.kind === "error") {
    return (
      <div className="space-y-3">
        <div role="alert" className="text-meta text-danger break-words">
          Couldn't read the knowledge settings: {load.message}
        </div>
        <Button tone="default" onClick={fetchSettings}>
          Try again
        </Button>
      </div>
    );
  }

  const s = load.settings;
  // With the switch off only the availability line matters; spend and briefing counts are about a running subsystem.
  const shownLines = statusLines(s).filter((l) => s.enabled || l.id === "unavailable");

  const noteText = (c: KnowledgeChange) => formatChangeTime(c.at);

  return (
    <div className="space-y-5" data-testid="knowledge-card">
      <div className="text-meta text-text-faint max-w-[62ch]">
        Manta learns how you work and how each project runs from your sessions, and gives new sessions a short briefing. The
        notes are plain files you can open and edit with any editor on this box; your edits win.
      </div>

      {notice && (
        <div
          className={`text-meta break-words ${NOTICE_CLS[notice.tone]}`}
          role={notice.tone === "error" ? "alert" : "status"}
          data-testid="knowledge-notice"
        >
          {notice.text}
        </div>
      )}

      <div>
        <SettingsRow
          name="Shared knowledge"
          help="Capture notes from your sessions, curate them in the background and brief new sessions."
        >
          <Toggle
            checked={s.enabled}
            disabled={busy}
            ariaLabel="Shared knowledge"
            onChange={(v) => void save({ enabled: v }, v ? "Shared knowledge turned on." : "Shared knowledge turned off.")}
          />
        </SettingsRow>
        <div className="py-3 empty:hidden" data-testid="knowledge-budget">
          <BackgroundStatusLine
            label="Background work budget"
            state={budget.state}
            onRetry={() => void budget.refresh()}
            share={{ prefix: "knowledge-", noun: "Knowledge work" }}
            testId="knowledge-budget-status"
          />
        </div>
      </div>

      {shownLines.length > 0 && (
        <ul className="space-y-1" data-testid="knowledge-status">
          {shownLines.map((l) => (
            <li key={l.id} className={`text-meta break-words ${STATUS_CLS[l.tone]}`} data-status={l.id}>
              {l.text}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-4">
        <div>
          <div className="text-body font-medium text-text">Defaults</div>
          <div className="text-meta text-text-faint max-w-[62ch]">Applied to every project that doesn't set its own.</div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <PendingGroup
            legend="Repo rules"
            name="knowledge-default-repoRules"
            options={REPO_RULES_OPTIONS}
            savedValue={s.repoRules}
            busy={busy}
            confirmText={(v) => repoRulesConfirmText(v, "each project that uses the default (only where this box can push to the repository)")}
            onApply={(v) => void save({ repoRules: v }, `Default repo rules set to ${repoRulesLabel(v)}.`)}
          />
          <PendingGroup
            legend="Sharing"
            name="knowledge-default-sharing"
            options={SHARING_OPTIONS}
            savedValue={s.sharing}
            busy={busy}
            confirmText={(pending, saved) => sharingConfirmText(saved, pending, "each project that uses the default")}
            onApply={(v) =>
              void save({ sharing: v }, `Default sharing set to ${SHARING_OPTIONS.find((o) => o.value === v)?.label ?? v}.`)
            }
          />
        </div>
        <div className="text-meta text-text-faint max-w-[62ch]">
          Sharing controls what Manta shows and injects. It is not access control: any session with a shell on this box can
          read the knowledge folder.
        </div>
      </div>

      <div className="space-y-3">
        <div className="text-body font-medium text-text">Projects</div>
        {s.projects.length === 0 ? (
          <div className="text-meta text-text-faint" data-testid="knowledge-no-projects">
            No projects detected yet. They appear here after their first session.
          </div>
        ) : (
          <div className="space-y-3">
            {s.projects.map((row) => (
              <ProjectRow key={row.slug} row={row} defaults={s} busy={busy} onPatch={(p) => void save(p, `Saved ${row.displayName}.`)} />
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            tone="default"
            hook="manta-knowledge-view"
            loading={viewBusy}
            disabled={!owner}
            title={owner ? undefined : "Open a chat session first; the Explorer opens inside a session."}
            onClick={() => void viewKnowledge()}
          >
            View knowledge
          </Button>
          {!owner && <span className="text-meta text-text-faint">Open a chat session to view the folder in the Explorer.</span>}
        </div>
        {viewError && (
          <div role="alert" className="text-meta text-danger break-words" data-testid="knowledge-view-error">
            {viewError}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="text-body font-medium text-text">Recent changes</div>
        {changes.kind === "loading" && <div className="text-meta text-text-faint">Reading recent changes…</div>}
        {changes.kind === "unsupported" && <UpdateBoxNote />}
        {changes.kind === "error" && (
          <div className="space-y-2">
            <div role="alert" className="text-meta text-danger break-words">
              Couldn't read recent changes: {changes.message}
            </div>
            <Button tone="default" onClick={fetchChanges}>
              Try again
            </Button>
          </div>
        )}
        {changes.kind === "ok" && changes.items.length === 0 && (
          <div className="text-meta text-text-faint" data-testid="knowledge-no-changes">
            Nothing yet. What Manta learns will be listed here, each with an Undo.
          </div>
        )}
        {changes.kind === "ok" && changes.items.length > 0 && (
          <ul className="space-y-2" data-testid="knowledge-changes">
            {changes.items.map((c) => {
              const st = undoById[c.id];
              const undoneAt = undoneIds[c.id] ?? c.undoneAt;
              return (
                <li key={c.id} className="rounded-md border border-border px-3 py-2 space-y-1" data-testid={`knowledge-change-${c.id}`}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-body text-text break-words">{c.summary}</div>
                      {c.reason && <div className="text-meta text-text-muted break-words">{c.reason}</div>}
                      <div className="mt-1 flex items-center gap-2 flex-wrap text-meta text-text-faint">
                        <Tag numeric>{kindLabel(c.kind)}</Tag>
                        <span>{changeWhere(c, s.projects)}</span>
                        <span title={formatChangeTimeFull(c.at)}>{noteText(c)}</span>
                      </div>
                    </div>
                    {undoneAt != null ? (
                      <span className="text-meta text-text-faint flex-none pt-1" data-testid={`knowledge-undone-${c.id}`}>
                        Undone
                      </span>
                    ) : (
                      c.undoable && (
                        <Button
                          tone="default"
                          hook="manta-knowledge-undo"
                          loading={st?.busy === true}
                          ariaLabel={`Undo: ${c.summary}`}
                          onClick={() => void undo(c)}
                        >
                          {st?.busy ? "Undoing…" : "Undo"}
                        </Button>
                      )
                    )}
                  </div>
                  {c.error && <div className="text-meta text-danger break-words">{c.error}</div>}
                  {st?.warning && (
                    <div role="status" className="text-meta text-warn break-words" data-testid={`knowledge-undo-warning-${c.id}`}>
                      Undone, but: {st.warning}
                    </div>
                  )}
                  {st?.failure && (
                    <div role="alert" className="text-meta text-danger break-words" data-testid={`knowledge-undo-error-${c.id}`}>
                      {st.failure}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {changes.kind === "ok" && changes.nextCursor && (
          <div className="space-y-1">
            <Button tone="default" loading={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
            {moreError && (
              <div role="alert" className="text-meta text-danger break-words">
                {moreError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
