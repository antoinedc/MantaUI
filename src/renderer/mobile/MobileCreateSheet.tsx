import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { WorktreeInfo } from "../../shared/types";

// Bottom-sheet that creates either a new project (tmux session) OR a new
// session inside an existing project (tmux window). Mirrors the desktop
// `Sidebar.tsx` new-project / new-session flow but on a touch surface:
//   - Modal-ish full-width bottom sheet (matches the existing
//     mobile-sheet pattern used for session actions).
//   - cwd autocomplete uses the same `fsListDirs` channel as desktop
//     (shell-LCP semantics), but presents matches as a tappable
//     dropdown instead of ghost-text — ghost-text needs a Tab key
//     to commit, which touch keyboards don't have.
//   - Worktree fan-out is the same "detected N worktrees, open one
//     per?" pause as desktop, with the same `worktreeName(w)` =
//     `path basename` convention.
//
// `mode === "new-session"` skips the cwd field entirely: new windows
// inherit their project's `defaultCwd` server-side (see resolveProjectCwd
// in src/server/rpc.mjs). Same UX as desktop's per-project "+" button.

type CreateMode =
  | { kind: "new-project" }
  | { kind: "new-session"; projectName: string };

type Props = {
  mode: CreateMode;
  onClose: () => void;
  // Called with (projectName, windowIndex?) after successful create so the
  // parent can navigate into the new session. windowIndex is null on
  // new-project (parent should leave the user on the list — they pick
  // which window to open).
  onCreated: (projectName: string, windowIndex: number | null) => void;
};

// Window name for a worktree: dir basename. Mirrors desktop's `worktreeName`.
function worktreeName(w: WorktreeInfo): string {
  return w.path.split("/").filter(Boolean).pop() || w.branch || "wt";
}

export function MobileCreateSheet({ mode, onClose, onCreated }: Props) {
  const setActive = useStore((s) => s.setActive);
  const refresh = useStore((s) => s.refresh);

  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("~");

  // cwd autocomplete: debounced fsListDirs query; results in a tappable list.
  const [cwdMatches, setCwdMatches] = useState<string[]>([]);
  const cwdDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Worktree fan-out pause (new-project only).
  const [detectedWorktrees, setDetectedWorktrees] = useState<
    WorktreeInfo[] | null
  >(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cleanup the debounce on unmount so a late callback doesn't setState
  // on an unmounted sheet.
  useEffect(() => {
    return () => {
      if (cwdDebounce.current) clearTimeout(cwdDebounce.current);
    };
  }, []);

  const refreshCwdMatches = (value: string) => {
    if (cwdDebounce.current) clearTimeout(cwdDebounce.current);
    if (!value) {
      setCwdMatches([]);
      return;
    }
    cwdDebounce.current = setTimeout(async () => {
      try {
        const matches = (await window.api.fsListDirs(value)).filter((m) =>
          m.startsWith(value),
        );
        // Only show suggestions when there's something to disambiguate or
        // descend into. A single match equal to the typed value is
        // redundant noise.
        if (matches.length === 1 && matches[0] === value) setCwdMatches([]);
        else setCwdMatches(matches.slice(0, 8));
      } catch {
        setCwdMatches([]);
      }
    }, 80);
  };

  const onCwdChange = (value: string) => {
    setCwd(value);
    refreshCwdMatches(value);
  };

  const pickCwd = (path: string) => {
    // Append a trailing "/" so the next probe descends into it (matches
    // desktop ghost-text behavior).
    const next = path.endsWith("/") ? path : path + "/";
    setCwd(next);
    refreshCwdMatches(next);
  };

  const showError = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    setCreating(false);
  };

  // ---- new-session flow (mode.kind === "new-session") ----
  // Just create a tmux window in the existing project; cwd is inherited.

  const createSession = async () => {
    if (mode.kind !== "new-session" || creating) return;
    setCreating(true);
    setError(null);
    const windowName = name.trim() || "session";
    try {
      const projects = await window.api.tmuxNewWindow({
        sessionName: mode.projectName,
        windowName,
        chatMode: true,
      });
      await refresh();
      // Resolve the new window's index from the response (highest index in
      // the project with the matching name — matches desktop's pattern).
      const proj = projects.find((p) => p.tmuxSession === mode.projectName);
      const w = proj?.windows.find((x) => x.name === windowName);
      if (w) {
        setActive(mode.projectName, w.index);
        try {
          await window.api.tmuxSelectWindow({
            sessionName: mode.projectName,
            windowIndex: w.index,
          });
        } catch {
          /* select-window failures are non-fatal — UI still navigates */
        }
        onCreated(mode.projectName, w.index);
      } else {
        onCreated(mode.projectName, null);
      }
    } catch (e) {
      showError(e);
    }
  };

  // ---- new-project flow (mode.kind === "new-project") ----
  // - "auto": probe worktrees; if >1, pause for confirm. Otherwise create.
  // - "all": fan out one window per worktree (first becomes initial window).
  // - "single": ignore worktrees, single window at typed cwd.

  const createProject = async (
    submode: "auto" | "all" | "single" = "auto",
  ) => {
    if (mode.kind !== "new-project" || creating) return;
    const projectName = name.trim();
    if (!projectName) return;
    const path = cwd.trim() || "";

    setError(null);

    if (submode === "auto") {
      setCreating(true);
      try {
        const wts = await window.api.gitListWorktrees(path);
        if (wts.length > 1) {
          setDetectedWorktrees(wts);
          setCreating(false);
          return;
        }
      } catch {
        // probe fail → fall through, single-window flow handles errors
      }
      try {
        await window.api.tmuxNewSession({
          name: projectName,
          cwd: path,
          windowName: "default",
          chatMode: true,
        });
        // Persist defaultCwd for the new project so future `tmux:new-window`
        // calls inherit it (resolveProjectCwd in rpc.mjs reads this). Without
        // this, the server falls back to ~, which defeats the project's
        // intended workspace path. Mirror of desktop tmuxNewSession path
        // (src/main/index.ts) which writes ProjectMeta on creation.
        await window.api
          .projectMetaUpsert({ tmuxSession: projectName, defaultCwd: path })
          .catch(() => {});
        await refresh();
        setActive(projectName);
        onCreated(projectName, null);
      } catch (e) {
        showError(e);
      }
      return;
    }

    setCreating(true);
    try {
      if (
        submode === "all" &&
        detectedWorktrees &&
        detectedWorktrees.length > 1
      ) {
        const [first, ...rest] = detectedWorktrees;
        await window.api.tmuxNewSession({
          name: projectName,
          cwd: first.path,
          windowName: worktreeName(first),
          chatMode: true,
        });
        for (const w of rest) {
          try {
            await window.api.tmuxNewWindow({
              sessionName: projectName,
              windowName: worktreeName(w),
              cwd: w.path,
              chatMode: true,
            });
          } catch (e) {
            // Surface but don't abort — partial fan-out beats undoing the
            // session creation halfway. Same trade-off as desktop.
            setError(e instanceof Error ? e.message : String(e));
          }
        }
      } else {
        await window.api.tmuxNewSession({
          name: projectName,
          cwd: path,
          windowName: "default",
          chatMode: true,
        });
      }
      // Same project-meta write as the auto/single path above.
      await window.api
        .projectMetaUpsert({ tmuxSession: projectName, defaultCwd: path })
        .catch(() => {});
      await refresh();
      setActive(projectName);
      onCreated(projectName, null);
    } catch (e) {
      showError(e);
    }
  };

  const titleText =
    mode.kind === "new-project"
      ? "New project"
      : `New session in "${mode.projectName}"`;
  const nameLabel = mode.kind === "new-project" ? "Project name" : "Session name";
  const namePlaceholder =
    mode.kind === "new-project" ? "my-project" : "session";

  return (
    <div className="mobile-sheet-backdrop" onClick={onClose}>
      <div
        className="mobile-sheet"
        onClick={(e) => e.stopPropagation()}
        // Slightly taller padding than the action sheet — this one is a form,
        // not a single-tap action list.
        style={{ padding: "16px 16px max(env(safe-area-inset-bottom), 16px)" }}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="text-text font-semibold text-sm">{titleText}</div>
          <button
            onClick={onClose}
            className="mobile-tap text-text-muted text-xl leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {detectedWorktrees ? (
          // ---- Worktree confirm UI: identical decision the desktop offers ----
          <div className="space-y-3">
            <div className="text-xs text-text-muted">
              Detected {detectedWorktrees.length} git worktrees. Open a session
              for each?
            </div>
            <ul className="text-[11px] text-text-faint space-y-0.5 max-h-32 overflow-y-auto">
              {detectedWorktrees.map((w) => (
                <li key={w.path} className="truncate">
                  <span className="text-text-muted">{worktreeName(w)}</span>
                  <span className="text-text-faint"> — {w.path}</span>
                </li>
              ))}
            </ul>
            {error && <div className="text-xs text-red-400">{error}</div>}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => createProject("all")}
                disabled={creating}
                className="px-3 py-2.5 bg-accent text-bg rounded font-semibold disabled:opacity-50"
              >
                Yes, one per worktree
              </button>
              <button
                onClick={() => createProject("single")}
                disabled={creating}
                className="px-3 py-2.5 border border-border text-text-muted rounded disabled:opacity-50"
              >
                Just main
              </button>
              <button
                onClick={onClose}
                disabled={creating}
                className="px-3 py-2 text-text-faint"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          // ---- Standard form (new-project OR new-session) ----
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-[11px] uppercase tracking-wider text-text-muted">
                {nameLabel}
              </label>
              <input
                autoFocus
                placeholder={namePlaceholder}
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
              />
            </div>

            {mode.kind === "new-project" && (
              <div className="space-y-1">
                <label className="block text-[11px] uppercase tracking-wider text-text-muted">
                  Default working directory
                </label>
                <input
                  placeholder="~/code/foo"
                  value={cwd}
                  onChange={(e) => onCwdChange(e.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded font-mono focus:outline-none focus:border-accent"
                />
                {cwdMatches.length > 0 && (
                  // Tappable suggestions list — replaces the desktop's ghost-text
                  // accept-with-Tab affordance. Showing the parent prefix and
                  // bolding the differing tail would be cleaner but parent
                  // resolution depends on the input format; this plain truncate
                  // is honest about what fsListDirs returned.
                  <div className="bg-bg-soft border border-border rounded max-h-40 overflow-y-auto">
                    {cwdMatches.map((m) => (
                      <button
                        key={m}
                        onClick={() => pickCwd(m)}
                        className="w-full text-left px-3 py-2 text-xs text-text-muted font-mono truncate hover:bg-bg-elev active:bg-bg-elev"
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {error && <div className="text-xs text-red-400">{error}</div>}

            <div className="flex flex-col gap-2 pt-1">
              <button
                onClick={
                  mode.kind === "new-project"
                    ? () => createProject("auto")
                    : createSession
                }
                disabled={creating || !name.trim()}
                className="px-3 py-2.5 bg-accent text-bg rounded font-semibold disabled:opacity-50"
              >
                {creating
                  ? "Creating…"
                  : mode.kind === "new-project"
                    ? "Create project"
                    : "Create session"}
              </button>
              <button
                onClick={onClose}
                disabled={creating}
                className="px-3 py-2 text-text-faint"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
