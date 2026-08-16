// CloneFromGitHub.tsx — the fresh-box clone flow (BET-796 §7.4 case C).
//
// The one screen set where GitHub leads, because on an empty VPS it is
// genuinely the fastest path. Wires [S5] (device code) → [S6] (remote repo
// picker) → [S7] (clone with progress) with the [E2]/[E3] error states, all
// per the design doc (§8.2/§8.3).
//
// Design invariants enforced here:
//   - The DEVICE flow reuses the same two-step (open link / enter code) shape
//     as ConnectProvider's `waiting` phase — one device-flow screen, not two.
//   - `device_code` never appears anywhere; only `user_code`.
//   - The code is copied to the clipboard AUTOMATICALLY (gh auth login
//     --clipboard) and the UI says so inside the code box.
//   - [S6] opens with NOTHING pre-checked — the one action with real cost
//     (network + disk) never defaults to on.
//   - [S7] is the one DETERMINATE bar in the whole design, driven by git's
//     real byte counts (parsed server-side into percent/bytes).
//   - [E2]'s "Skip for now" is mandatory — GitHub is never required.
//   - [E3] names which of the three causes occurred (permission/disk/network).
//
// On success the cloned paths are handed back to NewSessionScreen, which reuses
// the zero-state batch workspace creation verbatim — this component only
// produces directories on disk.

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { Checkbox } from "./Checkbox";
import { Field } from "./Field";
import { ListRow } from "./ListRow";
import { ProgressBar } from "./ProgressBar";
import { ScrollFrame } from "./ScrollFrame";
import { MantaLoader } from "./MantaLoader";
import { ConnectGithubPanel, PanelHeader, PANEL_CLASS } from "./ConnectGithub";
import {
  formatAge,
  formatBytes,
  cloneErrorKind,
  repoListErrorMessage,
  type CloneErrorKind,
} from "./chatUtils";
import type {
  ForgeCloneStatus,
  ForgeRepo,
} from "../shared/types";

type Phase =
  | { kind: "pick" }
  | { kind: "clone"; queue: ForgeRepo[]; index: number }
  | { kind: "failed"; repo: ForgeRepo; message: string; errorKind: CloneErrorKind };

// One state for the repo fetch, so "in flight", "failed" and "loaded" can
// never disagree. The previous three-flag version (repos + reposError, with
// the fetch keyed on neither) is what left the picker stuck showing
// `not_connected` after a successful sign-in.
type ReposState =
  | { kind: "loading" }
  | { kind: "ready"; repos: ForgeRepo[] }
  | { kind: "error"; message: string };

// Module-scope constant so the `owners` / `filtered` memos see a stable
// identity while loading.
const NO_REPOS: ForgeRepo[] = [];

export function CloneFromGitHub({
  defaultRoot,
  onCancel,
  onCloned,
}: {
  defaultRoot: string;
  onCancel: () => void;
  onCloned: (paths: string[]) => void;
}): JSX.Element {
  // The whole device-connect flow lives in ConnectGithubPanel; this flag just
  // gates whether the connect screen (pre-credential) or the picker shows.
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  // ---- [S6] picker state ----
  const [reposState, setReposState] = useState<ReposState>({ kind: "loading" });
  const repos = reposState.kind === "ready" ? reposState.repos : NO_REPOS;
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState<string>("");
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [root, setRoot] = useState(defaultRoot);
  const [editingRoot, setEditingRoot] = useState(false);
  // ---- [S7] clone state ----
  const [clone, setClone] = useState<ForgeCloneStatus | null>(null);
  const clonedPathsRef = useRef<string[]>([]);

  // The listed owners (from the fetched repos) for the [S6] filter dropdown.
  const owners = useMemo(
    () => Array.from(new Set(repos.map((r) => r.owner).filter(Boolean))).sort(),
    [repos],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return repos.filter(
      (r) =>
        (!owner || r.owner === owner) &&
        (!q || r.fullName.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)),
    );
  }, [repos, owner, search]);

  // ---- [S6]: fetch the repos once a credential exists ----
  // Keyed on `connected` ONLY. The old version keyed on `phase.kind`, so it
  // fired on mount — before sign-in — and cached the resulting `not_connected`
  // as a permanent error that no later sign-in could clear.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setReposState({ kind: "loading" });
    (async () => {
      try {
        const res = await window.api.forgeRepos();
        if (cancelled) return;
        // `res.repos` is always an array; `res.error` is the only failure
        // signal. Testing the array's truthiness was the original bug.
        if (res.error) setReposState({ kind: "error", message: repoListErrorMessage(res.error) });
        else setReposState({ kind: "ready", repos: res.repos });
      } catch {
        if (cancelled) return;
        setReposState({ kind: "error", message: repoListErrorMessage(null) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected]);

  const toggleRepo = (fullName: string, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(fullName);
      else next.delete(fullName);
      return next;
    });
  };

  const selected = repos.filter((r) => checked.has(r.fullName));

  // Derive the on-disk destination for a repo: <root>/<name>.
  const destFor = (repo: ForgeRepo) =>
    `${root.replace(/\/+$/, "")}/${repo.name}`;

  // ---- [S7]: run the clones for the selected repos (sequentially) ----
  const runClones = (queue: ForgeRepo[], startIndex: number) => {
    setPhase({ kind: "clone", queue, index: startIndex });
    clonedPathsRef.current = [];
  };

  useEffect(() => {
    if (phase.kind !== "clone") return;
    const queue = phase.queue;
    if (phase.index >= queue.length) {
      // All clones finished — hand off to the batch workspace creation.
      onCloned(clonedPathsRef.current);
      return;
    }
    const repo = queue[phase.index];
    let cancelled = false;
    const dest = destFor(repo);
    const controller: { id?: string } = {};
    let stop = false;

    (async () => {
      let res;
      try {
        res = await window.api.forgeCloneStart({ url: repo.cloneUrl, dest, name: repo.name });
      } catch {
        if (!cancelled) {
          setPhase({ kind: "failed", repo, message: "Couldn't reach the box.", errorKind: "unknown" });
        }
        return;
      }
      if (cancelled || !res || !res.id) {
        if (!cancelled) setPhase({ kind: "failed", repo, message: "Couldn't start the clone.", errorKind: "unknown" });
        return;
      }
      controller.id = res.id;
      // Poll the clone job for progress until done. Explicitly bounded: the
      // underlying spawn times out at 120s, but this loop caps at 130s so a
      // hung job can never poll forever even if the server stops reporting.
      const deadline = Date.now() + 130_000;
      while (!cancelled && !stop) {
        if (Date.now() > deadline) {
          setPhase({ kind: "failed", repo, message: "The clone timed out.", errorKind: "network" });
          return;
        }
        const st = await window.api.forgeCloneStatus({ id: res.id }).catch(() => null);
        if (cancelled) return;
        if (!st) {
          // Job unknown/expired — bail.
          if (!cancelled) setPhase({ kind: "failed", repo, message: "The clone job went away.", errorKind: "unknown" });
          return;
        }
        setClone(st);
        if (st.done) {
          if (st.ok) {
            clonedPathsRef.current.push(dest);
            const nextIndex = phase.index + 1;
            if (nextIndex >= queue.length) {
              // Last repo in the queue finished — hand off to the batch
              // workspace creation NOW, synchronously. Advancing the index
              // past the end would render `destFor(queue[index])` with an
              // out-of-range index and throw on `undefined.name` before the
              // effect's completion guard could run (BET-945).
              onCloned(clonedPathsRef.current);
            } else {
              setPhase({ kind: "clone", queue, index: nextIndex });
            }
          } else {
            setPhase({ kind: "failed", repo, message: st.error || "Clone failed", errorKind: cloneErrorKind(st.error || "") });
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    })();

    return () => {
      cancelled = true;
      stop = true;
      if (controller.id) void window.api.forgeCloneCancel({ id: controller.id });
    };
  }, [phase.kind, phase.kind === "clone" ? phase.index : null]);
  // destFor depends on `root` — capture latest via ref so the effect doesn't
  // restart on every keystroke while cloning.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  void 0;

  const cancelClone = () => onCancel();

  const retryClone = () => {
    if (phase.kind !== "failed") return;
    // A connection-level failure now surfaces inside ConnectGithubPanel, so
    // this is strictly the repo-retry path.
    runClones(
      [
        ...repos.filter((r) => checked.has(r.fullName) && r.fullName !== phase.repo?.fullName),
        phase.repo,
      ],
      0,
    );
  };

  const copyDiagnostics = () => {
    if (phase.kind === "failed") {
      void window.api.clipboardWriteText(phase.message).then(() => {}, () => {});
    }
  };

  // ===== Rendering =====
  return (
    <div className={PANEL_CLASS}>
      {!connected ? (
        <ConnectGithubPanel onConnected={() => setConnected(true)} onCancel={onCancel} />
      ) : (
        <>
      {phase.kind === "pick" && (
        <>
          <PanelHeader
            title="Clone a repository"
            trailing={
              <div className="relative inline-flex items-center">
                <select
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  aria-label="Filter by owner"
                  className="appearance-none text-[11px] border border-border rounded-full pl-3 pr-6 py-1 bg-bg-soft text-text-muted hover:text-text outline-none cursor-pointer"
                >
                  <option value="">All owners</option>
                  {owners.map((o) => (
                    <option key={o} value={o}>
                      @{o}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={12}
                  className="pointer-events-none absolute right-2 text-text-faint"
                  aria-hidden="true"
                />
              </div>
            }
          />
          <ScrollFrame
            className="p-4"
            header={
              <>
                <Field
                  ariaLabel="Search repositories"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={
                    reposState.kind === "ready"
                      ? `Search ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}…`
                      : "Search repositories…"
                  }
                />
                {reposState.kind === "error" && (
                  <div className="mt-2">
                    <Callout tone="danger">{reposState.message}</Callout>
                  </div>
                )}
              </>
            }
            footer={
              <>
                <div className="mt-3 text-[12px] text-text-faint">
                  Clone into{" "}
                  {editingRoot ? (
                    <input
                      autoFocus
                      value={root}
                      onChange={(e) => setRoot(e.target.value)}
                      onBlur={() => setEditingRoot(false)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setEditingRoot(false);
                      }}
                      className="font-mono text-[11.5px] text-text bg-inset border border-border rounded-xs px-1 py-px outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditingRoot(true)}
                      className="font-mono text-[11.5px] text-text-muted hover:text-text cursor-text"
                      title="Change clone root"
                    >
                      {root}
                    </button>
                  )}{" "}
                  {!editingRoot && (
                    <button
                      type="button"
                      onClick={() => setEditingRoot(true)}
                      className="text-[11.5px] text-text-faint underline decoration-dotted hover:text-text-muted"
                    >
                      change
                    </button>
                  )}
                </div>

                <div className="flex gap-2 mt-3">
                  <Button tone="primary" disabled={selected.length === 0} onClick={() => runClones(selected, 0)}>
                    Clone {selected.length} selected
                  </Button>
                  <Button tone="ghost" onClick={onCancel}>
                    Back
                  </Button>
                </div>
              </>
            }
            bodyClassName="mt-1"
          >
            {reposState.kind === "loading" && (
              <div className="flex items-center gap-2 py-3 text-[13px] text-text-faint">
                <MantaLoader />
                <span>Loading repositories…</span>
              </div>
            )}
            {reposState.kind === "ready" &&
              filtered.map((r) => (
                <ListRow
                  key={r.fullName}
                  leading={
                    <Checkbox
                      checked={checked.has(r.fullName)}
                      onChange={(on) => toggleRepo(r.fullName, on)}
                      ariaLabel={`Clone ${r.name}`}
                    />
                  }
                  name={r.name}
                  secondary={r.description || "—"}
                  trailing={r.pushedAt != null ? formatAge(Date.now() - r.pushedAt) : "—"}
                />
              ))}
            {reposState.kind === "ready" && filtered.length === 0 && (
              <div className="text-[13px] text-text-faint py-2">No repositories match.</div>
            )}
          </ScrollFrame>
        </>
      )}

      {phase.kind === "clone" && (
        <div className="p-4">
          <div className="flex items-center gap-2 text-[13.5px] font-medium text-text">
            <span className="w-[9px] h-[9px] rounded-full bg-accent" aria-hidden="true" />
            Cloning {phase.queue[phase.index]?.name}
            {clone && (
              <span className="font-mono text-[11.5px] tabular-nums text-text-quiet font-normal">
                · {clone.percent}% · {formatBytes(clone.bytes)}
              </span>
            )}
          </div>
          <div className="mt-3">
            <ProgressBar percent={clone?.percent ?? 0} />
          </div>
          <div className="mt-3 text-[12.5px] text-text-faint">
            into {destFor(phase.queue[phase.index])}
          </div>
          <div className="flex gap-2 mt-3">
            <Button tone="ghost" onClick={cancelClone}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {phase.kind === "failed" && (
        <>
          <PanelHeader title="Clone failed" />
          <div className="p-4">
            <Callout tone="danger">
              <b className="text-text">{phase.repo.name}</b> —{" "}
              {failedMessage(phase.errorKind, phase.message)}
            </Callout>
            <div className="flex gap-2 mt-3 items-center">
              <Button tone="primary" onClick={retryClone}>
                Try again
              </Button>
              <Button tone="ghost" onClick={() => setPhase({ kind: "pick" })}>
                Pick another repo
              </Button>
              <Button tone="default" onClick={copyDiagnostics}>
                Copy diagnostics
              </Button>
            </div>
          </div>
        </>
      )}
        </>
      )}
    </div>
  );
}

// [E3] names the cause — only permission is actionable by the user, so it must
// be called out specifically.
function failedMessage(kind: CloneErrorKind, raw: string): string {
  switch (kind) {
    case "permission":
      return "permission denied. The token may not have access to this repository.";
    case "disk":
      return "not enough disk space in the clone location.";
    case "network":
      return "a network error prevented the clone.";
    default:
      return raw || "the clone failed.";
  }
}
