// FolderPickerModal.tsx — the folder browser that replaces the ghost-text cwd
// input (BET-417 §B).
//
// - Path field at the top, keeping the EXISTING completion logic
//   (refreshCwdSuggestion / acceptCwdSuggestion from Sidebar.tsx, moved here).
// - Clickable breadcrumbs under it — going up three levels is one click.
// - A scrollable folder list using the existing `fsListDirs`. `..` first.
//   `node_modules` and dot-folders render at --tx4 (dimmed, not hidden).
// - Worktree badge on directories that have them; the fan-out question is
//   asked HERE, before the user commits, instead of as a post-Create
//   interstitial.
// - Footer: the selected folder's git state, Cancel, and a primary Select.
// - Mobile gets it as a full-height sheet (handled by .mobile-* CSS classes).
//
// Pure helpers (breadcrumbs / parentPath / worktreeBadge /
// gitStateLabel) live in folderPicker.ts and are unit-tested there.

import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  X,
  Folder as FolderIcon,
  ArrowUp,
  Home,
} from "lucide-react";
import type { WorktreeInfo } from "../shared/types";
import {
  breadcrumbs,
  crumbLabel,
  gitStateLabel,
  hasWorktreeFanOut,
  parentPath,
  worktreeBadge,
} from "./folderPicker";
import { Modal } from "./Modal";
import { Button } from "./Button";

type Props = {
  // Controlled presence. Kept MOUNTED so Modal can play its exit animation.
  open: boolean;
  // The initial path the picker opens at (e.g. the project's cwd). Normalized
  // to absolute on first list (a leading ~ resolves via the server).
  initialPath: string;
  // Called when the user picks a single folder (no fan-out).
  onSelect: (path: string) => void;
  // Called when the user picks "One per worktree" — the parent creates one
  // session with one window per worktree, each named worktreeName(w).
  // When omitted, the fan-out question is not offered (mobile can opt out).
  onFanOut?: (cwd: string, worktrees: WorktreeInfo[]) => void;
  // When a fan-out create is in flight, the picker OWNS the confirmation that
  // the old second "Fan-out confirmed" modal used to: its three choice buttons
  // are disabled and the fan-out one reads "Creating…", so the single picker
  // modal is the whole flow (BET-938).
  fanOutBusy?: boolean;
  onCancel: () => void;
};

// A row in the folder list. `name` is the directory basename; `full` is the
// absolute path to feed back into fsListDirs when the user descends.
type Row = {
  name: string;
  full: string;
};

// Worktree fan-out state. When the user selects a folder that has >1
// worktree, we pause and ask "one per worktree?" HERE — not after Create.
// Mirrors the old interstitial's `mode: "auto" | "all"` logic but relocated
// to the browse step so the decision is not a surprise.
type FanOut =
  | null
  | { worktrees: WorktreeInfo[]; cwd: string };

export function FolderPickerModal({ open, initialPath, onSelect, onFanOut, fanOutBusy, onCancel }: Props) {
  const [path, setPath] = useState(initialPath);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The picker stays MOUNTED (so Modal can play its exit); reset the browse
  // location each time it re-opens, preserving the old per-open fresh-start.
  useEffect(() => {
    if (open) setPath(initialPath);
  }, [open, initialPath]);
  const [rows, setRows] = useState<Row[]>([]);
  // Per-directory worktree probe. Keyed by the row's full path; null = not
  // probed yet / not a repo. We probe each row lazily after the listing
  // loads, with a small concurrency cap to avoid hammering git. The badge
  // ("⎇ N worktrees") shows on rows that have >1 worktree, so the user
  // sees the fan-out option BEFORE committing (BET-417 §B).
  const [worktreeCounts, setWorktreeCounts] = useState<
    Record<string, WorktreeInfo[] | null>
  >({});
  const [fanOut, setFanOut] = useState<FanOut>(null);
  const [gitState, setGitState] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  // ---- path completion (moved verbatim from Sidebar.tsx) ----
  const refreshSuggestion = (value: string) => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!value) {
      setSuggestion(null);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const dir = value.endsWith("/") ? value : parentPath(value);
        const prefix = value.endsWith("/") ? "" : (value.split("/").pop() ?? "");
        const res = await window.api.fsListDirs(dir);
        const matches = res.entries
          .filter((e) => !e.hidden && e.name.startsWith(prefix))
          .map((e) => e.path);
        if (matches.length === 0) {
          setSuggestion(null);
          return;
        }
        if (matches.length === 1) {
          setSuggestion(matches[0] + "/");
          return;
        }
        const lcp = matches.reduce((acc, m) => {
          let i = 0;
          while (i < acc.length && i < m.length && acc[i] === m[i]) i++;
          return acc.slice(0, i);
        });
        setSuggestion(lcp.length > value.length ? lcp : null);
      } catch {
        setSuggestion(null);
      }
    }, 80);
  };

  const onPathChange = (value: string) => {
    setPath(value);
    refreshSuggestion(value);
  };

  const acceptSuggestion = (): boolean => {
    if (!suggestion || !suggestion.startsWith(path)) return false;
    if (suggestion === path) return false;
    setPath(suggestion);
    setSuggestion(null);
    refreshSuggestion(suggestion);
    return true;
  };

  // ---- listing ----
  const listDir = async (dir: string) => {
    setLoading(true);
    setError(null);
    setWorktreeCounts({});
    try {
      const res = await window.api.fsListDirs(dir);
      // Normalize the path field: if the server resolved a different directory
      // than the one we listed (e.g. a typed `~` expanded to an absolute path),
      // set it once so no tilde survives anywhere in the UI.
      if (res.dir.replace(/\/$/, "") !== dir.replace(/\/$/, "")) {
        setPath(res.dir + "/");
      }
      const built: Row[] = res.entries
        .filter((e) => !e.hidden)
        .map((e) => ({ name: e.name, full: e.path }));
      setRows(built);
      // Probe the selected dir's own git state for the footer.
      try {
        const wts = await window.api.gitListWorktrees(dir);
        setGitState(gitStateLabel(wts));
      } catch {
        setGitState("");
      }
      // Lazily probe each row for worktree fan-out (BET-417 §B). Probes run
      // with concurrency 4 so a 20-row listing finishes in ~5 git calls
      // instead of 20 sequential ones. Failures are silent (not a repo →
      // no badge).
      const probeRow = async (full: string) => {
        try {
          const wts = await window.api.gitListWorktrees(full);
          setWorktreeCounts((prev) => ({ ...prev, [full]: wts }));
        } catch {
          setWorktreeCounts((prev) => ({ ...prev, [full]: null }));
        }
      };
      const queue = [...built.map((r) => r.full)];
      const workers = Array.from({ length: 4 }, async () => {
        while (queue.length > 0) {
          const full = queue.shift();
          if (full) await probeRow(full);
        }
      });
      void Promise.all(workers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
      setGitState("");
    } finally {
      setLoading(false);
    }
  };

  // List whenever the path resolves to a real directory. We list the parent
  // of the current path so the user sees siblings + can descend. If the path
  // ends with "/", we list its contents directly.
  useEffect(() => {
    const dir = path.endsWith("/") ? path : parentPath(path);
    void listDir(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const descend = (full: string) => {
    const next = full.endsWith("/") ? full : full + "/";
    setPath(next);
  };

  const goUp = () => {
    const up = parentPath(path);
    setPath(up);
  };

  // Resolve "home": ask the server to list the home directory (empty input
  // means home) and point the field at the returned absolute path. This is
  // how the Home button and an empty-field Go work without any tilde in the
  // UI or across the wire.
  const goHome = () => {
    setSuggestion(null);
    void (async () => {
      try {
        const res = await window.api.fsListDirs("");
        setPath((res.dir || "") + "/");
      } catch {
        // home probe failed — leave the field as-is
      }
    })();
  };

  // The design's "Go" discovery trigger (§07): browse into whatever path is
  // in the field, treating it as a directory to descend into. Mirrors the
  // row-click/descend affordance for a typed (or ghost-completed) path.
  const goNavigate = () => {
    const target = (path || "").trim();
    if (!target) {
      goHome();
      return;
    }
    const next = target.endsWith("/") ? target : target + "/";
    setSuggestion(null);
    setPath(next);
  };

  const select = async () => {
    const chosen = path.endsWith("/") ? path.slice(0, -1) : path;
    // Probe worktrees before committing — the fan-out question is asked
    // HERE, not after Create.
    try {
      const wts = await window.api.gitListWorktrees(chosen);
      if (hasWorktreeFanOut(wts)) {
        setFanOut({ worktrees: wts, cwd: chosen });
        return;
      }
    } catch {
      // not a repo / probe failed — proceed to single-folder select
    }
    onSelect(chosen);
  };

  const crumbs = breadcrumbs(path);

  return (
    <Modal open={open} size="lg" padded={false} tall onDismiss={fanOutBusy ? undefined : onCancel} label="Select folder">
      <div className="manta-folder-picker flex flex-col flex-1 min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="text-body font-semibold text-text">Select folder</div>
          <button
            onClick={onCancel}
            className="text-text-muted hover:text-text leading-none inline-flex items-center"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {fanOut ? (
          // ---- Worktree fan-out question (asked HERE, before commit) ----
          <div className="p-4 space-y-3">
            <div className="text-meta text-text-muted">
              Detected {fanOut.worktrees.length} git worktrees in
              {" "}<code className="font-mono text-text">{fanOut.cwd}</code>.
              Open a session for each?
            </div>
            <ul className="text-label text-text-faint space-y-px max-h-40 overflow-y-auto">
              {fanOut.worktrees.map((w) => (
                <li key={w.path} className="truncate">
                  <span className="text-text-muted">{w.path.split("/").filter(Boolean).pop() || w.branch}</span>
                  {" "}<span className="text-text-faint">— {w.path}</span>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button tone="default" onClick={() => onSelect(fanOut.cwd)} disabled={fanOutBusy}>
                Just this folder
              </Button>
              {onFanOut && (
                <Button
                  tone="primary"
                  onClick={() => onFanOut(fanOut.cwd, fanOut.worktrees)}
                  disabled={fanOutBusy}
                >
                  {fanOutBusy ? "Creating…" : "One per worktree"}
                </Button>
              )}
              <Button tone="ghost" onClick={() => setFanOut(null)} disabled={fanOutBusy}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Path field with ghost-text completion + the design's Go button */}
            <div className="px-4 py-3 border-b border-border">
              <div className="flex gap-2">
                <div className="relative flex-1 min-w-0 bg-bg-soft border border-border rounded-xs focus-within:border-accent">
                  {suggestion && suggestion.startsWith(path) && (
                    <div
                      aria-hidden
                      className="absolute inset-0 px-3 py-2 text-meta flex items-center pointer-events-none whitespace-pre overflow-hidden font-mono"
                    >
                      <span className="invisible">{path}</span>
                      <span className="text-text-faint">
                        {suggestion.slice(path.length)}
                      </span>
                    </div>
                  )}
                  <input
                    autoFocus
                    value={path}
                    onChange={(e) => onPathChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Tab" && suggestion) {
                        e.preventDefault();
                        acceptSuggestion();
                        return;
                      }
                      if (e.key === "ArrowRight" && suggestion) {
                        const el = e.currentTarget;
                        if (
                          el.selectionStart === el.value.length &&
                          el.selectionEnd === el.value.length
                        ) {
                          e.preventDefault();
                          acceptSuggestion();
                          return;
                        }
                      }
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void select();
                        return;
                      }
                      // Escape is otherwise handled by Modal (BET-724): it
                      // dismisses regardless of which inner element has
                      // focus. But with a live inline suggestion, the FIRST
                      // Escape should just dismiss the ghost-text completion
                      // — restored per review (BET-724 cycle 1 Question) —
                      // so stop it here and only let a second, suggestion-
                      // free Escape bubble up to Modal and close the dialog.
                      if (e.key === "Escape" && suggestion) {
                        e.stopPropagation();
                        setSuggestion(null);
                      }
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    className="relative w-full bg-transparent border-0 px-3 py-2 text-meta rounded-xs focus:outline-none font-mono"
                  />
                </div>
                <div className="shrink-0">
                  <Button tone="default" onClick={goNavigate}>
                    Go
                  </Button>
                </div>
              </div>

              {/* Breadcrumbs — home icon + inter-crumb chevrons, current crumb
                  at full weight (aligns to §07). */}
              <div className="flex items-center flex-wrap gap-px mt-2 text-label">
                <button
                  onClick={goHome}
                  className="inline-flex items-center px-1 py-px rounded-xs text-text-faint hover:text-text"
                  title="Home"
                  aria-label="Home"
                >
                  <Home size={12} aria-hidden="true" />
                </button>
                {crumbs.map((c, i) => (
                  <span key={c} className="inline-flex items-center">
                    <ChevronRight
                      size={12}
                      className="text-text-quiet"
                      aria-hidden="true"
                    />
                    <button
                      onClick={() => setPath(c)}
                      className={
                        "px-1 py-px rounded-xs " +
                        (i === crumbs.length - 1
                          ? "font-semibold text-text"
                          : "text-text-faint hover:text-text-muted")
                      }
                      title={c}
                    >
                      {crumbLabel(c)}
                    </button>
                  </span>
                ))}
              </div>
            </div>

            {/* Folder list */}
            <div className="flex-1 overflow-y-auto px-2 py-1">
              {loading && (
                <div className="px-3 py-4 text-meta text-text-faint">Loading…</div>
              )}
              {error && (
                <div className="px-3 py-4 text-meta text-danger">{error}</div>
              )}
              {!loading && !error && rows.length === 0 && (
                <div className="px-3 py-4 text-meta text-text-faint">No subfolders</div>
              )}
              {!loading && !error && (
                <>
                  {/* `..` row — spec §B3 says ".. first". Goes up one level,
                      same as the breadcrumbs / up-arrow. */}
                  <button
                    onClick={goUp}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-meta rounded-xs text-text-muted hover:bg-bg-soft"
                    title={parentPath(path)}
                  >
                    <ArrowUp size={14} className="shrink-0" aria-hidden="true" />
                    <span className="flex-1 min-w-0 truncate font-mono">..</span>
                  </button>
                  {rows.map((r) => {
                    const wtCount = worktreeCounts[r.full];
                    const badge = worktreeBadge(wtCount ?? null);
                    return (
                      <button
                        key={r.full}
                        onClick={() => descend(r.full)}
                        className={
                          "w-full flex items-center gap-2 px-3 py-2 text-left text-meta rounded-xs text-text-muted " +
                          "hover:bg-bg-soft"
                        }
                        title={r.full}
                      >
                        <FolderIcon size={14} className="shrink-0" aria-hidden="true" />
                        <span className="flex-1 min-w-0 truncate font-mono">{r.name}</span>
                        {badge && (
                          <span className="text-label text-accent-tx shrink-0">{badge}</span>
                        )}
                      </button>
                    );
                  })}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <div className="text-label text-text-faint font-mono truncate">
                {gitState || "not a git repo"}
              </div>
              <div className="flex gap-2 shrink-0">
                <Button onClick={onCancel} tone="ghost">
                  Cancel
                </Button>
                <Button onClick={() => void select()} tone="primary">
                  Select folder
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
