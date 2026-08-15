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
import { Button } from "./Button";
import { Card } from "./Card";
import { Checkbox } from "./Checkbox";
import { FolderPickerModal } from "./FolderPickerModal";
import { ListRow } from "./ListRow";
import { Skeleton } from "./Skeleton";
import { CloneFromGitHub } from "./CloneFromGitHub";
import { StatusDot } from "./StatusDot";
import { worktreeName } from "./folderPicker";
import { useVoiceRecorder } from "./voice";
import {
  describeRepoRow,
  formatAge,
  initialRepoSelection,
  zeroStateMode,
  type RepoRow,
} from "./chatUtils";
import type { VoicePhase } from "./voice";
import type {
  ForgeCliStatus,
  OpencodeModel,
  Project,
  RepoHit,
  TmuxCreateResult,
  WorktreeInfo,
} from "../shared/types";
import { type ModelSelection, resolveActiveModel } from "./chatShared";

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

// Numeric de-dup on top of deriveProjectName: returns the base name if free,
// else the first free `base-2`, `base-3`, … against the `taken` set (the
// existing project session names). THE one naming helper for a session name —
// shared by every path that creates a project (the repo-probe batch, the
// draft composer submit, and the worktree fan-out), so a twin never lands with
// the same tmux session name. Exported for testing (pure).
export function uniqueSessionName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
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
  // Per-row lifecycle for the repo-probe batch setup (BET-787 [S8]).
  type RowPhase = "idle" | "queued" | "creating" | "ready" | "error";
  type CreatedSession = { name: string; windowIndex: number | undefined };

  // The draft this composer edits. The App only ever renders this screen for a
  // draft that exists (activeDraftId always points at a live draft), so a
  // missing draft is unreachable in practice; the guard keeps TypeScript's
  // narrowing happy and safely no-ops on the impossible case.
  const draft = useStore((s) => s.drafts.find((d) => d.id === draftId));
  if (!draft) return null;
  const refresh = useStore((s) => s.refresh);
  const setActive = useStore((s) => s.setActive);
  const activateWindow = useStore((s) => s.activateWindow);
  const applyProjects = useStore((s) => s.applyProjects);
  const updateDraft = useStore((s) => s.updateDraft);
  const dismissDraft = useStore((s) => s.dismissDraft);
  const setAutoSubmitPrompt = useStore((s) => s.setAutoSubmitPrompt);
  const deactivatedMainModels = useStore((s) => s.deactivatedMainModels);
  const existingProjects = useStore((s) => s.projects);

  const projectName =
    draft.mode === "new-project" ? null : draft.mode.projectName;
  const isNewProject = projectName === null;

  // ---- local (non-persisted) UI state ----
  const [pickerOpen, setPickerOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[] | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ---- repo probe (BET-787): the new-project zero state ----
  // Probe the box for git repos + the gh CLI. The scan is purely additive: if
  // it fails or is unavailable we degrade to exactly today's behaviour (the
  // folder picker), never a state worse than the one the screen used to have.
  const PROBE_PRE_CHECK_CAP = 8;
  const [probePending, setProbePending] = useState(false);
  const [probeFailed, setProbeFailed] = useState(false);
  const [probeRepos, setProbeRepos] = useState<RepoHit[]>([]);
  const [cliStatus, setCliStatus] = useState<ForgeCliStatus | null>(null);
  // The box's $HOME from the probe, used to render a no-remote repo under the
  // home dir as `~/…` instead of the absolute path (describeRepoRow).
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  // The user chose "Browse for a folder…" (or the picker returned a worktree
  // fan-out) → render today's full composer for that folder. This is how the
  // Browse escape path keeps working exactly as it did before the list.
  const [browseChosen, setBrowseChosen] = useState(false);
  // Per-row batch progress (BET-787 [S8]): "queued" / "creating…" / "ready" /
  // "error". Partial failure is legible and does not abort the batch.
  const [rowPhase, setRowPhase] = useState<Record<string, RowPhase>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const createdRef = useRef<CreatedSession[]>([]);
  const errorPathsRef = useRef<Set<string>>(new Set());
  // True once a batch has run and we're showing the per-row results view (with
  // errors + retry) instead of the pre-setup list. On all-success we navigate
  // away immediately, so this view only lingers when at least one row failed.
  const [batchDone, setBatchDone] = useState(false);

  // BET-796: whether the GitHub clone flow ([S5]-[S7]/[E2]/[E3]) is open in
  // place of the zero-state content. Opened from "Clone from GitHub…".
  const [cloneOpen, setCloneOpen] = useState(false);

  // All probe rows are local (they already exist on disk); a later forge issue
  // adds clone rows and those must land `local: false` via the same shape.
  const rows = useMemo<RepoRow[]>(
    () => probeRepos.map((r) => ({ ...r, local: true })),
    [probeRepos],
  );
  const hasFailed = rows.some((r) => rowPhase[r.path] === "error");

  useEffect(() => {
    if (!isNewProject) return;
    let cancelled = false;
    setProbePending(true);
    setProbeFailed(false);
    setProbeRepos([]);
    setCliStatus(null);
    setHomeDir(null);
    setBrowseChosen(false);
    setChecked(new Set());
    setRowPhase({});
    setRowError({});
    setBatchDone(false);
    createdRef.current = [];
    errorPathsRef.current = new Set();
    if (typeof window.api.forgeProbe === "function") {
      window.api
        .forgeProbe()
        .then((res) => {
          if (cancelled) return;
          setProbePending(false);
          setProbeRepos(res?.repos ?? []);
          setCliStatus(res?.cli ?? null);
          setHomeDir(res?.homeDir ?? null);
        })
        .catch(() => {
          if (cancelled) return;
          setProbePending(false);
          setProbeFailed(true);
        });
    } else {
      // Probe not wired on this client (e.g. unpaired) — degrade gracefully.
      setProbePending(false);
      setProbeFailed(true);
    }
    return () => { cancelled = true; };
  }, [isNewProject, draftId]);

  const zeroState = zeroStateMode({
    probePending,
    probeFailed,
    repos: probeRepos,
  });

  // Pre-check rule: check what already exists on disk, capped at 8, most
  // recent first. Never check anything that would require a clone.
  useEffect(() => {
    if (probePending || probeFailed) {
      setChecked(new Set());
      return;
    }
    setChecked(
      new Set(initialRepoSelection(rows, PROBE_PRE_CHECK_CAP).map((r) => r.path)),
    );
  }, [probePending, probeFailed, rows]);

  const toggleRow = (path: string, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  // Land on the given created session: setActive + box-side select-window +
  // dismiss the draft, leaving the composer empty (never auto-submit a prompt).
  const landIn = async (entry: CreatedSession) => {
    const proj = useStore.getState().projects.find((p) => p.tmuxSession === entry.name);
    const win =
      entry.windowIndex != null
        ? proj?.windows.find((w) => w.index === entry.windowIndex)
        : proj?.windows.find((w) => w.active) ?? proj?.windows[0];
    const idx = win?.index ?? entry.windowIndex ?? 0;
    try {
      await activateWindow(entry.name, idx);
    } catch {
      setActive(entry.name, idx);
    }
    dismissDraft(draftId);
    onDone?.();
  };

  // Create one repo's workspace, tracking per-row progress. Partial failure
  // surfaces but never aborts the batch (submitFanOut's rule).
  const createRow = async (
    row: RepoRow,
    taken: Set<string>,
    createdOut: CreatedSession[],
  ) => {
    const name = uniqueSessionName(deriveProjectName(row.path), taken);
    taken.add(name);
    setRowPhase((p) => ({ ...p, [row.path]: "creating" }));
    setRowError((e) => {
      const n = { ...e };
      delete n[row.path];
      return n;
    });
    try {
      const res = await window.api.tmuxNewSession({
        name,
        cwd: row.path,
        windowName: "default",
        chatMode: true,
        createDir: false,
      });
      const norm = normalizeCreate(res);
      applyProjects(norm.projects);
      const entry: CreatedSession = { name, windowIndex: norm.windowIndex };
      createdOut.push(entry);
      errorPathsRef.current.delete(row.path);
      setRowPhase((p) => ({ ...p, [row.path]: "ready" }));
    } catch (e) {
      errorPathsRef.current.add(row.path);
      setRowPhase((p) => ({ ...p, [row.path]: "error" }));
      setRowError((err) => ({
        ...err,
        [row.path]: e instanceof Error ? e.message : String(e),
      }));
    }
  };

  // "Set up N workspaces": create one session per checked repo, in order
  // (most-recent-first). When every checked repo lands, navigate to the most
  // recently touched success and dismiss. Partial failure stays on the screen
  // with the errored row visible + retryable (done via "Done").
  const setupWorkspaces = async () => {
    if (sending) return;
    const chosen = rows.filter((r) => checked.has(r.path));
    if (chosen.length === 0) return;
    setSending(true);
    setBatchDone(true);
    setError(null);
    createdRef.current = [];
    errorPathsRef.current = new Set();
    setRowPhase(Object.fromEntries(chosen.map((r) => [r.path, "queued"])));
    setRowError({});
    const taken = new Set(existingProjects.map((p) => p.tmuxSession));
    for (const r of chosen) {
      await createRow(r, taken, createdRef.current);
    }
    const created = createdRef.current;
    setSending(false);
    if (created.length > 0 && errorPathsRef.current.size === 0) {
      // All succeeded → land in the most recently touched success.
      await landIn(created[0]);
    }
  };

  // Retry a single failed row (same partial-failure path). When the retry
  // clears the last error and something was created, proceed as normal.
  const retryRow = async (row: RepoRow) => {
    const taken = new Set(existingProjects.map((p) => p.tmuxSession));
    for (const c of createdRef.current) taken.add(c.name);
    await createRow(row, taken, createdRef.current);
    if (errorPathsRef.current.size === 0 && createdRef.current.length > 0) {
      await landIn(createdRef.current[0]);
    }
  };

  // Leave the partial-failure results view: land in the most recent success,
  // or just dismiss the draft (the App re-creates the zero-state draft) when
  // nothing was created.
  const finishSetup = async () => {
    if (createdRef.current.length > 0) {
      await landIn(createdRef.current[0]);
    } else {
      dismissDraft(draftId);
      onDone?.();
    }
  };

  // BET-796: hand off from the GitHub clone flow. The clone component only
  // produced directories on disk; creating the workspaces reuses the SAME batch
  // creation as the repo probe (createRow) — one code path, no duplicate.
  const setupCloned = async (paths: string[]) => {
    const cloneRows: RepoRow[] = paths.map((p) => ({ path: p, local: true } as RepoRow));
    if (cloneRows.length === 0) {
      setCloneOpen(false);
      return;
    }
    setSending(true);
    setBatchDone(true);
    setError(null);
    createdRef.current = [];
    errorPathsRef.current = new Set();
    setRowPhase(Object.fromEntries(cloneRows.map((r) => [r.path, "queued"])));
    setRowError({});
    // Merge the now-local clones into the probe list so the [S8]-style results
    // view shows per-row progress / retry just like probed repos.
    setProbeRepos((prev) => [...prev, ...cloneRows]);
    setCloneOpen(false);
    const taken = new Set(existingProjects.map((p) => p.tmuxSession));
    for (const r of cloneRows) {
      await createRow(r, taken, createdRef.current);
    }
    const created = createdRef.current;
    setSending(false);
    if (created.length > 0 && errorPathsRef.current.size === 0) {
      await landIn(created[0]);
    }
  };

  // The clone root [S6] proposes inline: `~/projects`, or the common parent of
  // the repos the probe found when they share one. Editable inside the picker.
  const proposedCloneRoot = useMemo(() => {
    const dirs = probeRepos
      .map((r) => (r.path?.includes("/") ? r.path.split("/").slice(0, -1).join("/") : ""))
      .filter(Boolean);
    if (dirs.length === 0) return "~/projects";
    let common = dirs[0];
    for (const d of dirs.slice(1)) {
      while (common && !d.startsWith(common)) {
        common = common.slice(0, common.lastIndexOf("/"));
      }
    }
    return common && common !== "/" && !common.startsWith("/root") ? common : "~/projects";
  }, [probeRepos]);



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
    onComplete: async ({ blob, mime }) => {
      try {
        const buffer = await blob.arrayBuffer();
        const res = await window.api.voiceTranscribe({ buffer, mime });
        const text = res.text.trim();
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
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    onError: (err: Error) => setError(err.message),
    onEmpty: () => {},
  });
  const voicePhase: VoicePhase = voiceRecorder.phase;
  const voiceRecording = voicePhase === "recording" || voicePhase === "requesting";
  const groqApiKey = useStore((s) => s.groqApiKey);
  const voiceEnabled = !!groqApiKey && typeof MediaRecorder !== "undefined";

  // ---- submit: create session + hand the first prompt to the real panel ----
  //
  // Creates the session (tmux window/session + opencode session + stamp) in
  // one RPC, then queues the first prompt (store autoSubmitPrompt) and
  // navigates to the new session. The App's persistent ChatPanel mounts, sees
  // the queued prompt, and sends it through its OWN submit path — so the user
  // message + running indicator appear reliably in the real transcript view.
  // Everything is driven by the server's returned window identity (no name
  // lookup, no transient panel, no depending on extra server fields).
  const submit = async () => {
    if (sending) return;
    const text = draft.input.trim();
    if (!text) return;
    setSending(true);
    setError(null);

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
        ? uniqueSessionName(
            deriveProjectName(draft.cwd),
            new Set(existingProjects.map((p) => p.tmuxSession)),
          )
        : projectName!;

      const created = newProject
        ? await window.api.tmuxNewSession({
            name: sessionName,
            cwd: dir,
            windowName: "default",
            chatMode: true,
            ...(worktreePath ? {} : { createDir: true }),
          })
        : await window.api.tmuxNewWindow({
            sessionName,
            windowName: promptWindowName(text),
            cwd: dir,
            chatMode: true,
            ...(worktreePath ? { worktreePath } : {}),
          });
      const createdNorm = normalizeCreate(created);
      applyProjects(createdNorm.projects);

      const proj = useStore
        .getState()
        .projects.find((p) => p.tmuxSession === sessionName);
      const win =
        createdNorm.windowIndex != null
          ? proj?.windows.find((w) => w.index === createdNorm.windowIndex)
          : proj?.windows.find((w) => w.active) ?? proj?.windows[0];
      const sessionId = createdNorm.sessionId ?? win?.opencodeSessionId ?? null;

      // Queue the first prompt for the App-mounted ChatPanel (which auto-submits
      // it through its own optimistic path) and navigate to the new session.
      if (sessionId) {
        setAutoSubmitPrompt({ sid: sessionId, text, model: draft.model ?? undefined });
      }
      // Navigate to the new session (setActive + box-side select-window so the
      // PTY follows) — one store action shared with the sidebar/jump flows.
      if (win) {
        try {
          await activateWindow(sessionName, win.index);
        } catch { /* non-fatal */ }
      } else {
        setActive(sessionName, createdNorm.windowIndex);
      }
      // Abandon the draft — it is now a real session.
      dismissDraft(draftId);
      onDone?.();
    } catch (e) {
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
      const sessionName = uniqueSessionName(
        deriveProjectName(baseCwd),
        new Set(existingProjects.map((p) => p.tmuxSession)),
      );

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

      if (win) {
        try {
          await activateWindow(sessionName, win.index);
        } catch { /* non-fatal */ }
      } else {
        setActive(sessionName, createdNorm.windowIndex);
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

  // The repo-probe zero state is the NEW-project zero state only. The
  // new-session-in-an-existing-project variant keeps today's composer
  // untouched, and the "Browse for a folder…" escape from the zero state lands
  // back on today's composer once a folder is picked (degrades to exactly
  // today's behaviour, never a state worse than before the probe existed).
  const showComposer = !isNewProject || browseChosen;

  return (
    // data-screen is the visual harness's handle on this screen (see
    // scripts/visual/screens.mjs). One stable attribute per screen root, so
    // the harness never depends on a class name or DOM position.
    <div data-screen="welcome" className="h-full flex flex-col items-center justify-center px-8">
      {cloneOpen ? (
        <CloneFromGitHub
          defaultRoot={proposedCloneRoot}
          onCancel={() => setCloneOpen(false)}
          onCloned={(paths) => void setupCloned(paths)}
        />
      ) : (
      <div className="w-full max-w-[720px] rounded-xl border border-border-subtle bg-bg-elev px-6 py-10 flex flex-col gap-2">
        {showComposer ? (
        <>
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
              onStart={() => { voiceRecorder.start(); }}
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
        </>
        ) : (
        <>
            {zeroState === "scanning" ? (
              <>
                <div className="text-center space-y-1 mb-4">
                  <h1 className="text-display font-bold tracking-tight text-text">What's up next?</h1>
                  <p className="text-body text-text-faint">Looking for repositories on your box…</p>
                </div>
                <div className="space-y-2" aria-hidden="true">
                  <Skeleton width={38} />
                  <Skeleton width={52} />
                  <Skeleton width={44} />
                </div>
                <div className="flex items-center gap-2 mt-4">
                  <Button tone="default" onClick={() => setPickerOpen(true)}>
                    Browse for a folder…
                  </Button>
                </div>
              </>
            ) : zeroState === "degraded" ? (
              <>
                <div className="text-center space-y-1 mb-4">
                  <h1 className="text-display font-bold tracking-tight text-text">What's up next?</h1>
                  <p className="text-body text-text-faint">
                    Couldn't scan for repositories. Point Manta at a folder instead.
                  </p>
                </div>
                <div className="flex justify-center mt-2">
                  <Button tone="primary" onClick={() => setPickerOpen(true)}>
                    Browse for a folder…
                  </Button>
                </div>
              </>
            ) : zeroState === "fresh" ? (
              <>
                <div className="text-center space-y-1 mb-4">
                  <h1 className="text-display font-bold tracking-tight text-text">
                    Let's get some code on this box
                  </h1>
                  <p className="text-body text-text-faint">
                    No repositories found. Clone one from GitHub, or point Manta at a folder.
                  </p>
                </div>
                <div className="flex justify-center gap-2 mt-4">
                  <Button
                    tone="primary"
                    onClick={() => setCloneOpen(true)}
                  >
                    Clone from GitHub…
                  </Button>
                  <Button tone="ghost" onClick={() => setPickerOpen(true)}>
                    Browse for a folder…
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="text-center space-y-1 mb-4">
                  <h1 className="text-display font-bold tracking-tight text-text">What's up next?</h1>
                  <p className="text-body text-text-faint">
                    Found {probeRepos.length} {probeRepos.length === 1 ? "repository" : "repositories"} on your box.
                  </p>
                </div>

                {cliStatus?.authenticated && (
                  <div className="flex items-center justify-center gap-[7px] -mt-[6px] mb-3 text-[12px] text-text-faint">
                    <StatusDot tone="ok" />
                    <span>
                      GitHub connected as{" "}
                      <b className="text-text-muted font-semibold">@{cliStatus.login}</b>
                    </span>
                    <span
                      className="text-[11.5px] text-text-faint underline decoration-dotted cursor-default"
                      title="Not available yet"
                    >
                      use a different account
                    </span>
                  </div>
                )}

                <div className="space-y-1">
                  {rows.map((r) =>
                    batchDone ? (
                      <ListRow
                        key={r.path}
                        leading={
                          <StatusDot
                            tone={
                              rowPhase[r.path] === "ready"
                                ? "ok"
                                : rowPhase[r.path] === "creating"
                                  ? "running"
                                  : rowPhase[r.path] === "error"
                                    ? "error"
                                    : "idle"
                            }
                          />
                        }
                        name={<span className="truncate">{r.name}</span>}
                        secondary={
                          rowPhase[r.path] === "error" ? (
                            <span className="truncate text-danger">{rowError[r.path]}</span>
                          ) : (
                            <span className="truncate">
                              {rowPhase[r.path] === "ready"
                                ? "ready"
                                : rowPhase[r.path] === "creating"
                                  ? "creating…"
                                  : "queued"}
                            </span>
                          )
                        }
                        trailing={
                          rowPhase[r.path] === "error" ? (
                            <Button tone="default" onClick={() => void retryRow(r)}>
                              Retry
                            </Button>
                          ) : undefined
                        }
                      />
                    ) : (
                      <ListRow
                        key={r.path}
                        leading={
                          <Checkbox
                            checked={checked.has(r.path)}
                            onChange={(v) => toggleRow(r.path, v)}
                            ariaLabel={`Set up ${r.name}`}
                          />
                        }
                        name={<span className="truncate">{r.name}</span>}
                        secondary={<span className="truncate">{describeRepoRow(r, homeDir)}</span>}
                        trailing={
                          <span>
                            {r.lastCommitAt ? formatAge(Date.now() - r.lastCommitAt) : "—"}
                          </span>
                        }
                        onClick={() => toggleRow(r.path, !checked.has(r.path))}
                        title={r.originUrl ? undefined : r.path}
                      />
                    ),
                  )}
                </div>

                <div className="flex items-center flex-wrap gap-2 mt-3">
                  {batchDone && !sending && hasFailed ? (
                    <Button tone="primary" onClick={() => void finishSetup()}>
                      Done
                    </Button>
                  ) : batchDone ? (
                    <span className="text-meta text-text-faint">Setting up workspaces…</span>
                  ) : (
                    <>
                      <Button
                        tone="primary"
                        onClick={() => void setupWorkspaces()}
                        disabled={checked.size === 0}
                      >
                        Set up {checked.size} workspace{checked.size === 1 ? "" : "s"}
                      </Button>
                      <Button tone="default" onClick={() => setPickerOpen(true)}>
                        Browse for a folder…
                      </Button>
                      <Button
                        tone="default"
                        onClick={() => setCloneOpen(true)}
                      >
                        Clone from GitHub…
                      </Button>
                    </>
                  )}
                </div>
              </>
            )}
        </>
        ))}

        {error && (
          <Card danger>
            <span className="text-meta text-danger break-words">{error}</span>
          </Card>
        )}
      </div>
      )}

      <FolderPickerModal
          open={pickerOpen}
          initialPath={draft.cwd || "~"}
          onSelect={(path) => {
            updateDraft(draftId, { cwd: path });
            if (isNewProject) setBrowseChosen(true);
            setPickerOpen(false);
          }}
          onFanOut={(baseCwd, wts) => {
            updateDraft(draftId, { cwd: baseCwd });
            if (isNewProject) setBrowseChosen(true);
            // Carry the worktree list straight into the submit — the picker
            // stays open and OWNS the in-flight state (its buttons disable and
            // read "Creating…" via fanOutBusy) instead of a second modal.
            void submitFanOut(baseCwd, wts);
          }}
          fanOutBusy={sending}
          onCancel={() => setPickerOpen(false)}
        />
    </div>
  );
}
