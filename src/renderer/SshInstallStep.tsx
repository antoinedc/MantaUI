// SshInstallStep.tsx — SSH installer harness for the desktop onboarding
// "Connect your box" step (BET-355 / BET-382 / BET-383).
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
// All decision logic lives in the main-process installer module. This
// component is React state + per-event dispatch + JSX, nothing more.

import { useEffect, useState, useRef } from "react";
import {
  getMantaPreload,
  type InstallerEvent,
  type InstallerStageSnapshotRow,
  type PreflightFailure,
} from "./preloadAccess";

const ACCENT = "#5A88FF";
const DANGER = "#FF7A88";
const OK_GREEN = "#22C55E";

// Keep the last N log lines only — main already caps its own tail at 200
// (handlers.ts LOG_TAIL_MAX); the renderer needs its own cap too, or a long
// install grows the DOM without bound.
const LOG_LINES_MAX = 500;

const INITIAL_STAGE: InstallerStageSnapshotRow["id"] = "preflight";
// Mirrors stageMapper.ts's INSTALL_STAGES[0] — shown from click until the
// first real "stage" event arrives.
const INITIAL_STAGE_LABEL = "Checking the box";
const TOTAL_STAGES = 6;

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
  const [alias, setAlias] = useState("");
  const [running, setRunning] = useState(false);
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const [stage, setStage] = useState<InstallerStageSnapshotRow["id"]>(INITIAL_STAGE);
  const [stageLabel, setStageLabel] = useState(INITIAL_STAGE_LABEL);
  const [stageIndex, setStageIndex] = useState(1);
  const [stageTotal, setStageTotal] = useState(TOTAL_STAGES);
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

  // ---------- One-shot loads on mount ----------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await preload.installerListHosts();
        if (!alive) return;
        setHosts(list);
        setHostsLoaded(true);
        if (list.length > 0 && list[0].alias) setAlias(list[0].alias);
      } catch {
        if (!alive) return;
        setHostsLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [preload]);

  // Recover any in-flight install on mount (a page refresh mid-install
  // shouldn't strand the user), or a preflight failure the user hasn't
  // dismissed yet — main echoes the real verdict, no placeholder needed.
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await preload.installerState();
      if (!alive) return;
      if (s.active) {
        // Stage label/index snap to the next real "stage" event; the
        // initial defaults are close enough for the brief recovery window.
        setRunning(true);
        setStage(s.stage);
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
        case "stage":
          setStage(evt.stage);
          setStageLabel(evt.label);
          setStageIndex(evt.index);
          setStageTotal(evt.total);
          break;
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
  async function startInstall() {
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
    setStageLabel(INITIAL_STAGE_LABEL);
    setStageIndex(1);
    setStageTotal(TOTAL_STAGES);
    setElapsedSeconds(0);
    setLogOpen(true);
    // Mount the progress panel immediately on click — no gap before the
    // main process's response comes back.
    setRunning(true);
    try {
      const { handleId } = await preload.installerStart({ alias: alias.trim() });
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
    setClaimRunning(true);
    setClaimError(null);
    try {
      const outcome = (await preload.installerMintAndClaim({
        alias: alias.trim(),
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
    const r = await preload.installerGetDiagnostics({
      preflight: s.preflight,
      stage,
      logTail: lines,
      alias,
    });
    await navigator.clipboard.writeText(r);
  }

  // ---------- Render ----------
  const installDisabled = running || claimRunning || !alias.trim();
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
          (BET-382); this component drops straight into the picker. */}
      <section className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="ssh-host">
          Host
        </label>
        {hostsLoaded && hosts.length > 0 ? (
          <select
            id="ssh-host"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            disabled={running || claimRunning}
            className="w-full rounded-md bg-bg-elev px-3 py-2 text-sm border border-border focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {hosts.map((h) => (
              <option key={h.alias} value={h.alias}>
                {h.alias}
                {h.patterns.length > 1 ? ` (${h.patterns.join(", ")})` : ""}
              </option>
            ))}
          </select>
        ) : (
          <input
            id="ssh-host"
            type="text"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="user@box.example"
            disabled={running || claimRunning}
            className="w-full rounded-md bg-bg-elev px-3 py-2 text-sm border border-border focus:outline-none focus:ring-2 focus:ring-accent"
          />
        )}
        {hostsLoaded && hosts.length === 0 && (
          <p className="text-xs text-text-muted">
            No hosts found in ~/.ssh/config. Type the SSH alias or
            user@host:port directly above.
          </p>
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
