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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { Checkbox } from "./Checkbox";
import { Field } from "./Field";
import { ListRow } from "./ListRow";
import { ProgressBar } from "./ProgressBar";
import { DeviceCodeSteps } from "./DeviceFlow";
import { formatAge, formatBytes, cloneErrorKind, type CloneErrorKind } from "./chatUtils";
import type {
  ForgeCloneStatus,
  ForgeDeviceGrant,
  ForgeRepo,
} from "../shared/types";

type Phase =
  | { kind: "connect" }
  | { kind: "notConfigured" }
  | { kind: "pick" }
  | { kind: "clone"; queue: ForgeRepo[]; index: number }
  | { kind: "expired" }
  | { kind: "failed"; repo: ForgeRepo | null; message: string; errorKind: CloneErrorKind };

// mm:ss countdown label — mono so it doesn't jitter.
function countdownLabel(remainingMs: number): string {
  const s = Math.max(0, Math.floor(remainingMs / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// The panel title row (.mhead where it is REAL — [S5] [S6] [E2] [E3]).
function PanelHeader({
  title,
  trailing,
}: {
  title: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle text-[13px] font-medium text-text">
      {title}
      {trailing != null && <span className="ml-auto">{trailing}</span>}
    </div>
  );
}

const PANEL_CLASS =
  "w-full max-w-[420px] rounded-lg border border-border bg-bg-elev overflow-hidden";

export function CloneFromGitHub({
  defaultRoot,
  onCancel,
  onCloned,
}: {
  defaultRoot: string;
  onCancel: () => void;
  onCloned: (paths: string[]) => void;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: "connect" });
  // ---- [S5] device grant state ----
  const [grant, setGrant] = useState<ForgeDeviceGrant | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [copiedNote, setCopiedNote] = useState(false);
  const grantRef = useRef<ForgeDeviceGrant | null>(null);
  // ---- [S6] picker state ----
  const [repos, setRepos] = useState<ForgeRepo[]>([]);
  const [reposError, setReposError] = useState<string | null>(null);
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

  // ---- [S5]: connect (device flow) ----
  // On mount, ask the box to start a device grant. A box that already has a
  // credential (CLI/secret) skips straight to the picker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await window.api.forgeDeviceStart();
        if (cancelled) return;
        if (res.notConfigured) {
          // The box's device-grant id is a placeholder (BET-849) — surface a
          // clear "not configured" state, never a guaranteed-dead-end screen.
          setPhase({ kind: "notConfigured" });
          return;
        }
        if (res.connected) {
          setPhase({ kind: "pick" });
          return;
        }
        const g = res.grant!;
        grantRef.current = g;
        setGrant(g);
        setRemainingMs(g.expiresIn * 1000);
        setCopiedNote(false);
        // Rule 5: copy the code automatically — the user pastes, not retypes.
        window.api
          .clipboardWriteText(g.userCode)
          .then(() => setCopiedNote(true), () => {});
      } catch {
        if (cancelled) return;
        setPhase({ kind: "failed", repo: null, message: "Couldn't reach the box. Try again.", errorKind: "unknown" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase.kind === "connect" ? phase.kind : null]);

  // Device poll + countdown while connecting.
  useEffect(() => {
    if (phase.kind !== "connect" || !grant) return;
    const startedAt = Date.now();
    const deadline = startedAt + grant.expiresIn * 1000;
    let intervalMs = Math.max(grant.pollInterval, 5) * 1000;
    const ticker = window.setInterval(() => {
      setRemainingMs(deadline - Date.now());
    }, 1000);
    const poll = async () => {
      try {
        const res = await window.api.forgeDevicePoll({ grantId: grant.grantId });
        if (res.status === "done") {
          window.clearInterval(ticker);
          setPhase({ kind: "pick" });
          return;
        }
        if (res.status === "expired") {
          window.clearInterval(ticker);
          setPhase({ kind: "expired" });
          return;
        }
        if (res.status === "pending") {
          // slow_down may have lengthened the interval — respect the new value.
          if (res.pollInterval) intervalMs = res.pollInterval * 1000;
        }
      } catch {
        // transient — keep polling
      }
    };
    const handle = window.setInterval(poll, intervalMs);
    // Poll immediately once (the pending → done transition can resolve fast).
    void poll();
    return () => {
      window.clearInterval(ticker);
      window.clearInterval(handle);
    };
    // Narrowed to the discriminant so cosmetic state changes don't reset timers.
  }, [phase.kind, phase.kind === "connect" ? grant?.grantId : null]);

  const cancelConnect = useCallback(() => {
    if (grantRef.current) {
      void window.api.forgeDeviceCancel({ grantId: grantRef.current.grantId });
    }
    onCancel(); // back to [S4] with nothing changed
  }, [onCancel]);

  // ---- [S6]: fetch the repos once we reach the picker ----
  useEffect(() => {
    if (phase.kind !== "pick" || repos.length > 0 || reposError) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await window.api.forgeRepos();
        if (cancelled) return;
        if (res.repos) {
          setRepos(res.repos);
          setReposError(res.error ?? null);
        } else {
          setReposError(res.error ?? "Couldn't list repositories");
        }
      } catch {
        if (cancelled) return;
        setReposError("Couldn't list repositories from GitHub");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  const toggleRepo = (fullName: string, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(fullName);
      else next.delete(fullName);
      return next;
    });
  };

  const selected = filtered.filter((r) => checked.has(r.fullName));

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
            setPhase({ kind: "clone", queue, index: phase.index + 1 });
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
    // A connection-level failure (no repo) restarts the device flow.
    if (!phase.repo) {
      grantRef.current = null;
      setGrant(null);
      setPhase({ kind: "connect" });
      return;
    }
    runClones(
      [
        ...filtered.filter((r) => checked.has(r.fullName) && r.fullName !== phase.repo?.fullName),
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
      {phase.kind === "connect" && !grant && (
        <div className="p-4 text-[13px] text-text-muted">Preparing sign-in…</div>
      )}

      {phase.kind === "connect" && grant && (
        <>
          <PanelHeader
            title="Connect GitHub · Waiting for sign-in"
            trailing={
              <span className="font-mono tabular-nums text-[11px] text-text-faint">
                {countdownLabel(remainingMs)} remaining
              </span>
            }
          />
          <div className="p-4">
            <DeviceCodeSteps
              url={grant.verificationUri}
              displayUrl={grant.verificationUri.replace(/^https?:\/\//, "")}
              code={grant.userCode}
              autoCopied={copiedNote}
            />
            <div className="flex gap-2 mt-3">
              <Button tone="ghost" onClick={cancelConnect}>
                Cancel
              </Button>
            </div>
          </div>
        </>
      )}

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
          <div className="p-4">
            <Field
              ariaLabel="Search repositories"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}…`}
            />
            {reposError && (
              <div className="mt-2">
                <Callout tone="danger">{reposError}</Callout>
              </div>
            )}
            <div className="mt-1">
              {filtered.map((r) => (
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
              {filtered.length === 0 && !reposError && (
                <div className="text-[13px] text-text-faint py-2">No repositories match.</div>
              )}
            </div>

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
          </div>
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

      {phase.kind === "notConfigured" && (
        <>
          <PanelHeader title="Connect GitHub" />
          <div className="p-4">
            <Callout tone="warn">
              GitHub sign-in isn't configured on this box yet.
            </Callout>
            <div className="flex gap-2 mt-3">
              <Button tone="ghost" onClick={onCancel}>
                Back
              </Button>
            </div>
          </div>
        </>
      )}

      {phase.kind === "expired" && (
        <>
          <PanelHeader title="Connect GitHub · Failed" />
          <div className="p-4">
            <Callout tone="danger">
              The sign-in code expired before it was entered.
            </Callout>
            <div className="flex gap-2 mt-3">
              <Button
                tone="primary"
                onClick={() => {
                  grantRef.current = null;
                  setGrant(null);
                  setPhase({ kind: "connect" });
                }}
              >
                Try again
              </Button>
              <Button tone="ghost" onClick={onCancel}>
                Skip for now
              </Button>
            </div>
          </div>
        </>
      )}

      {phase.kind === "failed" && (
        <>
          <PanelHeader title="Clone failed" />
          <div className="p-4">
            <Callout tone="danger">
              {phase.repo ? (
                <>
                  <b className="text-text">{phase.repo.name}</b> —{" "}
                  {failedMessage(phase.errorKind, phase.message)}
                </>
              ) : (
                phase.message
              )}
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
