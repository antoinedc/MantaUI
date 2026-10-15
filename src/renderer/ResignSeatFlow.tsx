// ResignSeatFlow — sign an EXISTING seat back in, from the usage popover's
// "Logged out" badge (spec 2026-10-15-seat-resign).
//
// Same sign-in UI as AddSeatFlow (SeatSignIn.tsx), different driver. The box
// runs the login into a scratch location and only replaces the seat's
// credentials once the login is proven to be the SAME account, so:
//
//   starting → signin ─┬─ ok ............. done    ("Signed back in as …", list refreshed, closes)
//                      ├─ different-account failed  (says who you signed in as; seat untouched)
//                      ├─ login-failed ... failed   (Try again)
//                      └─ unknown-flow ... failed   (the box forgot the flow; Try again)
//
// Cancelling (or closing) tells the box to drop the scratch login and says, on
// screen, that the seat was not changed. Every outcome is visible (AGENTS.md:
// never stub a control to do nothing).

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { SeatProviderId } from "../shared/types";
import { accountsErrorMessage, isPollExpired } from "./chatUtils";
import { Callout } from "./Callout";
import { Modal } from "./Modal";
import { useStore } from "./store";
import { refreshAccountsAndUsage } from "./accountsData";
import {
  CLIENT_LIMIT_MS,
  SEAT_POLL_INTERVAL_MS,
  SeatSignInBlock,
  signInFromConnect,
  useClaudeLoginExit,
  useElapsedSeconds,
  useSubmitSettle,
  type SignInPhase,
} from "./SeatSignIn";

/** How long "Signed back in as …" stays up before the modal closes. */
export const RESIGN_DONE_HOLD_MS = 1_500;

type Phase =
  | { kind: "starting" }
  | (Extract<SignInPhase, { kind: "claude" }> & { flowId: string })
  | (Extract<SignInPhase, { kind: "device" }> & { flowId: string })
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string };

/** Why a re-sign failed, in words that say what to do next. The seat was not
 *  changed in any of these cases. */
export function resignFailureMessage(
  error: string | undefined,
  info: { expectedEmail?: string | null; gotEmail?: string | null; seatLabel: string; email: string | null },
): string {
  if (error === "different-account") {
    const expected = info.expectedEmail ?? info.email;
    const got = info.gotEmail ?? "a different account";
    return expected
      ? `You signed in as ${got}, but this seat is ${expected}. Sign in with ${expected}.`
      : `You signed in as ${got}, but that isn't the account ${info.seatLabel} belongs to. Sign in with the same account.`;
  }
  return `Sign-in didn't complete. ${info.seatLabel} was not changed — try again.`;
}

export function ResignSeatFlow({
  provider,
  seatId,
  seatLabel,
  accountLabel,
  email,
  onDone,
  onCancel,
}: {
  provider: SeatProviderId;
  seatId: string;
  seatLabel: string;
  accountLabel?: string;
  email: string | null;
  /** Called once with a sentence describing what happened, after the list refreshed. */
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [epoch, setEpoch] = useState(0);
  const mounted = useRef(true);
  // The flow the box is holding open, until it settles.
  const flowRef = useRef<string | null>(null);
  const waitForSettle = useSubmitSettle(phase);
  // Identity-stable: a parent re-render must not restart the poll.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const set = useCallback((p: Phase) => {
    if (mounted.current) setPhase(p);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Closed without finishing (the dial unmounted, Escape): drop the scratch
      // login on the box. Best-effort cleanup — the × button awaits and reports.
      const open = flowRef.current;
      if (open) void window.api.accountsResignCancel({ flowId: open }).catch(() => {});
    };
  }, []);

  // 1. Ask the box to start a sign-in for this seat.
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "starting" });
    (async () => {
      let res;
      try {
        res = await window.api.accountsResignSeat({ provider, seatId });
      } catch {
        if (!cancelled) set({ kind: "failed", message: "Couldn't reach the server. Try again." });
        return;
      }
      if (cancelled) return;
      if (!res || "error" in res) {
        set({ kind: "failed", message: accountsErrorMessage(res && "error" in res ? res.error : undefined) });
        return;
      }
      const signIn = signInFromConnect(res.connect);
      if (!signIn) {
        // A sign-in shape this card can't drive: hand the flow back to the box.
        void window.api.accountsResignCancel({ flowId: res.flowId }).catch(() => {});
        set({ kind: "failed", message: "This provider's sign-in can't be started from here yet." });
        return;
      }
      flowRef.current = res.flowId;
      set({ ...signIn, flowId: res.flowId });
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, seatId, epoch, set]);

  const flowId = phase.kind === "claude" || phase.kind === "device" ? phase.flowId : null;

  // 2. While signing in, poll the box for the verdict.
  useEffect(() => {
    if (!flowId) return;
    const startedWall = Date.now();
    let inFlight = false;
    let unreachable = false;
    const handle = window.setInterval(async () => {
      if (!mounted.current || inFlight) return;
      inFlight = true;
      try {
        const expired = isPollExpired(startedWall, Date.now(), CLIENT_LIMIT_MS);
        let st;
        try {
          st = await window.api.accountsResignStatus({ flowId });
          unreachable = false;
        } catch {
          unreachable = true;
          if (!expired) return; // box transiently unreachable — keep polling
        }
        if (!mounted.current) return;
        if (!st || st.state === "pending") {
          if (!expired) return;
          window.clearInterval(handle);
          flowRef.current = null;
          void window.api.accountsResignCancel({ flowId }).catch(() => {});
          set({
            kind: "failed",
            message: unreachable
              ? `Couldn't reach the server to check the sign-in. ${seatLabel} was not changed — try again once the box is reachable.`
              : `The sign-in wasn't finished within 15 minutes, so the box stopped waiting. ${seatLabel} was not changed — try again.`,
          });
          return;
        }
        window.clearInterval(handle);
        flowRef.current = null; // settled: the box no longer holds it
        if (st.state === "ok") {
          const who = st.seat?.email ?? email;
          const message = who ? `Signed back in as ${who}` : `${st.seat?.label ?? seatLabel} is signed back in`;
          set({ kind: "done", message });
          // Hold the confirmation, and don't close until the list + usage show
          // the seat healthy again.
          await Promise.all([
            refreshAccountsAndUsage(),
            new Promise<void>((resolve) => window.setTimeout(resolve, RESIGN_DONE_HOLD_MS)),
          ]);
          if (mounted.current) onDoneRef.current(message);
          return;
        }
        set({
          kind: "failed",
          message: resignFailureMessage(st.error, {
            expectedEmail: st.expectedEmail,
            gotEmail: st.gotEmail,
            seatLabel,
            email,
          }),
        });
      } finally {
        inFlight = false;
      }
    }, SEAT_POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [flowId, set, seatLabel, email]);

  const elapsed = useElapsedSeconds(flowId);

  const sessionKey = phase.kind === "claude" ? phase.sessionKey : null;
  useClaudeLoginExit(sessionKey, () => {
    const open = flowRef.current;
    flowRef.current = null;
    if (open) void window.api.accountsResignCancel({ flowId: open }).catch(() => {});
    set({
      kind: "failed",
      message: `That code didn't work (it may have expired). ${seatLabel} was not changed — start the sign-in again.`,
    });
  });

  // The explicit Cancel / × / Escape: drop the scratch login on the box, say so
  // if that fails, say the seat was not changed, close.
  const cancel = useCallback(async () => {
    const open = flowRef.current;
    flowRef.current = null;
    if (open) {
      try {
        await window.api.accountsResignCancel({ flowId: open });
        useStore.getState().pushAppToast({ message: `Sign-in cancelled — ${seatLabel} was not changed.` });
      } catch {
        useStore.getState().pushAppToast({
          message: `Couldn't cancel the sign-in on the server — it will expire by itself. ${seatLabel} was not changed.`,
          tone: "error",
        });
      }
    }
    onCancel();
  }, [onCancel, seatLabel]);

  const signingIn = phase.kind === "claude" || phase.kind === "device";
  const expectedLabel = email ?? "this seat's account";

  return (
    <Modal size="lg" label={`Sign ${seatLabel} back in`} onDismiss={() => void cancel()}>
      <div className="space-y-3 text-meta" data-testid="resign-seat-flow">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-prose font-semibold text-text">Sign {seatLabel} back in</div>
            <div className="truncate text-text-muted" data-testid="resign-seat-email">
              {accountLabel ? `${accountLabel} · ` : ""}
              {email ?? "email unknown"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void cancel()}
            className="px-2 rounded-xs text-text-faint hover:text-text-muted inline-flex items-center"
            title="Cancel"
            aria-label="Cancel"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {(phase.kind === "starting" || signingIn) && (
          <div className="text-text-faint">
            Sign in with {expectedLabel}. {seatLabel} stays as it is until the sign-in is confirmed to be the same account.
          </div>
        )}

        {phase.kind === "starting" && <div className="text-text-muted">Preparing sign-in…</div>}

        {(phase.kind === "claude" || phase.kind === "device") && (
          <SeatSignInBlock
            phase={phase}
            elapsed={elapsed}
            waitForSettle={waitForSettle}
            onPatch={(patch) => set({ ...phase, ...patch })}
            onCancel={() => void cancel()}
          />
        )}

        {phase.kind === "done" && (
          <div className="text-ok" role="status">
            {phase.message}
          </div>
        )}

        {phase.kind === "failed" && (
          <div className="space-y-2">
            <Callout tone="danger">{phase.message}</Callout>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEpoch((e) => e + 1)}
                className="px-2 py-1 border border-border rounded-xs text-text-muted hover:text-text"
              >
                Try again
              </button>
              <button type="button" onClick={() => void cancel()} className="px-2 py-1 text-text-faint hover:text-text">
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
