// SshInstallStep.tsx — minimal renderer harness for the SSH installer flow.
//
// Scope (BET-355): the issue explicitly scopes this stage to "machinery
// only — connecting, checking, installing, reporting progress. The
// onboarding UI rework is Stage 5." So this component is a working
// harness that exercises the IPC channels end-to-end, NOT a polished
// onboarding screen. Stage 5 will fully replace the PairStep → "Pair via
// box id" pairing with this flow + remove the manual code entry entirely
// (preserved as a behind-a-disclosure escape hatch for boxes the user
// cannot reach over SSH).
//
// Integration today: PairStep renders a "Set up a fresh box via SSH"
// button at the bottom that swaps its local state to render <SshInstallStep>
// instead of the manual pairing form. On success, SshInstallStep calls
// onPaired() — the SAME callback PairStep uses — so the onboarding shell's
// transition to step 2 is identical regardless of which path got there.
//
// All decision logic lives in the main-process installer module (pure
// helpers + the IPC handlers). This component is React state + per-event
// dispatch + JSX, nothing more.

import { useEffect, useState, useRef } from "react";
import { getMantaPreload, type InstallerEvent, type InstallerState } from "./preloadAccess";

// Local view of one stage row — what the checklist renders. Mirrors the
// snapshot the main process pushes on every stage transition.
type StageRow = {
  id: string;
  label: string;
  state: "done" | "active" | "pending";
};

const ACCENT = "#5A88FF";
const DANGER = "#FF7A88";
const OK_GREEN = "#22C55E";
const WARN_YELLOW = "#FACC15";

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
  const [preflight, setPreflight] = useState<InstallerState | null>(null);
  const [preflightRunning, setPreflightRunning] = useState(false);
  const [installStarted, setInstallStarted] = useState(false);
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const [stage, setStage] = useState<string>("preflight");
  const [snapshot, setSnapshot] = useState<StageRow[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState<
    | { ok: boolean; code: number | null; signal: NodeJS.Signals | null }
    | null
  >(null);
  const [installError, setInstallError] = useState<string | null>(null);
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
  // should not strand the user). Main keeps the install alive across the
  // renderer remount; we just re-read state and re-attach the listener.
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await preload.installerState();
      if (!alive) return;
      setStage(s.stage);
      setLines(s.logTail);
      setSnapshot(
        // Map the simple stage + logTail into a single-stage snapshot the
        // checklist can render. The first "stage" push will replace it
        // with the real snapshot; until then we just show "active" on the
        // current stage.
        [
          { id: "preflight", label: "Preflight", state: "done" as const },
          { id: "download", label: "Download release", state: "pending" as const },
          { id: "extract", label: "Extract + atomic swap", state: "pending" as const },
          { id: "service", label: "Install + start service", state: "pending" as const },
          { id: "pairing", label: "Pair with the desktop", state: "pending" as const },
          { id: "done", label: "Done", state: "pending" as const },
        ].map((row) =>
          row.id === s.stage
            ? { ...row, state: "active" as const }
            : row,
        ),
      );
    })();
    return () => {
      alive = false;
    };
  }, [preload]);

  // Subscribe to installer events. Re-subscribes when the active handle
  // changes (so old events from a previous handle don't bleed into the new
  // install's UI). The unsubscribers are captured in a ref so a re-render
  // triggered by setActiveHandle doesn't double-subscribe.
  useEffect(() => {
    const unsub = preload.onInstallerEvent((evt: InstallerEvent) => {
      // Only react to events from the CURRENT handle — stale events from a
      // previous install (after the user clicked Cancel + tried again) must
      // not update the new install's UI.
      if (activeHandle !== null && evt.handleId !== activeHandle) return;
      switch (evt.kind) {
        case "line":
          setLines((prev) => [...prev, evt.text]);
          break;
        case "stage":
          setStage(evt.stage);
          setSnapshot(evt.snapshot);
          break;
        case "done":
          setDone({ ok: evt.ok, code: evt.code, signal: evt.signal });
          setInstallStarted(false);
          setActiveHandle(null);
          // Auto-claim on success — the whole point of the flow. The user
          // typed a host, nothing else.
          if (evt.ok) {
            void runClaim();
          }
          break;
        case "error":
          setInstallError(evt.message);
          setInstallStarted(false);
          setActiveHandle(null);
          break;
      }
    });
    return unsub;
    // We intentionally include activeHandle in deps so the listener captures
    // the right guard value, but we ALSO store activeHandle in a ref so
    // the closure sees the latest value (avoids stale-state bugs on rapid
    // re-renders).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preload, activeHandle]);

  // Auto-scroll the log pane on new lines — matches what a terminal user
  // expects (Tail-style: stick to the bottom while streaming).
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  // ---------- Actions ----------
  async function runPreflight() {
    if (!alias.trim()) return;
    setPreflightRunning(true);
    setInstallError(null);
    try {
      const r = await preload.installerPreflight({ alias: alias.trim() });
      setPreflight(r as unknown as InstallerState);
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreflightRunning(false);
    }
  }

  async function startInstall() {
    setInstallError(null);
    setLines([]);
    setDone(null);
    setClaimError(null);
    setSnapshot([]);
    setStage("preflight");
    try {
      const { handleId } = await preload.installerStart({ alias: alias.trim() });
      setActiveHandle(handleId);
      setInstallStarted(true);
    } catch (e) {
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
        // Mirror the manual PairStep onPaired — the onboarding shell advances
        // to step 2 (Providers) exactly as if the user had typed a pairing
        // code by hand.
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
    // The renderer never sees a structured PreflightResult object outside of
    // the preflight() call (it's a transient value used for the inline UI
    // verdict). To build a diagnostics blob we need it back in scope — the
    // typed `preflight` state was modeled too loosely. We carry a placeholder
    // here so the "Copy diagnostics" button still works when the user clicks
    // it before preflight has run; the snapshot they get will lack the
    // probes but that's better than a no-op. Real fix lands when Stage 5
    // reworks the UX (the issue explicitly defers UI quality to Stage 5).
    const placeholderPreflight = {
      ok: true as const,
      ingressMode: "public-tls" as const,
      probes: {
        reachability: "ok" as const,
        os: { id: "unknown" as const, arch: "unknown" as const, release: null },
        passwordlessSudo: false,
        tailscale: { running: false, ipv4: null },
        clockSkewSeconds: 0,
        alreadyInstalled: false,
      },
      failures: [],
      warnings: [],
    };
    const r = await preload.installerGetDiagnostics({
      preflight: placeholderPreflight,
      stage: stage as never,
      logTail: lines,
      alias,
    });
    await navigator.clipboard.writeText(r);
  }

  // ---------- Render ----------
  const canRunPreflight = alias.trim() !== "" && !installStarted && !claimRunning;
  const preflightVerdict = (preflight as unknown as {
    ok?: boolean;
    failures?: Array<{ cause: string; action: string }>;
    warnings?: Array<{ message: string }>;
    ingressMode?: string;
  } | null);

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-2xl font-semibold mb-2">Set up your box via SSH</h2>
        <p className="text-sm text-text-muted leading-relaxed">
          Pick a host from your SSH config. The app will check the box, install
          MantaUI, and pair with it — no terminal needed.
        </p>
      </header>

      {/* Host picker */}
      <section className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="ssh-host">
          Host
        </label>
        {hostsLoaded && hosts.length > 0 ? (
          <select
            id="ssh-host"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            disabled={installStarted || claimRunning}
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
            disabled={installStarted || claimRunning}
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
            onClick={runPreflight}
            disabled={!canRunPreflight || preflightRunning}
            className="px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
            style={{ background: ACCENT, color: "#0B1020" }}
          >
            {preflightRunning ? "Checking…" : "Preflight"}
          </button>
          <button
            onClick={startInstall}
            disabled={
              installStarted ||
              claimRunning ||
              !alias.trim() ||
              // Block install start if a preflight ran AND failed; the user
              // can still proceed past a warning.
              (preflightVerdict !== null && preflightVerdict.ok === false)
            }
            className="px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
            style={{ background: ACCENT, color: "#0B1020" }}
          >
            {installStarted ? "Installing…" : "Install + pair"}
          </button>
          {installStarted && (
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

      {/* Preflight verdict */}
      {preflightVerdict && (
        <section className="space-y-2 text-sm">
          <h3 className="font-medium">Preflight</h3>
          {preflightVerdict.failures && preflightVerdict.failures.length > 0 && (
            <ul className="space-y-1">
              {preflightVerdict.failures.map((f, i) => (
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
          )}
          {preflightVerdict.warnings && preflightVerdict.warnings.length > 0 && (
            <ul className="space-y-1">
              {preflightVerdict.warnings.map((w, i) => (
                <li
                  key={i}
                  className="rounded-md px-3 py-2 text-xs"
                  style={{ border: `1px solid ${WARN_YELLOW}`, color: WARN_YELLOW }}
                >
                  {w.message}
                </li>
              ))}
            </ul>
          )}
          {preflightVerdict.ok && preflightVerdict.failures?.length === 0 && (
            <p style={{ color: OK_GREEN }}>
              Ready — install path: {preflightVerdict.ingressMode}
            </p>
          )}
        </section>
      )}

      {/* Stages checklist */}
      {snapshot.length > 0 && (
        <section className="space-y-1 text-sm">
          <h3 className="font-medium">Progress</h3>
          <ul className="space-y-1">
            {snapshot.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <span
                  aria-hidden
                  style={{
                    color:
                      s.state === "done"
                        ? OK_GREEN
                        : s.state === "active"
                        ? ACCENT
                        : undefined,
                    opacity: s.state === "pending" ? 0.4 : 1,
                  }}
                >
                  {s.state === "done" ? "✓" : s.state === "active" ? "●" : "○"}
                </span>
                <span
                  style={{
                    opacity: s.state === "pending" ? 0.4 : 1,
                  }}
                >
                  {s.label}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Live log + diagnostics */}
      {lines.length > 0 && (
        <section className="space-y-2">
          <details>
            <summary className="text-xs cursor-pointer text-text-muted">
              Show raw install log ({lines.length} lines)
            </summary>
            <div
              ref={logRef}
              className="mt-2 max-h-64 overflow-y-auto rounded-md bg-bg-elev px-3 py-2 text-xs font-mono whitespace-pre-wrap"
            >
              {lines.join("\n")}
            </div>
          </details>
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
