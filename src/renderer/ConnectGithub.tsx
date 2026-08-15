// ConnectGithub.tsx — the ONE GitHub device-connect surface (BET-940).
//
// Extracted from CloneFromGitHub's [S5] connect phase so the banner wiring (a
// separate issue) can reuse the identical screen. There must be exactly one
// implementation of the device flow; it lives here and only here.
//
// The component owns, internally:
//   - the `forgeDeviceStart()` call on mount and its three outcomes
//     (`connected` → onConnected; `notConfigured` → the "sign-in isn't
//     configured" panel; otherwise → show the code);
//   - the countdown + auto clipboard copy of the user code;
//   - the Cancel button (calls `forgeDeviceCancel` then `onCancel`);
//   - the "code expired" panel (Try again → restart the flow, Skip for now →
//     `onCancel`);
//   - a "couldn't sign in" panel for the error case (Try again / Cancel).
//
// POLL-LOOP INVARIANTS (BET-940 §2):
//   - One self-rescheduling timeout chain, never `setInterval`. The interval
//     is re-read from EVERY response so GitHub's `slow_down` lengthening is
//     always honoured — a fixed 5s interval can never catch up once the
//     required gap exceeds it, and the screen would hang forever.
//   - NO immediate first poll. GitHub cannot have authorised before the first
//     interval elapses, and a back-to-back poll (e.g. React StrictMode's
//     double effect setup) is exactly what trips `slow_down`.
//   - Three consecutive error responses stop the loop and show the
//     "couldn't sign in" panel. No silent catch — transport failures are
//     logged and count toward the same budget.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { DeviceCodeSteps } from "./DeviceFlow";
import { ship } from "./log";
import type { ForgeDeviceGrant } from "../shared/types";

// The panel title row (.mhead where it is REAL — [S5] [S6] [E2] [E3]). Moved
// here so the picker/clone/failed panels in CloneFromGitHub import it rather
// than redeclaring a second definition.
export function PanelHeader({
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

// The shared chrome wrapper for every clone-flow panel. One definition, here.
export const PANEL_CLASS =
  "w-full max-w-[520px] rounded-lg border border-border bg-bg-elev overflow-hidden";

// mm:ss countdown label — mono so it doesn't jitter.
function countdownLabel(remainingMs: number): string {
  const s = Math.max(0, Math.floor(remainingMs / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Consecutive `error`/transport failures, or any one start failure, will stop
// the loop and surface the "couldn't sign in" panel.
const MAX_CONSECUTIVE_ERRORS = 3;

type Stage =
  | { kind: "starting" }
  | { kind: "code" }
  | { kind: "notConfigured" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

export function ConnectGithubPanel({
  onConnected,
  onCancel,
}: {
  onConnected: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [stage, setStage] = useState<Stage>({ kind: "starting" });
  const [grant, setGrant] = useState<ForgeDeviceGrant | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [copiedNote, setCopiedNote] = useState(false);
  const grantRef = useRef<ForgeDeviceGrant | null>(null);
  // Bumped to restart the whole flow (Try again from the expired/error panes).
  const [bootSeq, setBootSeq] = useState(0);

  // Callbacks are held in refs so neither the start effect (keyed on bootSeq)
  // nor the poll effect (keyed on the grant id) re-fires when the parent's
  // inline handlers change identity on a re-render.
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // ---- [S5]: start the device grant (mount + every Try again) ----
  // A box that already has a credential (CLI/secret) skips straight to the
  // picker via onConnected.
  useEffect(() => {
    let cancelled = false;
    setStage({ kind: "starting" });
    setGrant(null);
    setCopiedNote(false);
    (async () => {
      try {
        const res = await window.api.forgeDeviceStart();
        if (cancelled) return;
        if ("notConfigured" in res && res.notConfigured) {
          // The box's device-grant id is a placeholder (BET-849) — surface a
          // clear "not configured" state, never a guaranteed-dead-end screen.
          setStage({ kind: "notConfigured" });
          return;
        }
        if (res.connected) {
          onConnectedRef.current();
          return;
        }
        const g = res.grant!;
        grantRef.current = g;
        setGrant(g);
        setRemainingMs(g.expiresIn * 1000);
        setStage({ kind: "code" });
        // Rule 5: copy the code automatically — the user pastes, not retypes.
        window.api
          .clipboardWriteText(g.userCode)
          .then(() => setCopiedNote(true), () => {});
      } catch {
        if (cancelled) return;
        // A connection-level failure surfaces here, not in a caller phase.
        setStage({ kind: "error", message: "Couldn't reach the box. Try again." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootSeq]);

  // ---- [S5]: poll the grant + countdown tick ----
  // One self-rescheduling timeout chain. The first poll is scheduled at the
  // full interval (never immediately); after every response the interval is
  // re-read so slow_down's lengthening is always honoured.
  useEffect(() => {
    if (!stage.kind || stage.kind !== "code" || !grant) return;
    const deadline = Date.now() + grant.expiresIn * 1000;
    // Mutable per chain; re-read from every response (§2a).
    let intervalSec = Math.max(grant.pollInterval, 5);
    // Local error budget — reset by any non-error response (§2c).
    let consecutiveErrors = 0;
    let cancelled = false;
    let inFlight = false;
    let pollTimer: number | undefined;
    let ticker: number | undefined;

    const stop = () => {
      cancelled = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      if (ticker !== undefined) window.clearInterval(ticker);
    };

    const fail = (message: string) => {
      stop();
      setStage({ kind: "error", message });
    };

    const scheduleNext = () => {
      pollTimer = window.setTimeout(runPoll, intervalSec * 1000);
    };

    const runPoll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      let res;
      try {
        res = await window.api.forgeDevicePoll({ grantId: grant.grantId });
      } catch (e) {
        // No silent catch — log it and count it toward the error budget.
        ship("warn", "github device poll failed", { error: String(e) });
        consecutiveErrors++;
        inFlight = false;
        if (cancelled) return;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          fail("Couldn't reach the box. Try again.");
          return;
        }
        scheduleNext();
        return;
      }
      inFlight = false;
      if (cancelled) return;
      if (res.status === "done") {
        stop();
        onConnectedRef.current();
        return;
      }
      if (res.status === "expired") {
        stop();
        setStage({ kind: "expired" });
        return;
      }
      if (res.status === "pending") {
        consecutiveErrors = 0;
        if (res.pollInterval) intervalSec = Math.max(res.pollInterval, 5);
        scheduleNext();
        return;
      }
      if (res.status === "error") {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          fail(res.error || "GitHub sign-in failed.");
          return;
        }
        scheduleNext();
        return;
      }
    };

    // Countdown is separate from the poll loop (pure clock, no network).
    ticker = window.setInterval(() => setRemainingMs(deadline - Date.now()), 1000);
    // NO immediate poll — schedule the first at the full interval.
    scheduleNext();
    return stop;
    // Narrowed to the grant id so cosmetic state (remainingMs, copiedNote)
    // changes never reset the timers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grant?.grantId]);

  const restart = useCallback(() => {
    grantRef.current = null;
    setCopiedNote(false);
    setBootSeq((s) => s + 1);
  }, []);

  const cancelConnect = useCallback(() => {
    if (grantRef.current) {
      void window.api.forgeDeviceCancel({ grantId: grantRef.current.grantId });
    }
    onCancelRef.current(); // back to [S4] with nothing changed
  }, []);

  const cancel = useCallback(() => {
    onCancelRef.current();
  }, []);

  return (
    <>
      {stage.kind === "starting" && (
        <div className="p-4 text-[13px] text-text-muted">Preparing sign-in…</div>
      )}

      {stage.kind === "code" && grant && (
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

      {stage.kind === "notConfigured" && (
        <>
          <PanelHeader title="Connect GitHub" />
          <div className="p-4">
            <Callout tone="warn">
              GitHub sign-in isn't configured on this box yet.
            </Callout>
            <div className="flex gap-2 mt-3">
              <Button tone="ghost" onClick={cancel}>
                Back
              </Button>
            </div>
          </div>
        </>
      )}

      {stage.kind === "expired" && (
        <>
          <PanelHeader title="Connect GitHub · Failed" />
          <div className="p-4">
            <Callout tone="danger">
              The sign-in code expired before it was entered.
            </Callout>
            <div className="flex gap-2 mt-3">
              <Button tone="primary" onClick={restart}>
                Try again
              </Button>
              <Button tone="ghost" onClick={cancel}>
                Skip for now
              </Button>
            </div>
          </div>
        </>
      )}

      {stage.kind === "error" && (
        <>
          <PanelHeader title="Connect GitHub · Failed" />
          <div className="p-4">
            <Callout tone="danger">Couldn't sign in: {stage.message}</Callout>
            <div className="flex gap-2 mt-3">
              <Button tone="primary" onClick={restart}>
                Try again
              </Button>
              <Button tone="ghost" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
