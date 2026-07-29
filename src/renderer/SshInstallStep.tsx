// SshInstallStep.tsx — SSH installer harness for the desktop onboarding
// "Connect your box" step (BET-355 / BET-382 / BET-383 / BET-384).
//
// PairStep renders this component inline as the primary surface when an
// SSH installer preload is available and no deep-link is pending. The
// step-level heading + intro live in PairStep — this component renders no
// header of its own (BET-382), it just drops straight into the host
// picker. On success it calls onPaired(), the same callback the manual
// form uses, so the onboarding shell advances identically regardless of
// which path closed the deal.
//
// BET-383: exactly one entry point — Install & pair. Preflight runs as
// phase 1 in the main process; no standalone button, no verdict that can go
// stale, and a failed check aborts before anything is written to the box.
// The six-row checklist is gone in favour of one status line over an
// always-mounted, auto-scrolling log that collapses on success.
//
// BET-384: the host list can be re-read without an app restart (the
// `loadHosts()` callback backs both the mount effect and the refresh
// button), and "Custom host…" is a permanent last entry in the SAME
// `<select>` — there is exactly one host control, never a select-or-input
// branch. Selecting it reveals a small panel (host/port/user/identity
// file); `resolveInstallTarget` (src/shared/sshTarget.ts) turns whichever
// branch is active into the single value installerStart /
// installerMintAndClaim consume — this component assembles no target
// string of its own.
//
// All decision logic lives in the main-process installer module (plus the
// pure src/shared/sshTarget.ts target resolver). This component is React
// state + per-event dispatch + JSX, nothing more.

import { useCallback, useEffect, useState, useRef } from "react";
import {
  getMantaPreload,
  type InstallerEvent,
  type PreflightFailure,
} from "./preloadAccess";
import { currentStageInfo, type InstallStageId } from "../shared/installStages";
import {
  CUSTOM_HOST_VALUE,
  resolveInstallTarget,
  sshTargetLabel,
  type HostFieldSelection,
} from "../shared/sshTarget";

const ACCENT = "#5A88FF";
const DANGER = "#FF7A88";
const OK_GREEN = "#22C55E";

// Keep the last N log lines only — main already caps its own tail at 200
// (handlers.ts LOG_TAIL_MAX); the renderer needs its own cap too, or a long
// install grows the DOM without bound.
const LOG_LINES_MAX = 500;

const INITIAL_STAGE: InstallStageId = "preflight";
const INITIAL_STAGE_INFO = currentStageInfo(INITIAL_STAGE);

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function SshInstallStep({ onPaired }: { onPaired: () => void }) {
  // The preload bridge — null on mobile/web (the issue's "SSH is installer-
  // only" rule means this UI never renders without a preload). Render an
  // explicit fallback instead of silently failing — mirrors how PairStep
  // handles a missing window.api.
  const preloadOrNull = getMantaPreload();
  if (!preloadOrNull) {
    return (
      <div className="text-center py-6 text-sm text-text-muted">
        The SSH installer is only available in the desktop app.
      </div>
    );
  }
  // Non-null alias — TypeScript can't narrow the return of getMantaPreload()
  // because it's not declared as a type predicate, so we capture it once
  // and use the non-null name throughout the body.
  const preload = preloadOrNull;

  // ---------- State ----------
  const [hosts, setHosts] = useState<Array<{ alias: string; patterns: string[] }>>(
    [],
  );
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [hostsLoading, setHostsLoading] = useState(false);
  // Set once a manual refresh has completed at least once — flips the count
  // line's suffix from nothing to "· just now" (BET-384). Never reset back:
  // the whole point is "this is fresher than the initial mount load".
  const [justRefreshed, setJustRefreshed] = useState(false);
  // The <select> value: a real alias, or CUSTOM_HOST_VALUE. Starts on the
  // sentinel so the select always has a valid selected option (one of the
  // custom option, which is always rendered) even before the first
  // installerListHosts() response lands — no empty-string flash.
  const [alias, setAlias] = useState(CUSTOM_HOST_VALUE);
  // Custom-host panel fields (BET-384) — only read when alias ===
  // CUSTOM_HOST_VALUE. Never persisted, never written to ~/.ssh/config.
  const [customHost, setCustomHost] = useState("");
  const [customPort, setCustomPort] = useState("");
  const [customUser, setCustomUser] = useState("");
  const [customIdentityFile, setCustomIdentityFile] = useState("");
  const [targetError, setTargetError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const [stage, setStage] = useState<InstallStageId>(INITIAL_STAGE);
  const [stageLabel, setStageLabel] = useState(INITIAL_STAGE_INFO.label);
  const [stageIndex, setStageIndex] = useState(INITIAL_STAGE_INFO.index);
  const [stageTotal, setStageTotal] = useState(INITIAL_STAGE_INFO.total);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [logOpen, setLogOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState<
    | { ok: boolean; code: number | null; signal: NodeJS.Signals | null }
    | null
  >(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // From a `preflight-failed` event — checks failed before any write.
  // Rendered as its own card, never folded into the progress panel.
  const [preflightFailure, setPreflightFailure] = useState<{
    failures: PreflightFailure[];
  } | null>(null);
  const [claimRunning, setClaimRunning] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // ---------- Host list load (mount + manual refresh share this) ----------
  //
  // BET-384: editing ~/.ssh/config used to require restarting the whole app
  // because the list was read once in a mount effect with no way back in.
  // `loadHosts()` is the single fetch both the mount effect and the
  // refresh button call — re-reads the config and nothing else (no
  // preflight, no re-check; there is nothing left to re-run since BET-383
  // folded preflight into the install click).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadHosts = useCallback(
    async (opts?: { manual?: boolean }) => {
      setHostsLoading(true);
      try {
        const list = await preload.installerListHosts();
        if (!aliveRef.current) return;
        setHosts(list);
        // Keep the current selection if it's still valid (still present in
        // the refreshed list, or the custom sentinel — refresh never closes
        // an open custom panel). Otherwise fall back to the first alias, or
        // the custom sentinel when the config yields nothing at all —
        // decision #3: the dropdown still renders, Custom host… pre-selected,
        // panel already open. One code path, not an either/or branch.
        setAlias((prev) => {
          if (prev === CUSTOM_HOST_VALUE) return prev;
          if (list.some((h) => h.alias === prev)) return prev;
          return list.length > 0 ? list[0].alias : CUSTOM_HOST_VALUE;
        });
        if (opts?.manual) setJustRefreshed(true);
      } catch {
        if (!aliveRef.current) return;
        setHosts([]);
        setAlias(CUSTOM_HOST_VALUE);
      } finally {
        if (aliveRef.current) {
          setHostsLoaded(true);
          setHostsLoading(false);
        }
      }
    },
    [preload],
  );

  useEffect(() => {
    void loadHosts();
    // Mount-only — loadHosts is stable across the preload's lifetime (the
    // preload accessor never changes after mount) and the refresh button
    // calls it directly, so re-running this effect on every loadHosts
    // identity change would just be the same fetch twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recover any in-flight install on mount (a page refresh mid-install
  // shouldn't strand the user), or a preflight failure the user hasn't
  // dismissed yet — main echoes the real verdict, no placeholder needed.
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await preload.installerState();
      if (!alive) return;
      if (s.active) {
        const info = currentStageInfo(s.stage);
        setRunning(true);
        setStage(s.stage);
        setStageLabel(info.label);
        setStageIndex(info.index);
        setStageTotal(info.total);
        setLines(s.logTail);
        setLogOpen(true);
      } else if (s.preflight && !s.preflight.ok) {
        setPreflightFailure({ failures: s.preflight.failures });
      }
    })();
    return () => {
      alive = false;
    };
  }, [preload]);

  // Subscribe to installer events. Re-subscribes when the active handle
  // changes so stale events from a previous handle don't bleed into the UI.
  useEffect(() => {
    const unsub = preload.onInstallerEvent((evt: InstallerEvent) => {
      // Only react to events from the CURRENT handle — stale events from a
      // previous install (after the user clicked Cancel + tried again) must
      // not update the new install's UI.
      if (activeHandle !== null && evt.handleId !== activeHandle) return;
      switch (evt.kind) {
        case "line":
          setLines((prev) => {
            const next = [...prev, evt.text];
            return next.length > LOG_LINES_MAX
              ? next.slice(next.length - LOG_LINES_MAX)
              : next;
          });
          break;
        case "stage": {
          const info = currentStageInfo(evt.stage);
          setStage(evt.stage);
          setStageLabel(info.label);
          setStageIndex(info.index);
          setStageTotal(info.total);
          break;
        }
        case "preflight-failed":
          // Nothing was written to the box — the progress panel never
          // shows for this case.
          setPreflightFailure({ failures: evt.failures });
          setRunning(false);
          setActiveHandle(null);
          break;
        case "done":
          setDone({ ok: evt.ok, code: evt.code, signal: evt.signal });
          setRunning(false);
          setActiveHandle(null);
          if (evt.ok) {
            // Collapse the log back to the single status line on success.
            setLogOpen(false);
            // Auto-claim on success — the whole point of the flow. The
            // user typed a host, nothing else.
            void runClaim();
          }
          break;
        case "error":
          setInstallError(evt.message);
          setRunning(false);
          setActiveHandle(null);
          break;
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preload, activeHandle]);

  // Auto-scroll the log pane on new lines while it's open — matches what a
  // terminal user expects (Tail-style: stick to the bottom while streaming).
  useEffect(() => {
    if (logOpen && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines, logOpen]);

  // Tick the elapsed-time display once a second while running.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  // ---------- Actions ----------

  // Current host-picker selection in the shape resolveInstallTarget takes —
  // one function, called wherever the resolved target is needed (BET-384:
  // "the component contains no target-string assembly", only this
  // pass-through into the pure resolver).
  function currentSelection(): HostFieldSelection {
    return {
      alias,
      host: customHost,
      port: customPort,
      user: customUser,
      identityFile: customIdentityFile,
    };
  }

  async function startInstall() {
    const resolved = resolveInstallTarget(currentSelection());
    if (!resolved.ok) {
      setTargetError(resolved.error);
      return;
    }
    setTargetError(null);
    setInstallError(null);
    setPreflightFailure(null);
    setLines([]);
    setDone(null);
    setClaimError(null);
    // Clear the previous handle so the event guard doesn't discard this
    // install's events (esp. a `preflight-failed` push, which main sends
    // BEFORE the installerStart invoke below resolves) while it's still
    // filtering against a prior, now-dead handle.
    setActiveHandle(null);
    setStage(INITIAL_STAGE);
    setStageLabel(INITIAL_STAGE_INFO.label);
    setStageIndex(INITIAL_STAGE_INFO.index);
    setStageTotal(INITIAL_STAGE_INFO.total);
    setElapsedSeconds(0);
    setLogOpen(true);
    // Mount the progress panel immediately on click — no gap before the
    // main process's response comes back.
    setRunning(true);
    try {
      const { handleId } = await preload.installerStart({ alias: resolved.target });
      setActiveHandle(handleId);
    } catch (e) {
      setRunning(false);
      setInstallError(e instanceof Error ? e.message : String(e));
    }
  }

  async function cancelInstall() {
    if (!activeHandle) return;
    await preload.installerCancel({ handleId: activeHandle });
  }

  async function runClaim() {
    const resolved = resolveInstallTarget(currentSelection());
    if (!resolved.ok) {
      setClaimError(resolved.error);
      return;
    }
    setClaimRunning(true);
    setClaimError(null);
    try {
      const outcome = (await preload.installerMintAndClaim({
        alias: resolved.target,
      })) as { ok: boolean };
      if (outcome.ok) {
        // Mirror the manual PairStep onPaired — advances onboarding to
        // step 2 exactly as a typed pairing code would.
        onPaired();
      } else {
        setClaimError("Pairing failed — check the install log.");
      }
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaimRunning(false);
    }
  }

  async function copyDiagnostics() {
    // Read the real preflight verdict back from main — always populated by
    // the time this button can be visible. No placeholder.
    const s = await preload.installerState();
    if (!s.preflight) return;
    const resolved = resolveInstallTarget(currentSelection());
    const r = await preload.installerGetDiagnostics({
      preflight: s.preflight,
      stage,
      logTail: lines,
      alias: resolved.ok ? sshTargetLabel(resolved.target) : alias,
    });
    await navigator.clipboard.writeText(r);
  }

  // ---------- Render ----------
  const installDisabled =
    running || claimRunning || !resolveInstallTarget(currentSelection()).ok;
  const hostCountLabel = hostsLoading
    ? "reading ~/.ssh/config…"
    : !hostsLoaded
      ? ""
      : hosts.length === 0
        ? "No hosts in ~/.ssh/config"
        : `${hosts.length} hosts from ~/.ssh/config${justRefreshed ? " · just now" : ""}`;
  // Keep the panel (status line + log) mounted through an install error too
  // — that's the log line the user needs most ("is it stuck, or just
  // slow?"). Only the preflight-failure card excludes it (nothing was
  // written to the box, so there's no install log to show).
  const showProgress =
    !preflightFailure &&
    (running || done !== null || (installError !== null && lines.length > 0));

  return (
    <div className="space-y-5">
      {/* Host picker — PairStep owns the step-level heading + intro
          (BET-382); this component drops straight into the picker.
          BET-384: exactly one host control, always a <select> — "Custom
          host…" is a permanent last option, present whether or not the
          config has entries, never a second input rendered alongside it. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label className="text-sm font-medium" htmlFor="ssh-host">
            Host
          </label>
          <span className="text-xs text-text-faint">{hostCountLabel}</span>
        </div>
        <div className="flex gap-2">
          <select
            id="ssh-host"
            value={alias}
            onChange={(e) => {
              setAlias(e.target.value);
              setTargetError(null);
            }}
            disabled={running || claimRunning}
            className="flex-1 min-w-0 rounded-md bg-bg-elev px-3 py-2 text-sm border border-border focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {hosts.map((h) => (
              <option key={h.alias} value={h.alias}>
                {h.alias}
                {h.patterns.length > 1 ? ` (${h.patterns.join(", ")})` : ""}
              </option>
            ))}
            <option value={CUSTOM_HOST_VALUE}>Custom host…</option>
          </select>
          <button
            type="button"
            onClick={() => void loadHosts({ manual: true })}
            disabled={hostsLoading || running || claimRunning}
            aria-label="Refresh host list"
            title="Re-read ~/.ssh/config"
            className="w-[34px] h-[34px] shrink-0 flex items-center justify-center rounded-md bg-bg-elev border border-border text-text-muted hover:text-text hover:border-border-strong transition-colors disabled:opacity-50"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`w-3.5 h-3.5${hostsLoading ? " animate-spin" : ""}`}
              aria-hidden
            >
              <path d="M21 12a9 9 0 1 1-2.6-6.4" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        </div>

        {/* Custom host panel — only rendered for the custom sentinel. No
            second host control ever coexists with the select. */}
        {alias === CUSTOM_HOST_VALUE && (
          <div className="rounded-md border border-border bg-bg-soft p-3.5 space-y-2.5">
            <div className="grid grid-cols-[1fr_90px] gap-2.5">
              <div className="flex flex-col gap-1">
                <label
                  className="text-[11px] font-medium text-text-muted"
                  htmlFor="ssh-custom-host"
                >
                  Host or IP
                </label>
                <input
                  id="ssh-custom-host"
                  type="text"
                  placeholder="box.example.com"
                  value={customHost}
                  onChange={(e) => {
                    setCustomHost(e.target.value);
                    setTargetError(null);
                  }}
                  disabled={running || claimRunning}
                  className="w-full rounded-md bg-bg-elev px-3 py-2 text-sm border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  className="text-[11px] font-medium text-text-muted"
                  htmlFor="ssh-custom-port"
                >
                  Port
                </label>
                <input
                  id="ssh-custom-port"
                  type="text"
                  inputMode="numeric"
                  placeholder="22"
                  value={customPort}
                  onChange={(e) => {
                    setCustomPort(e.target.value);
                    setTargetError(null);
                  }}
                  disabled={running || claimRunning}
                  className="w-full rounded-md bg-bg-elev px-3 py-2 text-sm border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="flex flex-col gap-1">
                <label
                  className="text-[11px] font-medium text-text-muted"
                  htmlFor="ssh-custom-user"
                >
                  User
                </label>
                <input
                  id="ssh-custom-user"
                  type="text"
                  placeholder="root"
                  value={customUser}
                  onChange={(e) => {
                    setCustomUser(e.target.value);
                    setTargetError(null);
                  }}
                  disabled={running || claimRunning}
                  className="w-full rounded-md bg-bg-elev px-3 py-2 text-sm border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  className="text-[11px] font-medium text-text-muted"
                  htmlFor="ssh-custom-identity"
                >
                  Identity file
                </label>
                {/* No Browse button — MantaPreload exposes no native file
                    dialog bridge today. A plain text input is the whole
                    control until that IPC channel exists (follow-up
                    filed, BET-384 doesn't add it). */}
                <input
                  id="ssh-custom-identity"
                  type="text"
                  placeholder="~/.ssh/id_ed25519"
                  value={customIdentityFile}
                  onChange={(e) => {
                    setCustomIdentityFile(e.target.value);
                    setTargetError(null);
                  }}
                  disabled={running || claimRunning}
                  className="w-full rounded-md bg-bg-elev px-3 py-2 text-sm border border-border focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
            </div>
            <p className="text-xs text-text-faint">
              Leave a field empty to let OpenSSH decide. These are used for
              this box only — your ~/.ssh/config is never written to.
            </p>
            {targetError && (
              <p className="text-xs" style={{ color: DANGER }}>
                {targetError}
              </p>
            )}
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <button
            onClick={startInstall}
            disabled={installDisabled}
            className="px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
            style={{ background: ACCENT, color: "#0B1020" }}
          >
            {running ? "Installing…" : "Install & pair"}
          </button>
          {running && (
            <button
              onClick={cancelInstall}
              className="px-4 py-2 rounded-md text-sm font-medium"
              style={{ border: `1px solid ${DANGER}`, color: DANGER }}
            >
              Cancel
            </button>
          )}
        </div>
      </section>

      {/* Preflight failure — checks ran before any write; must not read as
          a failed install. Never shown alongside the progress panel. */}
      {preflightFailure && (
        <section className="space-y-2 text-sm">
          <ul className="space-y-1">
            {preflightFailure.failures.map((f, i) => (
              <li
                key={i}
                className="rounded-md px-3 py-2"
                style={{ border: `1px solid ${DANGER}`, color: DANGER }}
              >
                <div className="font-medium">{f.cause}</div>
                <div className="text-xs mt-0.5 opacity-80">{f.action}</div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted">
            Nothing was installed or changed on the box — the checks run
            before any write.
          </p>
        </section>
      )}

      {/* Status line + progress bar + live log — mounted on click, streams,
          auto-scrolls, collapses to the single line on success. */}
      {showProgress && (
        <section className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            {done ? (
              <span aria-hidden style={{ color: done.ok ? OK_GREEN : DANGER }}>
                {done.ok ? "✓" : "✕"}
              </span>
            ) : (
              <span
                aria-hidden
                className="inline-block w-3 h-3 rounded-full border-2 animate-spin"
                style={{ borderColor: ACCENT, borderTopColor: "transparent" }}
              />
            )}
            <span>{stageLabel}</span>
            <span className="text-text-muted">
              {stageIndex} of {stageTotal} · {formatElapsed(elapsedSeconds)}
            </span>
            <button
              onClick={() => setLogOpen((o) => !o)}
              className="ml-auto text-xs text-text-muted hover:text-text"
            >
              {logOpen ? "Hide log ▴" : "Show log ▾"}
            </button>
          </div>
          <div
            className="h-0.5 rounded-full overflow-hidden bg-bg-elev"
            aria-hidden
          >
            <div
              className="h-full"
              style={{
                width: `${(stageIndex / stageTotal) * 100}%`,
                background: done && !done.ok ? DANGER : ACCENT,
              }}
            />
          </div>
          {logOpen && (
            <div
              ref={logRef}
              style={{ height: 172, overflowY: "auto" }}
              className="rounded-md bg-bg-elev px-3 py-2 text-xs font-mono whitespace-pre-wrap"
            >
              {lines.join("\n")}
            </div>
          )}
        </section>
      )}

      {/* Done / error / claim */}
      {done && done.ok && (
        <section className="text-sm" style={{ color: OK_GREEN }}>
          Install finished successfully. {claimRunning ? "Pairing…" : "Paired."}
        </section>
      )}
      {done && !done.ok && (
        <section
          className="text-sm space-y-2"
          style={{ color: DANGER }}
        >
          <div>
            Install failed (exit code {done.code ?? "—"}
            {done.signal ? `, signal ${done.signal}` : ""}).
          </div>
          <button
            onClick={copyDiagnostics}
            className="px-3 py-1.5 rounded-md text-xs"
            style={{ border: `1px solid ${DANGER}`, color: DANGER }}
          >
            Copy diagnostics
          </button>
        </section>
      )}
      {installError && (
        <section className="text-sm" style={{ color: DANGER }}>
          {installError}
          <button
            onClick={copyDiagnostics}
            className="ml-3 px-3 py-1.5 rounded-md text-xs"
            style={{ border: `1px solid ${DANGER}`, color: DANGER }}
          >
            Copy diagnostics
          </button>
        </section>
      )}
      {claimError && (
        <section className="text-sm" style={{ color: DANGER }}>
          {claimError}
        </section>
      )}
    </div>
  );
}
