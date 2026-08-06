// NewSessionScreen.tsx — the pre-session composer (BET-417 §A), now
// draft-backed.
//
// Before a session exists, the composer IS the setup form. This is also the
// app's zero state (BET-416 §F). Two chips only: folder, and a split
// branch/worktree chip. No host chip — the box connection is already
// established.
//
// The composer edits a STORE DRAFT (NewSessionDraft) rather than owning its
// own state, so the typed prompt + folder/model/worktree choices survive
// navigating away and back. A draft is NOT a tmux window or opencode session
// yet — submit() is what creates them.
//
// On submit:
//   - new-project mode (mode === "new-project"): create a tmux session + first
//     chat window, derive the project name from the folder basename, then send
//     the typed prompt as the first message.
//   - new-session mode (mode.projectName set): create a tmux window in that
//     project, then send the prompt.
//   The server returns the created window's { sessionId, windowIndex, projects }
//   so we navigate + send the prompt to the RIGHT session — never a name
//   lookup (which mixed new sessions up with existing ones on name collision).
//
// The folder chip opens FolderPickerModal (§B). Worktree fan-out is asked
// inside the picker, not as a post-Create interstitial.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  CornerDownLeft,
  Folder as FolderIcon,
  GitBranch,
  Loader2,
  Mic,
  Paperclip,
} from "lucide-react";
import { useStore } from "./store";
import { Chip } from "./Chip";
import { ModelPicker } from "./ModelPicker";
import { MicButton } from "./ComposerParts";
import { IconButton } from "./IconButton";
import { Modal } from "./Modal";
import { Card } from "./Card";
import { Checkbox } from "./Checkbox";
import { FolderPickerModal } from "./FolderPickerModal";
import { worktreeName } from "./folderPicker";
import { useVoiceRecorder, type VoiceResult } from "./voice";
import type { VoiceMode, VoicePhase } from "./voice";
import type {
  OpencodeModel,
  Project,
  TmuxCreateResult,
  WorktreeInfo,
} from "../shared/types";
import { type ModelSelection, resolveActiveModel } from "./chatShared";
import { ChatPanel } from "./ChatPanel";

// Normalise the tmux:new-session / new-window response. The (merged) server
// returns { sessionId, windowIndex, projects }; tolerate an older server that
// returned just the projects array so submitting a draft never silently drops
// the first prompt.
function normalizeCreate(
  result: TmuxCreateResult | Project[],
): { sessionId: string | null; windowIndex: number | undefined; projects: Project[] } {
  if (Array.isArray(result)) {
    return { sessionId: null, windowIndex: undefined, projects: result };
  }
  return {
    sessionId: result.sessionId ?? null,
    windowIndex: result.windowIndex,
    projects: result.projects,
  };
}

type Props = {
  // The id of the store draft this composer edits (see NewSessionDraft). The
  // draft holds the persisted composer workspace; the active view renders this
  // screen while the draft is active.
  draftId: string;
  // Fired after a successful submit. The store has already navigated to the
  // new session; this lets the caller run any post-commit bookkeeping.
  onDone?: () => void;
};

// Derive a tmux session name from a folder path: the basename, fallback to
// "project". Tilde-form and trailing slashes are handled. Exported for
// testing (pure).
export function deriveProjectName(cwd: string): string {
  const clean = cwd.replace(/\/+$/, "");
  if (!clean || clean === "~") return "project";
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] || "project";
}

// A readable, largely-unique window name derived from the first word of the
// typed prompt (e.g. "Deploy the billing service" → "deploy"). This avoids the
// old constant "worktree"/"session" that produced a sidebar full of identical
// rows. Falls back to "session" on a non-alphanumeric or empty first word.
export function promptWindowName(input: string): string {
  const clean = (input.trim().split(/\s+/)[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return clean ? clean.slice(0, 24) : "session";
}

export function NewSessionScreen({ draftId, onDone }: Props) {
  // The draft this composer edits. The App only ever renders this screen for a
  // draft that exists (activeDraftId always points at a live draft), so a
  // missing draft is unreachable in practice; the guard keeps TypeScript's
  // narrowing happy and safely no-ops on the impossible case.
  const draft = useStore((s) => s.drafts.find((d) => d.id === draftId));
  if (!draft) return null;
  const refresh = useStore((s) => s.refresh);
  const setActive = useStore((s) => s.setActive);
  const applyProjects = useStore((s) => s.applyProjects);
  const updateDraft = useStore((s) => s.updateDraft);
  const dismissDraft = useStore((s) => s.dismissDraft);
  const deactivatedMainModels = useStore((s) => s.deactivatedMainModels);
  const existingProjects = useStore((s) => s.projects);

  const projectName =
    draft.mode === "new-project" ? null : draft.mode.projectName;
  const isNewProject = projectName === null;

  // ---- local (non-persisted) UI state ----
  const [pickerOpen, setPickerOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[] | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(false);
  // BET-417 §B: fan-out from the folder picker. When set, the picker returned
  // multiple worktrees and the user chose "One per worktree".
  const [fanOutWorktrees, setFanOutWorktrees] = useState<WorktreeInfo[] | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optimistic commit: once the opencode session exists we leave the composer
  // and render the REAL ChatPanel (transcript + composer) with the first prompt
  // streaming, while the tmux window is created behind it. `cwd` is the folder
  // the session was created in (worktree path when one was requested).
  const [committing, setCommitting] = useState<{ sid: string; cwd: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Model state — fetched on mount (same pattern as ChatPanel).
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [serverDefault, setServerDefault] = useState<{
    providerID: string;
    modelID: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // GUARD (same pattern as App.tsx's launchersList effect): both of these
    // live ONLY on httpApi. On a fresh/unpaired desktop boot `window.api` is
    // still the raw preload OS-bridge subset, where they are undefined —
    // calling them throws synchronously from the commit phase, which `.catch`
    // cannot see and which unmounts the whole tree.
    if (window.api.opencodeModels) {
      window.api
        .opencodeModels()
        .then((list) => { if (!cancelled) setModels(list); })
        .catch(() => {});
    }
    if (window.api.opencodeDefaultModel) {
      window.api
        .opencodeDefaultModel()
        .then((d) => { if (!cancelled) setServerDefault(d); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, []);

  const activeModel = useMemo(
    () => resolveActiveModel(models, draft.model, serverDefault),
    [models, draft.model, serverDefault],
  );
  void activeModel; // used by ModelPicker via models + draft.model

  // ---- resolve cwd for new-session mode ----
  // In new-session mode, the cwd defaults to the project's cwd (inherited
  // server-side). The user can still browse to a subfolder.
  useEffect(() => {
    if (!isNewProject && projectName && !draft.cwd) {
      const proj = existingProjects.find((p) => p.tmuxSession === projectName);
      const dir = proj?.defaultCwd || proj?.windows[0]?.paneCurrentPath || "";
      if (dir) updateDraft(draftId, { cwd: dir });
    }
  }, [isNewProject, projectName, existingProjects, draft.cwd, draftId, updateDraft]);

  // ---- probe git state for the current cwd ----
  useEffect(() => {
    if (!draft.cwd || draft.cwd === "~") {
      setIsGitRepo(false);
      setWorktrees(null);
      return;
    }
    let cancelled = false;
    window.api
      .gitListWorktrees(draft.cwd)
      .then((wts) => {
        if (cancelled) return;
        setWorktrees(wts);
        setIsGitRepo(Array.isArray(wts) && wts.length > 0);
      })
      .catch(() => {
        if (cancelled) return;
        setIsGitRepo(false);
        setWorktrees(null);
      });
    return () => { cancelled = true; };
  }, [draft.cwd]);

  const branchName = useMemo(() => {
    if (!worktrees || worktrees.length === 0) return null;
    return worktrees[0]?.branch ?? null;
  }, [worktrees]);

  // ---- voice (simplified: just insert transcribed text) ----
  const voiceRecorder = useVoiceRecorder({
    onResult: (r: VoiceResult) => {
      const text = r.mode === "dictate" ? r.text : "";
      if (!text) return;
      const prev = useStore.getState().drafts.find((d) => d.id === draftId)?.input ?? "";
      const sep = prev && !prev.endsWith(" ") ? " " : "";
      updateDraft(draftId, { input: prev + sep + text });
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          const end = el.value.length;
          el.setSelectionRange(end, end);
        }
      });
    },
    onError: (err: Error) => setError(err.message),
    onEmpty: () => {},
  });
  const voicePhase: VoicePhase = voiceRecorder.phase;
  const voiceMode: VoiceMode = voiceRecorder.mode;
  const voiceRecording = voicePhase === "recording" || voicePhase === "requesting";
  const groqApiKey = useStore((s) => s.groqApiKey);
  const voiceEnabled = !!groqApiKey && typeof MediaRecorder !== "undefined";

  // ---- submit: create session + send first prompt (optimistic) ----
  //
  // The flow is split so the user sees their prompt being processed immediately:
  //   1. create the opencode session FIRST (a fast web call) → its directory is
  //      remembered server-side, which opens the scoped SSE stream,
  //   2. optimistically render the REAL ChatPanel (transcript + composer) for
  //      that session and send the first prompt → prompt + running indicator
  //      appear right away,
  //   3. create the tmux window/session and stamp it with the SAME session id,
  //      then reconcile (apply the listing + hand off to the App's session
  //      layer). If anything fails we roll back the orphan and drop to the
  //      composer with the error.
  const submit = async () => {
    if (sending) return;
    const text = draft.input.trim();
    if (!text) return;
    setSending(true);
    setError(null);

    let createdSid: string | null = null;
    try {
      // Resolve folder + (optionally) a fresh worktree once, up front.
      let worktreePath: string | undefined;
      if (draft.wantWorktree && isGitRepo) {
        const wt = await window.api.gitAddWorktree({ cwd: draft.cwd, name: draft.worktreeBranch });
        worktreePath = wt.path;
      }
      const dir = worktreePath ?? draft.cwd;
      const newProject = isNewProject;
      const sessionName = newProject
        ? (() => {
            const base = deriveProjectName(draft.cwd);
            const taken = new Set(existingProjects.map((p) => p.tmuxSession));
            if (!taken.has(base)) return base;
            let i = 2;
            while (taken.has(`${base}-${i}`)) i++;
            return `${base}-${i}`;
          })()
        : projectName!;

      // 1. Fast opencode session creation first.
      const sess = await window.api.opencodeCreateEphemeralSession({
        directory: dir,
        title: newProject
          ? `${sessionName} / default`
          : `${sessionName} / ${promptWindowName(text)}`,
      });
      if (!sess.ok || !sess.sessionId) {
        throw new Error(sess.error || "could not start the session");
      }
      createdSid = sess.sessionId;

      // 2. Optimistically render the real chat view; its ChatPanel auto-submits
      //    the first prompt through its OWN path (optimistic user message +
      //    running indicator appear immediately).
      setCommitting({ sid: createdSid, cwd: dir });

      // 3. Create the tmux window/session behind the user's view and stamp it
      //    with the same session id, then reconcile.
      const created = newProject
        ? await window.api.tmuxNewSession({
            name: sessionName,
            cwd: dir,
            windowName: "default",
            chatMode: true,
            existingSessionId: createdSid,
            ...(worktreePath ? {} : { createDir: true }),
          })
        : await window.api.tmuxNewWindow({
            sessionName,
            windowName: promptWindowName(text),
            cwd: dir,
            chatMode: true,
            existingSessionId: createdSid,
            ...(worktreePath ? { worktreePath } : {}),
          });
      const createdNorm = normalizeCreate(created);
      applyProjects(createdNorm.projects);

      // 4. Reconcile: hand the panel off to the App's session layer (same
      //    session id, same view) and drop the draft.
      const proj = useStore
        .getState()
        .projects.find((p) => p.tmuxSession === sessionName);
      const win =
        createdNorm.windowIndex != null
          ? proj?.windows.find((w) => w.index === createdNorm.windowIndex)
          : proj?.windows.find((w) => w.active) ?? proj?.windows[0];
      setActive(sessionName, win?.index ?? createdNorm.windowIndex);
      if (win) {
        try {
          await window.api.tmuxSelectWindow({ sessionName, windowIndex: win.index });
        } catch { /* non-fatal */ }
      }
      setCommitting(null);
      // Abandon the draft — it is now a real session.
      dismissDraft(draftId);
      onDone?.();
    } catch (e) {
      // Roll back: drop the orphaned opencode session (if we created one) and
      // return to the composer. The draft + typed prompt are preserved.
      if (createdSid) window.api.opencodeDeleteSessionRaw(createdSid).catch(() => {});
      setCommitting(null);
      setSending(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ---- fan-out submit: one session, one window per worktree ----
  // Each window is named worktreeName(w) (path basename, not branch) — so
  // "leasebot" not "main" shows in the sidebar. The first prompt goes to the
  // first window.
  const submitFanOut = async (baseCwd: string, wts: WorktreeInfo[]) => {
    if (sending) return;
    const text = draft.input.trim();
    setSending(true);
    setError(null);
    try {
      const sessionName = (() => {
        const base = deriveProjectName(baseCwd);
        const taken = new Set(existingProjects.map((p) => p.tmuxSession));
        if (!taken.has(base)) return base;
        let i = 2;
        while (taken.has(`${base}-${i}`)) i++;
        return `${base}-${i}`;
      })();

      const [first, ...rest] = wts;
      const created = await window.api.tmuxNewSession({
        name: sessionName,
        cwd: first.path,
        windowName: worktreeName(first),
        chatMode: true,
      });
      for (const w of rest) {
        try {
          await window.api.tmuxNewWindow({
            sessionName,
            windowName: worktreeName(w),
            cwd: w.path,
            chatMode: true,
          });
        } catch (e) {
          // Surface but don't abort — partial fan-out beats undoing halfway.
          setError(e instanceof Error ? e.message : String(e));
        }
      }

      await refresh();

      // The initial window of the new session is the created window. The
      // session id comes from the create result, with a window lookup fallback
      // for older servers that return only the projects array.
      const createdNorm = normalizeCreate(created);
      const proj = useStore
        .getState()
        .projects.find((p) => p.tmuxSession === sessionName);
      const win =
        createdNorm.windowIndex != null
          ? proj?.windows.find((w) => w.index === createdNorm.windowIndex)
          : proj?.windows.find((w) => w.active) ?? proj?.windows[0];
      const sessionId = createdNorm.sessionId ?? win?.opencodeSessionId ?? null;

      setActive(sessionName, win?.index ?? createdNorm.windowIndex);
      if (win) {
        try {
          await window.api.tmuxSelectWindow({
            sessionName,
            windowIndex: win.index,
          });
        } catch { /* non-fatal */ }
      }

      if (sessionId && text) {
        await window.api.opencodePrompt(
          sessionId,
          text,
          draft.model ?? undefined,
        );
      }

      dismissDraft(draftId);
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dismissDraft(draftId);
      return;
    }
  };

  const folderLabel = useMemo(() => {
    if (!draft.cwd || draft.cwd === "~") return "Home";
    const parts = draft.cwd.split("/").filter(Boolean);
    return parts[parts.length - 1] || draft.cwd;
  }, [draft.cwd]);

  // Empty state (BET-445): new-project mode opens on "~", which is never a
  // git repo, so the worktree intent can't be honored yet. Render the chip
  // unchecked and enabled so the picker can choose a folder first.
  const emptyWorktree = isNewProject && !isGitRepo;
  const worktreeChipEnabled = emptyWorktree || isGitRepo;

  // Optimistic: the instant the opencode session exists, leave the composer
  // and render the REGULAR chat view (transcript + composer) so the first
  // prompt + running indicator appear immediately, while the tmux window is
  // created behind the scenes. The real session hand-off happens in submit().
  if (committing) {
    return (
      <div className="h-full w-full bg-bg">
        <ChatPanel
          sessionId={committing.sid}
          tmuxSession={null}
          windowIndex={null}
          cwd={committing.cwd}
          isActive
          autoSubmit={{ text: draft.input.trim(), model: draft.model ?? undefined }}
        />
      </div>
    );
  }

  return (
    // data-screen is the visual harness's handle on this screen (see
    // scripts/visual/screens.mjs). One stable attribute per screen root, so
    // the harness never depends on a class name or DOM position.
    <div data-screen="welcome" className="h-full flex flex-col items-center justify-center px-8">
      <div className="w-full max-w-[720px] rounded-xl border border-border-subtle bg-bg-elev px-6 py-10 flex flex-col gap-2">
        <div className="text-center space-y-1 mb-4">
          <h1 className="text-display font-bold tracking-tight text-text">What's up next?</h1>
          <p className="text-body text-text-faint">
            Start a session on any folder your box can see.
          </p>
        </div>

        {/* Chip row — folder, then branch + worktree as ONE segmented control. */}
        <div className="flex items-center gap-2 self-start">
          <Chip
            onClick={() => setPickerOpen(true)}
            title={draft.cwd || "Select folder"}
          >
            <FolderIcon size={13} className="shrink-0 text-text-muted" aria-hidden="true" />
            <span className="truncate max-w-[200px]">{folderLabel}</span>
            <ChevronDown size={13} className="shrink-0 text-text-faint" aria-hidden="true" />
          </Chip>

          {draft.wantWorktree && isGitRepo ? (
            <input
              value={draft.worktreeBranch}
              onChange={(e) => updateDraft(draftId, { worktreeBranch: e.target.value })}
              spellCheck={false}
              className="h-8 w-[132px] rounded-md border border-accent bg-bg-soft px-3 text-meta font-mono text-text outline-none focus:border-accent"
              placeholder="branch-name"
              aria-label="Worktree branch name"
            />
          ) : (
            <Chip on={draft.wantWorktree} onClick={() => {}} title="Current git branch">
              <GitBranch size={13} className="shrink-0" aria-hidden="true" />
              {branchName ? (
                <span className="truncate max-w-[120px]">{branchName}</span>
              ) : (
                <span className="text-text-faint">no branch</span>
              )}
            </Chip>
          )}

          <Checkbox
            checked={draft.wantWorktree}
            disabled={!worktreeChipEnabled}
            onChange={(v) => updateDraft(draftId, { wantWorktree: v })}
            label="worktree"
            ariaLabel="Create in a fresh git worktree"
          />
        </div>

        {/* Composer — a single tall input card. */}
        <div
          className={
            "manta-composer-input-row rounded-lg border bg-bg-soft flex items-start gap-3 px-4 py-3 " +
            (voiceRecording ? "manta-recording" : "border-border-subtle")
          }
        >
          <textarea
            ref={inputRef}
            autoFocus
            value={draft.input}
            onChange={(e) => updateDraft(draftId, { input: e.target.value })}
            onKeyDown={onKeyDown}
            placeholder="Describe a task or ask a question"
            rows={3}
            className="flex-1 w-full bg-transparent border-0 text-prose text-text outline-none resize-none placeholder:text-text-faint"
            spellCheck={false}
          />

          <button
            onClick={() => void submit()}
            disabled={sending || !draft.input.trim()}
            aria-label="Start a session"
            title={
              sending
                ? "Starting…"
                : draft.input.trim()
                  ? "Start a session"
                  : "Describe a task to start"
            }
            className="shrink-0 w-7 h-7 rounded-sm bg-fill text-text-faint inline-grid place-items-center hover:text-text hover:bg-fill-hover disabled:opacity-50"
          >
            {sending ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <CornerDownLeft size={14} aria-hidden="true" />
            )}
          </button>
        </div>

        {/* Controls row — model ▸ effort, then attach + dictate. */}
        <div className="flex items-center gap-2 self-start">
          <ModelPicker
            modelLabel={null}
            models={models}
            modelOverride={draft.model}
            defaultModel={serverDefault}
            deactivatedMainModels={deactivatedMainModels}
            onOpen={() => {}}
            onSelect={(m: ModelSelection | null) => {
              // null = clear back to the server default ("Auto").
              updateDraft(draftId, {
                model: m,
                modelTouched: m != null,
              });
            }}
            labelOverride={draft.modelTouched ? null : "Auto"}
          />

          <IconButton
            icon={<Paperclip />}
            label="Attach a file"
            title="Attaching files is not available when starting a session"
            size="xl"
            disabled
          />

          {voiceEnabled ? (
            <MicButton
              phase={voicePhase}
              mode={voiceMode}
              onStart={(mode) => { voiceRecorder.start(mode); return Promise.resolve(); }}
              onStop={voiceRecorder.stop}
              onCancel={voiceRecorder.cancel}
            />
          ) : (
            <IconButton
              icon={<Mic />}
              label="Dictate"
              title="Dictation needs a Groq API key in Settings"
              size="xl"
              disabled
            />
          )}
        </div>

        {error && (
          <Card danger>
            <span className="text-meta text-danger break-words">{error}</span>
          </Card>
        )}
      </div>

      {pickerOpen && (
        <FolderPickerModal
          initialPath={draft.cwd || "~"}
          onSelect={(path) => {
            updateDraft(draftId, { cwd: path });
            setPickerOpen(false);
          }}
          onFanOut={(baseCwd, wts) => {
            setFanOutWorktrees(wts);
            updateDraft(draftId, { cwd: baseCwd });
            setPickerOpen(false);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}

      {fanOutWorktrees && (
        <Modal size="md" label="Fan-out confirmed">
          <div className="space-y-3">
            <div className="text-body font-semibold text-text">Fan-out confirmed</div>
            <div className="text-meta text-text-muted">
              Creating one session with {fanOutWorktrees.length} windows (one per
              worktree). The first window gets your prompt.
            </div>
            <ul className="text-label text-text-faint space-y-px max-h-40 overflow-y-auto">
              {fanOutWorktrees.map((w) => (
                <li key={w.path} className="truncate">
                  <span className="text-text-muted">{worktreeName(w)}</span>
                  {" "}<span className="text-text-faint">— {w.path}</span>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button
                onClick={() => void submitFanOut(draft.cwd, fanOutWorktrees)}
                disabled={sending}
                className="text-meta px-3 py-2 bg-accent-solid text-on-accent rounded-xs hover:opacity-90 disabled:opacity-50"
              >
                {sending ? "Creating…" : "Create"}
              </button>
              <button
                onClick={() => setFanOutWorktrees(null)}
                disabled={sending}
                className="text-meta px-3 py-2 text-text-faint hover:text-text"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
