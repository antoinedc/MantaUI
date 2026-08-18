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
  RotateCw,
} from "lucide-react";
import { useStore } from "./store";
import { Chip } from "./Chip";
import { Tag } from "./Tag";
import { ModelPicker } from "./ModelPicker";
import { useModelCatalog } from "./modelCatalog";
import { useAgentCatalog } from "./agentCatalog";
import { MicButton, PlanChip, TrustRow } from "./ComposerParts";
import { UsageDial } from "./UsageDial";
import { IconButton } from "./IconButton";
import { Button } from "./Button";
import { Card } from "./Card";
import { Checkbox } from "./Checkbox";
import { FolderPickerModal } from "./FolderPickerModal";
import { ListRow } from "./ListRow";
import { ScrollFrame } from "./ScrollFrame";
import { Skeleton } from "./Skeleton";
import { CloneFromGitHub } from "./CloneFromGitHub";
import { StatusDot } from "./StatusDot";
import { worktreeName } from "./folderPicker";
import { useVoiceRecorder } from "./voice";
import {
  describeRepoRow,
  formatAge,
  resolvePlanToggle,
  zeroStateMode,
  type RepoRow,
} from "./chatUtils";
import {
  deriveProjectName,
  generateProjectName,
  promptWindowName,
  slugifyProjectName,
  uniqueSessionName,
} from "../shared/projectName.mjs";
import type { VoicePhase } from "./voice";
import type {
  ForgeCliStatus,
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

type ZeroAction = {
  label: string;
  tone: "primary" | "default" | "ghost";
  onClick: () => void;
  disabled?: boolean;
};

function ZeroStateActions({ actions, className }: { actions: ZeroAction[]; className?: string }) {
  return (
    <div className={"flex items-center flex-wrap gap-2" + (className ? " " + className : "")}>
      {actions.map((a) => (
        <Button key={a.label} tone={a.tone} onClick={a.onClick} disabled={a.disabled}>
          {a.label}
        </Button>
      ))}
    </div>
  );
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
  // What the folder picker is editing right now: the composer's cwd ("cwd",
  // today's behaviour) or the scratch root ("root", BET-1093). Default "cwd".
  const [pickerTarget, setPickerTarget] = useState<"cwd" | "root">("cwd");
  // Entry names returned by fsListDirs(scratchRoot), the local collision hint
  // for scratch mode (BET-1093 §5).
  const [fsEntries, setFsEntries] = useState<Set<string>>(new Set());
  const [worktrees, setWorktrees] = useState<WorktreeInfo[] | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ---- repo probe (BET-787): the new-project zero state ----
  // Probe the box for git repos + the gh CLI. The scan is purely additive: if
  // it fails or is unavailable we degrade to exactly today's behaviour (the
  // folder picker), never a state worse than the one the screen used to have.
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

  // The proposed workspace root: the box's real home dir + `/projects`, or the
  // common parent of the repos the probe found when they share one. One memo,
  // two consumers — the GitHub clone root [S6] and scratch mode's `scratchRoot`
  // (BET-1093). Editable inside the picker. When homeDir is unknown the root is
  // empty and callers stay disabled — never invent a fallback string.
  const proposedWorkspaceRoot = useMemo(() => {
    const dirs = probeRepos
      .map((r) => (r.path?.includes("/") ? r.path.split("/").slice(0, -1).join("/") : ""))
      .filter(Boolean);
    if (dirs.length === 0) return homeDir ? `${homeDir}/projects` : "";
    let common = dirs[0];
    for (const d of dirs.slice(1)) {
      while (common && !d.startsWith(common)) {
        common = common.slice(0, common.lastIndexOf("/"));
      }
    }
    return common && common !== "/" ? common : homeDir ? `${homeDir}/projects` : "";
  }, [probeRepos, homeDir]);

  // BET-1093: "Start from scratch" — flip this draft into scratch mode and name
  // it immediately (generation is local + instant, so the composer never opens
  // with an empty-name state and Create is never blocked on naming).
  const startScratch = () =>
    updateDraft(draftId, {
      scratch: true,
      projectName: generateProjectName(),
      scratchRoot: proposedWorkspaceRoot,
    });

  // Collision hint for scratch mode: the entry names under scratchRoot plus
  // every existing project session. Non-fatal — an unreadable root yields an
  // empty set and no hint.
  const scratchTaken = useMemo(() => {
    const s = new Set(fsEntries);
    for (const p of existingProjects) s.add(p.tmuxSession);
    return s;
  }, [fsEntries, existingProjects]);

  useEffect(() => {
    if (!draft.scratch || !draft.scratchRoot) {
      setFsEntries(new Set());
      return;
    }
    let cancelled = false;
    window.api
      .fsListDirs(draft.scratchRoot)
      .then((listing) => {
        if (cancelled) return;
        setFsEntries(new Set((listing?.entries ?? []).map((e) => e.name)));
      })
      .catch(() => {
        if (cancelled) return;
        setFsEntries(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [draft.scratch, draft.scratchRoot]);

  // Model state — the SHARED cached catalog (same hook as ChatPanel), so the
  // picker renders its last-known models synchronously on remount instead of
  // flashing empty while a fresh fetch runs. The shared module carries the
  // same pre-pairing httpApi-only guard this screen's old local fetch had.
  const { models, defaultModel: serverDefault } = useModelCatalog();

  // Active model object for the usage dial + model menu. Resolved through the
  // same shared path ChatPanel uses so the welcome composer and a session
  // never disagree about which model is active.
  const activeModel = useMemo(
    () => resolveActiveModel(models, draft.model, serverDefault),
    [models, draft.model, serverDefault],
  );

  // Plan mode availability comes from the shared box-level agent catalog
  // (same source as a real session's composer), resolved against the draft's
  // own plan flag. The chip drives draft.plan, which submit() carries into the
  // created session's first turn.
  const { agents } = useAgentCatalog();
  const plan = useMemo(
    () => resolvePlanToggle(agents, draft.plan),
    [agents, draft.plan],
  );

  // Trust row: chatAutoAllow is a single global config value — flipping it
  // here flips it everywhere (no per-draft copy; a draft isn't a session).
  const chatAutoAllow = useStore((s) => s.chatAutoAllow);
  const setChatAutoAllow = useStore((s) => s.setChatAutoAllow);

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
    if (!text && !draft.scratch) return;
    setSending(true);
    setError(null);

    try {
      // Scratch mode: create the empty project directory first (the server
      // slugifies + de-dups the name and returns the real absolute path). Its
      // `createDir` must NOT ride the session call below — the dir exists now.
      let scratchPath: string | undefined;
      if (draft.scratch) {
        const res = await window.api.projectCreateScratch({
          root: draft.scratchRoot,
          name: draft.projectName,
        });
        scratchPath = res.path;
      }
      // Resolve folder + (optionally) a fresh worktree once, up front. The
      // worktree block is entirely skipped in scratch mode (nothing to branch
      // from).
      let worktreePath: string | undefined;
      if (!draft.scratch && draft.wantWorktree && isGitRepo) {
        const wt = await window.api.gitAddWorktree({ cwd: draft.cwd, name: draft.worktreeBranch });
        worktreePath = wt.path;
      }
      const dir = scratchPath ?? worktreePath ?? draft.cwd;
      const newProject = isNewProject;
      // The session name comes from the REAL directory (the server may have
      // suffixed / slugified the scratch name) — the folder is the truth.
      const sessionName = newProject
        ? uniqueSessionName(
            deriveProjectName(dir),
            new Set(existingProjects.map((p) => p.tmuxSession)),
          )
        : projectName!;

      const created = newProject
        ? await window.api.tmuxNewSession({
            name: sessionName,
            cwd: dir,
            windowName: "default",
            chatMode: true,
            ...(worktreePath || draft.scratch ? {} : { createDir: true }),
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
      // The plan flag rides the same one-shot channel so the draft's plan mode
      // lands on the session's FIRST turn (see ChatPanel's autoSubmit effect).
      // Only queue when there IS a prompt — scratch mode may submit empty.
      if (sessionId && text) {
        setAutoSubmitPrompt({
          sid: sessionId,
          text,
          model: draft.model ?? undefined,
          plan: draft.plan,
        });
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
        // 6th param is the agent. Fan-out can't use the autoSubmit channel (it
        // sends directly), so resolve the plan agent here exactly as ChatPanel
        // does (plan.available && plan.on) so the two paths cannot diverge.
        await window.api.opencodePrompt(
          sessionId,
          text,
          draft.model ?? undefined,
          undefined,
          undefined,
          plan.available && plan.on ? plan.agent : undefined,
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
  // A repo with no commits has nothing to branch from, and an empty scratch
  // project is by definition commit-less — force the worktree checkbox off.
  const worktreeChipEnabled = !draft.scratch && (emptyWorktree || isGitRepo);

  // The repo-probe zero state is the NEW-project zero state only. The
  // new-session-in-an-existing-project variant keeps today's composer
  // untouched, and the "Browse for a folder…" escape from the zero state lands
  // back on today's composer once a folder is picked (degrades to exactly
  // today's behaviour, never a state worse than before the probe existed).
  const showComposer = !isNewProject || browseChosen || draft.scratch;

  // Send-button affordance: "Create workspace" when the composer is in scratch
  // mode with an empty prompt (the action creates the project), otherwise the
  // standard "Start a session".
  const createLabel = draft.scratch && !draft.input.trim() ? "Create workspace" : "Start a session";
  const scratchNameTaken = draft.scratch && !!draft.projectName && scratchTaken.has(draft.projectName);

  return (
    // data-screen is the visual harness's handle on this screen (see
    // scripts/visual/screens.mjs). One stable attribute per screen root, so
    // the harness never depends on a class name or DOM position.
    <div data-screen="welcome" className="h-full flex flex-col items-center justify-center px-8">
      {cloneOpen ? (
        <CloneFromGitHub
          defaultRoot={proposedWorkspaceRoot}
          onCancel={() => setCloneOpen(false)}
          onCloned={(paths) => void setupCloned(paths)}
        />
      ) : (
      <div className="w-full max-w-[720px] rounded-xl border border-border-subtle bg-bg-elev px-6 py-10 flex flex-col gap-2">
        {showComposer ? (
        <>
        <div className="text-center space-y-1 mb-4">
          {draft.scratch ? (
            <>
              <h1 className="text-display font-bold tracking-tight text-text">Start something new</h1>
              <p className="text-body text-text-faint">
                Name it whatever you like — we picked one to get you going.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-display font-bold tracking-tight text-text">What's up next?</h1>
              <p className="text-body text-text-faint">
                Start a session on any folder your box can see.
              </p>
            </>
          )}
        </div>

        {/* Chip row — in scratch mode the name input + reroll replace the folder
            chip; the branch chip + worktree checkbox stay in both modes. */}
        <div className="self-start flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {draft.scratch ? (
            <>
              <input
                value={draft.projectName}
                onChange={(e) =>
                  updateDraft(draftId, { projectName: slugifyProjectName(e.target.value) })
                }
                spellCheck={false}
                className="h-8 w-[240px] rounded-md border border-accent bg-bg-soft px-3 text-meta font-mono text-text outline-none focus:border-accent"
                placeholder="project-name"
                aria-label="Project name"
              />
              <IconButton
                icon={<RotateCw />}
                label="Pick another name"
                onClick={() => updateDraft(draftId, { projectName: generateProjectName() })}
              />
            </>
          ) : (
            <Chip
              onClick={() => {
                setPickerTarget("cwd");
                setPickerOpen(true);
              }}
              title={draft.cwd || "Select folder"}
            >
              <FolderIcon size={13} className="shrink-0 text-text-muted" aria-hidden="true" />
              <span className="truncate max-w-[200px]">{folderLabel}</span>
              <ChevronDown size={13} className="shrink-0 text-text-faint" aria-hidden="true" />
            </Chip>
          )}

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
            // When "worktree" is unchecked the branch is not editable — it is
            // metadata about the folder, not a control. An inert Tag (no
            // button, no onClick, no popover) matches the session header's
            // branch badge and avoids a dead hover affordance.
            <Tag
              size="sm"
              icon={<GitBranch size={11} aria-hidden="true" className="shrink-0" />}
              title={branchName ? `On branch ${branchName}` : "Not a git repository"}
            >
              <span className="truncate max-w-[120px]">{branchName ?? "no branch"}</span>
            </Tag>
          )}

          <Checkbox
            checked={draft.wantWorktree}
            disabled={!worktreeChipEnabled}
            onChange={(v) => updateDraft(draftId, { wantWorktree: v })}
            label="worktree"
            ariaLabel="Create in a fresh git worktree"
          />
        </div>

        {draft.scratch && (
          <div className="text-meta text-text-faint font-mono">
            ↳ {draft.scratchRoot}/{draft.projectName} ·{" "}
            <button
              type="button"
              onClick={() => {
                setPickerTarget("root");
                setPickerOpen(true);
              }}
              className="text-accent-tx underline decoration-dotted"
            >
              edit
            </button>
          </div>
        )}

        {scratchNameTaken && (
          <span className="text-meta text-warn">
            {draft.projectName} already exists — will create{" "}
            {uniqueSessionName(draft.projectName, scratchTaken)}
          </span>
        )}
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
            placeholder={
              draft.scratch
                ? "Describe a task, or leave it empty and just start"
                : "Describe a task or ask a question"
            }
            rows={3}
            className="flex-1 w-full bg-transparent border-0 text-prose text-text outline-none resize-none placeholder:text-text-faint"
            spellCheck={false}
          />

          <button
            onClick={() => void submit()}
            disabled={sending || (!draft.input.trim() && !draft.scratch)}
            aria-label={createLabel}
            title={
              sending
                ? "Starting…"
                : draft.input.trim()
                  ? "Start a session"
                  : createLabel
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

        {/* Controls row — model ▸ effort + plan chip on the left, attach +
            dictate beside them, with the usage dial grouped right (mirrors the
            session composer's meta footer layout). No SessionToolbar here —
            schedules/secrets/webhooks are session-scoped and there is no
            session yet. */}
        <div className="py-1 flex items-center justify-between gap-3 flex-wrap">
          <span className="flex items-center gap-2 min-w-0 flex-wrap">
            <ModelPicker
              modelLabel={null}
              models={models}
              modelOverride={draft.model}
              defaultModel={serverDefault}
              deactivatedMainModels={deactivatedMainModels}
              onOpen={() => {}}
              onSelect={(m: ModelSelection | null) => {
                // null = clear back to the server default.
                updateDraft(draftId, { model: m });
              }}
            />
            <PlanChip
              plan={plan}
              onToggle={() => updateDraft(draftId, { plan: !draft.plan })}
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
          </span>
          <span className="shrink-0 flex items-center gap-2 flex-wrap">
            <UsageDial providerID={activeModel?.providerID ?? null} />
          </span>
        </div>

        {/* Permissions row — the shared trust toggle (plan mode reads "Plan
            mode — edits blocked"; else the chatAutoAllow bypass). */}
        <TrustRow planOn={plan.on} chatAutoAllow={chatAutoAllow} setChatAutoAllow={setChatAutoAllow} />
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
                <ZeroStateActions
                  className="mt-4"
                  actions={[
                    { label: "Browse for a folder…", tone: "default", onClick: () => setPickerOpen(true) },
                    { label: "Start from scratch", tone: "default", onClick: startScratch },
                  ]}
                />
              </>
            ) : zeroState === "degraded" ? (
              <>
                <div className="text-center space-y-1 mb-4">
                  <h1 className="text-display font-bold tracking-tight text-text">What's up next?</h1>
                  <p className="text-body text-text-faint">
                    Couldn't scan for repositories. Point Manta at a folder instead.
                  </p>
                </div>
                <ZeroStateActions
                  className="justify-center mt-2"
                  actions={[
                    { label: "Browse for a folder…", tone: "primary", onClick: () => setPickerOpen(true) },
                    { label: "Start from scratch", tone: "default", onClick: startScratch },
                  ]}
                />
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
                <ZeroStateActions
                  className="justify-center mt-4"
                  actions={[
                    { label: "Clone from GitHub…", tone: "primary", onClick: () => setCloneOpen(true) },
                    { label: "Browse for a folder…", tone: "ghost", onClick: () => setPickerOpen(true) },
                    { label: "Start from scratch", tone: "default", onClick: startScratch },
                  ]}
                />
              </>
            ) : (
              <ScrollFrame
                header={
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
                  </>
                }
                footer={
                  batchDone && !sending && hasFailed ? (
                    <div className="flex items-center flex-wrap gap-2 mt-3">
                      <Button tone="primary" onClick={() => void finishSetup()}>
                        Done
                      </Button>
                    </div>
                  ) : batchDone ? (
                    <div className="flex items-center flex-wrap gap-2 mt-3">
                      <span className="text-meta text-text-faint">Setting up workspaces…</span>
                    </div>
                  ) : (
                    <ZeroStateActions
                      className="mt-3"
                      actions={[
                        {
                          label: `Set up ${checked.size} workspace${checked.size === 1 ? "" : "s"}`,
                          tone: "primary",
                          onClick: () => void setupWorkspaces(),
                          disabled: checked.size === 0,
                        },
                        { label: "Browse for a folder…", tone: "default", onClick: () => setPickerOpen(true) },
                        { label: "Clone from GitHub…", tone: "default", onClick: () => setCloneOpen(true) },
                        { label: "Start from scratch", tone: "default", onClick: startScratch },
                      ]}
                    />
                  )
                }
              >
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
              </ScrollFrame>
            )}
        </>
        )}

        {error && (
          <Card danger>
            <span className="text-meta text-danger break-words">{error}</span>
          </Card>
        )}
      </div>
      )}

      <FolderPickerModal
          open={pickerOpen}
          initialPath={pickerTarget === "root" ? draft.scratchRoot || "~" : draft.cwd || "~"}
          onSelect={(path) => {
            if (pickerTarget === "root") {
              // Editing the scratch root: write it, don't touch cwd/browse.
              updateDraft(draftId, { scratchRoot: path });
            } else {
              updateDraft(draftId, { cwd: path });
              if (isNewProject) setBrowseChosen(true);
            }
            setPickerOpen(false);
            setPickerTarget("cwd");
          }}
          onFanOut={(baseCwd, wts) => {
            updateDraft(draftId, { cwd: baseCwd });
            if (isNewProject) setBrowseChosen(true);
            setPickerTarget("cwd");
            // Carry the worktree list straight into the submit — the picker
            // stays open and OWNS the in-flight state (its buttons disable and
            // read "Creating…" via fanOutBusy) instead of a second modal.
            void submitFanOut(baseCwd, wts);
          }}
          fanOutBusy={sending}
          onCancel={() => {
            setPickerTarget("cwd");
            setPickerOpen(false);
          }}
        />
    </div>
  );
}
