// NewSessionScreen.tsx — the pre-session composer (BET-417 §A).
//
// Before a session exists, the composer IS the setup form. This is also the
// app's zero state (BET-416 §F). Two chips only: folder, and a split
// branch/worktree chip. No host chip — the box connection is already
// established.
//
// On submit:
//   - new-project mode (projectName === null): create a tmux session + first
//     chat window, derive the project name from the folder basename, then
//     send the typed prompt as the first message.
//   - new-session mode (projectName set): create a tmux window in the
//     existing project, then send the prompt.
//
// The folder chip opens FolderPickerModal (§B). Worktree fan-out is asked
// inside the picker, not as a post-Create interstitial.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  CornerUpRight,
  Folder as FolderIcon,
  GitBranch,
  Loader2,
  Mic,
  Paperclip,
} from "lucide-react";
import { useStore } from "./store";
import { ModelPicker } from "./ModelPicker";
import { MicButton } from "./ComposerParts";
import { FolderPickerModal } from "./FolderPickerModal";
import { worktreeName } from "./folderPicker";
import { useVoiceRecorder, type VoiceResult } from "./voice";
import type { VoiceMode, VoicePhase } from "./voice";
import type { OpencodeModel, WorktreeInfo } from "../shared/types";
import { type ModelSelection, resolveActiveModel } from "./chatShared";

type Props = {
  // null = new-project mode (creates a tmux session). A string = new-session
  // mode (creates a tmux window in that project).
  projectName: string | null;
  // Called after the session is created + the first prompt is sent. The
  // parent closes the screen and navigates to the new session.
  onDone: () => void;
  // Called when the user cancels (Esc / clicks away). The parent closes.
  onCancel: () => void;
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

export function NewSessionScreen({ projectName, onDone, onCancel }: Props) {
  const refresh = useStore((s) => s.refresh);
  const setActive = useStore((s) => s.setActive);
  const configDefaultModel = useStore((s) => s.defaultModel);
  const deactivatedMainModels = useStore((s) => s.deactivatedMainModels);
  const existingProjects = useStore((s) => s.projects);
  const worktreePerSession = useStore((s) => s.worktreePerSession);

  const isNewProject = projectName === null;

  // Folder state — the selected working directory.
  const [cwd, setCwd] = useState<string>(isNewProject ? "~" : "");
  const [pickerOpen, setPickerOpen] = useState(false);

  // Branch / worktree chip state.
  const [wantWorktree, setWantWorktree] = useState(worktreePerSession);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[] | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(false);
  // BET-417 §A: "Ticking worktree makes the branch field editable." When
  // wantWorktree is true, this is the editable branch name passed to
  // gitAddWorktree (which deriveWorktree turns into the new branch). Defaults
  // to a derived name; the user can type over it.
  const [worktreeBranch, setWorktreeBranch] = useState("worktree");
  // BET-417 §B: fan-out from the folder picker. When set, the picker returned
  // multiple worktrees and the user chose "One per worktree" — we create one
  // session with one window per worktree (worktreeName(w) as window name).
  const [fanOutWorktrees, setFanOutWorktrees] = useState<WorktreeInfo[] | null>(null);

  // Composer state.
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Model state — fetched on mount (same pattern as ChatPanel).
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [serverDefault, setServerDefault] = useState<{
    providerID: string;
    modelID: string;
  } | null>(null);
  const [modelOverride, setModelOverride] = useState<ModelSelection | null>(() =>
    configDefaultModel ?? null,
  );
  // Whether the user has explicitly picked a model this session. Until they
  // do, the pill reads "Auto" (the server default is in effect) even though
  // `modelOverride` is seeded from the configured default — presentational
  // only, does not change what model is applied to the new session.
  const [modelTouched, setModelTouched] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // GUARD (same pattern as App.tsx's launchersList effect): both of these
    // live ONLY on httpApi. On a fresh/unpaired desktop boot `window.api` is
    // still the raw preload OS-bridge subset, where they are undefined —
    // calling them throws synchronously from the commit phase, which `.catch`
    // cannot see and which unmounts the whole tree. App gates this screen on
    // `loaded` so it should not mount that early; this keeps a future caller
    // from re-opening the same hole.
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
    () => resolveActiveModel(models, modelOverride, serverDefault),
    [models, modelOverride, serverDefault],
  );
  void activeModel; // used by ModelPicker via models + modelOverride

  // ---- resolve cwd for new-session mode ----
  // In new-session mode, the cwd defaults to the project's cwd (inherited
  // server-side). The user can still browse to a subfolder.
  useEffect(() => {
    if (!isNewProject && projectName && !cwd) {
      const proj = existingProjects.find((p) => p.tmuxSession === projectName);
      const dir = proj?.defaultCwd || proj?.windows[0]?.paneCurrentPath || "";
      if (dir) setCwd(dir);
    }
  }, [isNewProject, projectName, existingProjects, cwd]);

  // ---- probe git state for the current cwd ----
  useEffect(() => {
    if (!cwd || cwd === "~") {
      setIsGitRepo(false);
      setWorktrees(null);
      return;
    }
    let cancelled = false;
    window.api
      .gitListWorktrees(cwd)
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
  }, [cwd]);

  const branchName = useMemo(() => {
    if (!worktrees || worktrees.length === 0) return null;
    return worktrees[0]?.branch ?? null;
  }, [worktrees]);

  // ---- voice (simplified: just insert transcribed text) ----
  const voiceRecorder = useVoiceRecorder({
    onResult: (r: VoiceResult) => {
      const text = r.mode === "dictate" ? r.text : "";
      if (!text) return;
      setInput((prev) => {
        const sep = prev && !prev.endsWith(" ") ? " " : "";
        return prev + sep + text;
      });
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

  // ---- submit: create session + send first prompt ----
  const submit = async () => {
    if (sending) return;
    const text = input.trim();
    if (!text) return;
    setSending(true);
    setError(null);

    try {
      let sessionName: string;
      let windowName: string;
      let worktreePath: string | undefined;

      if (isNewProject) {
        sessionName = deriveProjectName(cwd);
        // Avoid name collision with existing sessions.
        const taken = new Set(existingProjects.map((p) => p.tmuxSession));
        if (taken.has(sessionName)) {
          let i = 2;
          while (taken.has(`${sessionName}-${i}`)) i++;
          sessionName = `${sessionName}-${i}`;
        }
        windowName = "default";

        if (wantWorktree && isGitRepo) {
          const wt = await window.api.gitAddWorktree({ cwd, name: worktreeBranch });
          worktreePath = wt.path;
        }

        await window.api.tmuxNewSession({
          name: sessionName,
          cwd: worktreePath ?? cwd,
          windowName,
          chatMode: true,
          ...(worktreePath ? {} : { createDir: true }),
        });
      } else {
        sessionName = projectName!;
        windowName = worktreeBranch || "session";
        if (wantWorktree && isGitRepo) {
          const wt = await window.api.gitAddWorktree({ cwd, name: worktreeBranch });
          worktreePath = wt.path;
        }
        await window.api.tmuxNewWindow({
          sessionName,
          windowName,
          ...(worktreePath ? { cwd: worktreePath, worktreePath } : {}),
          chatMode: true,
        });
      }

      await refresh();

      // Find the new window's opencode session id.
      const proj = useStore.getState().projects.find(
        (p) => p.tmuxSession === sessionName,
      );
      const win = proj?.windows.find((w) => w.name === windowName);
      const sessionId = win?.opencodeSessionId;

      if (sessionId) {
        setActive(sessionName, win!.index);
        try {
          await window.api.tmuxSelectWindow({
            sessionName,
            windowIndex: win!.index,
          });
        } catch { /* non-fatal */ }
        // Send the first prompt.
        await window.api.opencodePrompt(
          sessionId,
          text,
          modelOverride ?? undefined,
        );
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  };

  // ---- fan-out submit: one session, one window per worktree ----
  // Relocates the old Sidebar createProject("all") logic that was deleted
  // with the inline forms (BET-417 §B4). Each window is named worktreeName(w)
  // (path basename, not branch) — so "leasebot" not "main" shows in the
  // sidebar. The first prompt goes to the first window.
  const submitFanOut = async (baseCwd: string, wts: WorktreeInfo[]) => {
    if (sending) return;
    const text = input.trim();
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
      await window.api.tmuxNewSession({
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
      const proj = useStore.getState().projects.find(
        (p) => p.tmuxSession === sessionName,
      );
      const win = proj?.windows.find((w) => w.name === worktreeName(first));
      if (win?.opencodeSessionId) {
        setActive(sessionName, win.index);
        try {
          await window.api.tmuxSelectWindow({
            sessionName,
            windowIndex: win.index,
          });
        } catch { /* non-fatal */ }
        if (text) {
          await window.api.opencodePrompt(
            win.opencodeSessionId,
            text,
            modelOverride ?? undefined,
          );
        }
      }
      onDone();
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
      onCancel();
      return;
    }
  };

  const folderLabel = useMemo(() => {
    if (!cwd || cwd === "~") return "Home";
    const parts = cwd.split("/").filter(Boolean);
    return parts[parts.length - 1] || cwd;
  }, [cwd]);

  return (
    // data-screen is the visual harness's handle on this screen (see
    // scripts/visual/screens.mjs). One stable attribute per screen root, so
    // the harness never depends on a class name or DOM position — both of
    // which a redesign is expected to change.
    <div data-screen="welcome" className="h-full flex flex-col items-center justify-center px-8">
      <div className="w-full max-w-[680px] flex flex-col gap-4">
        {/* Heading — the only element centred on the screen; the chip row and
            the controls row below are both left-aligned to the composer. */}
        <div className="text-center space-y-1">
          <h1 className="text-display font-semibold text-text">What's up next?</h1>
          <p className="text-body text-text-muted">
            Start a session on any folder your box can see.
          </p>
        </div>

        {/* Chip row — folder, then branch + worktree as ONE segmented control
            (shared border, no gap). Left-aligned: it reads as a property bar
            belonging to the composer below, not a second heading. */}
        <div className="flex items-center gap-2 self-start">
          <button
            onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1.5 h-9 pl-3 pr-2 rounded-lg border border-border bg-card text-meta text-text hover:border-border-strong"
            title={cwd || "Choose a folder"}
          >
            <FolderIcon size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
            <span className="truncate max-w-[200px] font-mono">{folderLabel}</span>
            <ChevronDown size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
          </button>

          <div className="inline-flex items-center h-9 rounded-lg border border-border bg-card text-meta overflow-hidden">
            {wantWorktree && isGitRepo ? (
              // BET-417 §A: "Ticking worktree makes the branch field
              // editable." The typed value is passed as `name` to
              // gitAddWorktree, which deriveWorktree turns into the new
              // branch name.
              <span className="inline-flex items-center gap-1 px-3 self-stretch">
                <GitBranch size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
                <input
                  value={worktreeBranch}
                  onChange={(e) => setWorktreeBranch(e.target.value)}
                  spellCheck={false}
                  className="w-[100px] bg-transparent border-0 outline-none text-text font-mono focus:border-b focus:border-accent"
                  placeholder="branch-name"
                  aria-label="Worktree branch name"
                />
              </span>
            ) : branchName ? (
              <span className="inline-flex items-center gap-1 px-3 text-text-muted self-stretch">
                <GitBranch size={14} className="shrink-0" aria-hidden="true" />
                <span className="truncate max-w-[120px]">{branchName}</span>
              </span>
            ) : (
              <span className="inline-flex items-center px-3 text-text-faint self-stretch">
                no branch
              </span>
            )}
            <label
              className={`inline-flex items-center gap-1.5 pl-3 pr-3 self-stretch border-l border-border ${
                isGitRepo ? "cursor-pointer" : "cursor-not-allowed opacity-50"
              }`}
              title={isGitRepo ? "Create in a fresh git worktree" : "not a git repository"}
            >
              <input
                type="checkbox"
                checked={wantWorktree}
                disabled={!isGitRepo}
                onChange={(e) => setWantWorktree(e.target.checked)}
                className="accent-accent"
              />
              <span className="text-text-muted">worktree</span>
            </label>
          </div>
        </div>

        {/* Composer — a single tall input card. The submit affordance sits
            INSIDE the input on the trailing edge, top-aligned, so the input
            can grow downward without moving it. */}
        <div
          className={
            "manta-composer-input-row rounded-xl border bg-card flex items-start gap-2 px-4 py-3 " +
            (voiceRecording
              ? "manta-recording"
              : "border-border")
          }
        >
          <textarea
            ref={inputRef}
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Describe a task or ask a question"
            rows={3}
            className="flex-1 w-full bg-transparent border-0 text-body text-text outline-none resize-none placeholder:text-text-faint"
            spellCheck={false}
          />

          <button
            onClick={() => void submit()}
            disabled={sending || !input.trim()}
            aria-label="Start a session"
            title={
              sending
                ? "Starting…"
                : input.trim()
                  ? "Start a session"
                  : "Describe a task to start"
            }
            className="shrink-0 w-9 h-9 rounded-lg border border-border bg-panel text-text-muted inline-grid place-items-center hover:text-text hover:border-border-strong disabled:opacity-50"
          >
            {sending ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <CornerUpRight size={16} aria-hidden="true" />
            )}
          </button>
        </div>

        {/* Controls row — model ▸ effort, then attach + dictate. Left-aligned
            to the composer. */}
        <div className="flex items-center gap-2 self-start">
          <ModelPicker
            modelLabel={null}
            models={models}
            modelOverride={modelOverride}
            defaultModel={serverDefault}
            deactivatedMainModels={deactivatedMainModels}
            onOpen={() => {}}
            onSelect={(m) => {
              setModelTouched(true);
              setModelOverride(m);
            }}
            labelOverride={modelTouched ? null : "Auto"}
            separatePills
            alwaysShowEffort
            effortAccent
          />

          {/* Attach — no implementation on this screen yet (welcome is
              create-first). Rendered disabled, per the UI-only constraint. */}
          <button
            type="button"
            disabled
            aria-label="Attach a file"
            title="Attaching files is not available when starting a session"
            className="shrink-0 w-9 h-9 rounded-lg border border-transparent inline-grid place-items-center text-text-faint disabled:cursor-not-allowed"
          >
            <Paperclip size={17} aria-hidden="true" />
          </button>

          {voiceEnabled ? (
            <MicButton
              phase={voicePhase}
              mode={voiceMode}
              onStart={(mode) => { voiceRecorder.start(mode); return Promise.resolve(); }}
              onStop={voiceRecorder.stop}
              onCancel={voiceRecorder.cancel}
            />
          ) : (
            /* Dictate — no voice configured on this box yet (no Groq key).
               Rendered disabled to match the attach button, so the controls
               row agrees with the mockup whether or not voice is set up. */
            <button
              type="button"
              disabled
              aria-label="Dictate"
              title="Dictation needs a Groq API key in Settings"
              className="shrink-0 w-9 h-9 rounded-lg border border-transparent inline-grid place-items-center text-text-faint disabled:cursor-not-allowed"
            >
              <Mic size={17} aria-hidden="true" />
            </button>
          )}
        </div>

        {error && (
          <div className="text-meta text-danger bg-danger-bg border border-danger/30 rounded px-3 py-2 break-words">
            {error}
          </div>
        )}
      </div>

      {pickerOpen && (
        <FolderPickerModal
          initialPath={cwd || "~"}
          onSelect={(path) => {
            setCwd(path);
            setPickerOpen(false);
          }}
          onFanOut={(baseCwd, wts) => {
            setFanOutWorktrees(wts);
            setCwd(baseCwd);
            setPickerOpen(false);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}

      {fanOutWorktrees && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[480px] max-w-[92vw] bg-bg-elev border border-border rounded-xl shadow-xl p-4 space-y-3">
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
                onClick={() => void submitFanOut(cwd, fanOutWorktrees)}
                disabled={sending}
                className="text-meta px-3 py-2 bg-accent-solid text-on-accent rounded hover:opacity-90 disabled:opacity-50"
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
        </div>
      )}
    </div>
  );
}
