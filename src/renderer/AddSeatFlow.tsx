// AddSeatFlow — sign a new seat (or a new account) into a subscription provider
// (multi-account spec §7, contract v2 §8).
//
// The sign-in UI is the existing connect flow's: the same Claude terminal +
// code block and the same device-code block, mounted from ConnectProvider's own
// exported pieces so the two cannot drift. What differs is the driver. The seat
// does not exist until the box has identified the login, so there is no
// opencode restart and no `connected[]` poll — the box answers
// `accounts:seat-status` and this component polls it:
//
//   starting → signin ─┬─ ok ............ done        (seat placed)
//                      ├─ different-org . asks        ("create a new account?")
//                      ├─ duplicate ..... failed      (already added)
//                      ├─ timed out ..... failed      (the box's 15-minute wait ran out)
//                      └─ login-failed .. failed      (Try again)
//
// A finished sign-in is never thrown away by this card. The box resolves a
// login from its credentials file (not from our polling) and waits 15 minutes,
// so this card waits at least as long, and when its own limit is reached it
// asks the box ONE last time before it gives up — it never cancels a seat the
// box could still place. On success the card awaits the list refresh before it
// reports done, so the new seat is already on screen when the panel closes.
//
// Every press ends in one of the three legal outcomes (AGENTS.md): it does the
// thing and says so, it fails and says why, or the control is not there.
// Cancel (and closing the card) tells the box to abort the half-made seat.

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ProviderView, SeatConnect, SeatProviderId } from "../shared/types";
import {
  accountsErrorMessage,
  formatRemaining,
  isPollExpired,
  needsSecondAccountNote,
  providerViewOrError,
  SEAT_TOS_NOTE,
} from "./chatUtils";
import { providerLabel } from "./UsageDial";
import { ClaudeLoginBlock, WaitingBlockBody } from "./ConnectProvider";
import { ProcessPanel } from "./ProcessPanel";
import { Callout } from "./Callout";
import { useStore } from "./store";
import { findSeatLabels, refreshAccountsAndUsage } from "./accountsData";

const SEAT_POLL_INTERVAL_MS = 2_000;
// The box waits this long for a sign-in to finish (LOGIN_TIMEOUT_MS in
// src/server/accountsManager.mjs) — one limit for the Claude paste-back and the
// device-code wait alike. Keep the two in step.
export const SERVER_LOGIN_LIMIT_MS = 15 * 60 * 1_000;
// This card gives up only AFTER the box would have, plus a little slack for the
// clocks starting at slightly different moments; the final ask below settles it.
const CLIENT_LIMIT_MS = SERVER_LOGIN_LIMIT_MS + 30_000;

export const TOS_ACK_KEY = "manta:accounts:tosAck";

export function readTosAck(): boolean {
  try {
    return window.localStorage.getItem(TOS_ACK_KEY) === "1";
  } catch {
    return false;
  }
}

/** Why a seat sign-in failed, in words that say what to do next. */
export function seatFailureMessage(error: string | undefined, timedOut: boolean): string {
  if (error === "duplicate-login") return "That login is already added as a seat. Sign in with a different account.";
  if (timedOut) {
    return "The sign-in wasn't finished within 15 minutes, so the box stopped waiting. Try again and finish it in the browser.";
  }
  return "The sign-in failed — the code may have been wrong or expired. Try again.";
}

type Phase =
  | { kind: "starting" }
  | { kind: "claude"; seatId: string; sessionKey: string; cwd: string; url: string; inputError?: string }
  | { kind: "device"; seatId: string; url: string; instructions: string }
  | { kind: "different-org"; seatId: string; orgName?: string; busy: boolean }
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string };

export function AddSeatFlow({
  provider,
  accountId,
  accountLabel,
  onDone,
  onCancel,
}: {
  provider: SeatProviderId;
  /** Present: add a seat to this account. Absent: add a new account. */
  accountId?: string;
  accountLabel?: string;
  /** Called once with a sentence describing what was added. */
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [epoch, setEpoch] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const mounted = useRef(true);
  // The half-made seat the box is holding, until the flow settles it.
  const openSeatRef = useRef<string | null>(null);
  // done is reported exactly once, whatever the parent does with onDone's identity.
  const reportedRef = useRef(false);
  // Submit keeps its spinner until the flow SETTLES (seat listed / failed /
  // different-org / cancelled), not just until the code was typed into the
  // sign-in. Resolved by the phase effect below.
  const settleRef = useRef<(() => void) | null>(null);
  const label = providerLabel(provider);

  const set = useCallback((p: Phase) => {
    if (mounted.current) setPhase(p);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Closed without finishing (Settings navigated away, card replaced):
      // abort the half-made seat on the box. Best-effort cleanup, not a user
      // action — the explicit Cancel button awaits and reports it.
      const open = openSeatRef.current;
      if (open) void window.api.accountsCancelSeat({ seatId: open }).catch(() => {});
    };
  }, []);

  // 1. Ask the box to start a sign-in for a new seat.
  useEffect(() => {
    let cancelled = false;
    reportedRef.current = false;
    setPhase({ kind: "starting" });
    (async () => {
      let res;
      try {
        res = await window.api.accountsAddSeat({ provider, accountId });
      } catch {
        if (!cancelled) set({ kind: "failed", message: "Couldn't reach the server. Try again." });
        return;
      }
      if (cancelled) return;
      if (!res || "error" in res) {
        set({ kind: "failed", message: accountsErrorMessage(res && "error" in res ? res.error : undefined) });
        return;
      }
      openSeatRef.current = res.seatId;
      const next = phaseFromConnect(res.seatId, res.connect);
      if (next.kind === "failed") {
        // A sign-in shape this card can't drive: give the seat back to the box.
        openSeatRef.current = null;
        void window.api.accountsCancelSeat({ seatId: res.seatId }).catch(() => {});
      }
      set(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, accountId, epoch, set]);

  const seatId = phase.kind === "claude" || phase.kind === "device" ? phase.seatId : null;

  // The seat is on the box and in the list: read where it landed (after the
  // refresh) and finish. Awaited, so the panel never closes before the list shows it.
  const finishAdded = useCallback(
    async (sid: string, fallbackLabel: string, opts: { newAccount?: boolean; accountName?: string } = {}) => {
      await refreshAccountsAndUsage();
      const found = findSeatLabels(provider, sid);
      let text: string;
      if (accountId && !opts.newAccount) text = `Added ${found?.seatLabel ?? fallbackLabel} to ${found?.accountLabel ?? label}.`;
      else if (found) text = `Added the account “${found.accountLabel}” — ${found.email ?? found.seatLabel} is signed in.`;
      else text = `Added ${opts.accountName ?? fallbackLabel} to ${label}.`;
      set({ kind: "done", message: text });
    },
    [accountId, label, provider, set],
  );

  // 2. While signing in, poll the box for the verdict.
  useEffect(() => {
    if (!seatId) return;
    const startedWall = Date.now();
    setElapsed(0);
    const tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedWall) / 1000)), 1000);
    let inFlight = false;
    let unreachable = false;
    const handle = window.setInterval(async () => {
      if (!mounted.current || inFlight) return;
      inFlight = true;
      try {
        const expired = isPollExpired(startedWall, Date.now(), CLIENT_LIMIT_MS);
        let st;
        try {
          st = await window.api.accountsSeatStatus({ seatId });
          unreachable = false;
        } catch {
          unreachable = true;
          if (!expired) return; // box transiently unreachable — keep polling
        }
        if (!mounted.current) return;
        if (!st || st.state === "pending") {
          if (!expired) return;
          // Past the box's own deadline and it still has nothing: only now is
          // the sign-in abandoned (the box dropped it too, or this releases it).
          window.clearInterval(handle);
          openSeatRef.current = null;
          void window.api.accountsCancelSeat({ seatId }).catch(() => {});
          set({
            kind: "failed",
            message: unreachable
              ? "Couldn't reach the server to check the sign-in. If you finished it, the seat will appear in the list once the box is reachable."
              : seatFailureMessage(undefined, true),
          });
          return;
        }
        window.clearInterval(handle);
        if (st.state === "ok") {
          openSeatRef.current = null;
          await finishAdded(st.seat?.id ?? seatId, st.seat?.label ?? "the new seat");
          return;
        }
        // failed
        if (st.error === "different-org") {
          set({ kind: "different-org", seatId, orgName: st.orgName, busy: false });
          return;
        }
        openSeatRef.current = null; // the box already dropped it
        set({
          kind: "failed",
          message: seatFailureMessage(st.error, Date.now() - startedWall >= SERVER_LOGIN_LIMIT_MS),
        });
      } finally {
        inFlight = false;
      }
    }, SEAT_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(handle);
      window.clearInterval(tick);
    };
  }, [seatId, set, finishAdded]);

  // A sign-in that EXITS with an error (a wrong or expired code) will never
  // produce credentials: fail now instead of leaving Submit spinning until the
  // 15-minute deadline. A clean exit is a successful login — keep waiting for
  // the box to file the seat.
  const sessionKey = phase.kind === "claude" ? phase.sessionKey : null;
  useEffect(() => {
    if (!sessionKey) return;
    return window.api.onPtyEvent((ev) => {
      if (ev.sessionKey !== sessionKey || ev.kind !== "exit" || ev.code === 0) return;
      const open = openSeatRef.current;
      openSeatRef.current = null;
      if (open) void window.api.accountsCancelSeat({ seatId: open }).catch(() => {});
      set({ kind: "failed", message: "That code didn't work (it may have expired). Start the sign-in again." });
    });
  }, [sessionKey, set]);

  // Any phase other than "claude" (or unmount) ends a pending Submit.
  useEffect(() => {
    if (phase.kind === "claude" && !phase.inputError) return;
    settleRef.current?.();
    settleRef.current = null;
  }, [phase]);
  useEffect(() => () => settleRef.current?.(), []);

  // done is terminal — report once.
  useEffect(() => {
    if (phase.kind !== "done" || reportedRef.current) return;
    reportedRef.current = true;
    onDone(phase.message);
  }, [phase, onDone]);

  // The explicit Cancel / ×: abort on the box, say so if that fails, close.
  const cancel = useCallback(async () => {
    const open = openSeatRef.current;
    openSeatRef.current = null;
    if (open) {
      try {
        await window.api.accountsCancelSeat({ seatId: open });
      } catch {
        useStore.getState().pushAppToast({
          message: "Couldn't cancel the sign-in on the server — it will expire by itself.",
          tone: "error",
        });
      }
    }
    onCancel();
  }, [onCancel]);

  const createNewAccount = useCallback(async () => {
    if (phase.kind !== "different-org" || phase.busy) return;
    const { seatId: sid, orgName } = phase;
    set({ kind: "different-org", seatId: sid, orgName, busy: true });
    try {
      const res = providerViewOrError(await window.api.accountsAddSeatConfirm({ seatId: sid, newAccount: true }));
      if ("error" in res) {
        set({ kind: "different-org", seatId: sid, orgName, busy: false });
        useStore.getState().pushAppToast({ message: res.error, tone: "error" });
        return;
      }
      openSeatRef.current = null;
      useStore.getState().upsertProviderView(res.view);
      await finishAdded(sid, orgName ?? "the new account", { newAccount: true, accountName: orgName ?? undefined });
    } catch {
      set({ kind: "different-org", seatId: sid, orgName, busy: false });
      useStore.getState().pushAppToast({
        message: "Couldn't create the account — the server didn't answer. Try again.",
        tone: "error",
      });
    }
  }, [phase, set, finishAdded]);

  const title = accountId ? `Add a seat to ${accountLabel ?? "this account"}` : `Add a ${label} account`;

  return (
    <div className="rounded-sm border bg-bg-elev px-3 py-2 text-meta space-y-2" data-testid="add-seat-flow">
      <div className="flex items-center gap-2">
        <span className="text-text">{title}</span>
        <button
          type="button"
          onClick={() => void cancel()}
          className="ml-auto px-2 rounded-xs text-text-faint hover:text-text-muted inline-flex items-center"
          title="Cancel"
          aria-label="Cancel"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {phase.kind === "starting" && <div className="text-text-muted">Preparing sign-in…</div>}

      {phase.kind === "claude" && (
        <ClaudeLoginBlock
          ptySessionKey={phase.sessionKey}
          cwd={phase.cwd}
          url={phase.url}
          preExisting={false}
          inputError={phase.inputError}
          onUrlDetected={(url) => set({ ...phase, url, inputError: undefined })}
          onSubmitCode={async (code) => {
            const trimmed = code.trim();
            if (!trimmed) return;
            try {
              await window.api.ptyWrite(phase.sessionKey, trimmed + "\r");
              if (phase.inputError) set({ ...phase, inputError: undefined });
            } catch {
              set({ ...phase, inputError: "Couldn't reach the server. Try again." });
              return;
            }
            // Stay "Saving…" until the box has filed the seat AND the list has
            // refreshed to show it (or the sign-in failed) — the poll above
            // drives the phase; the effect resolves this.
            await new Promise<void>((resolve) => {
              settleRef.current?.();
              settleRef.current = resolve;
            });
          }}
        />
      )}

      {phase.kind === "device" && (
        <ProcessPanel
          stages={["Waiting for sign-in"]}
          activeIndex={0}
          status="running"
          elapsedSeconds={elapsed}
          logLines={[]}
          remainingLabel={formatRemaining(0, elapsed * 1000, SERVER_LOGIN_LIMIT_MS)}
          onCancel={() => void cancel()}
        >
          <WaitingBlockBody url={phase.url} instructions={phase.instructions} />
        </ProcessPanel>
      )}

      {phase.kind === "different-org" && (
        <div className="space-y-2">
          <Callout tone="warn">
            That sign-in belongs to a different organization
            {phase.orgName ? ` (${phase.orgName})` : ""}, so it can't join{" "}
            {accountLabel ? `“${accountLabel}”` : "this account"}. Create a new account for it?
          </Callout>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void createNewAccount()}
              disabled={phase.busy}
              className="px-2 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text hover:text-text disabled:opacity-40"
            >
              {phase.busy ? "…" : "Create new account"}
            </button>
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={phase.busy}
              className="px-2 py-1 text-meta text-text-faint hover:text-text disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase.kind === "done" && <div className="text-ok" role="status">{phase.message}</div>}

      {phase.kind === "failed" && (
        <div className="space-y-2">
          <Callout tone="danger">{phase.message}</Callout>
          <button
            type="button"
            onClick={() => setEpoch((e) => e + 1)}
            className="px-2 py-1 border border-border rounded-xs text-text-muted hover:text-text"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

// The box answers the SAME `connect` shape the existing flow does. Claude
// drives a terminal (`claude auth login` with the seat's config dir); the OAuth
// device flow shows a link + code. Anything else cannot be driven from here.
export function phaseFromConnect(seatId: string, c: SeatConnect): Phase {
  if (c.shape === "claude-login" && typeof c.sessionKey === "string" && c.sessionKey) {
    return { kind: "claude", seatId, sessionKey: c.sessionKey, cwd: typeof c.cwd === "string" ? c.cwd : "~", url: "" };
  }
  if (c.shape === "oauth-auto") {
    return {
      kind: "device",
      seatId,
      url: typeof c.url === "string" ? c.url : "",
      instructions: typeof c.instructions === "string" ? c.instructions : "",
    };
  }
  return { kind: "failed", message: "This provider's sign-in can't be started from here yet." };
}

/**
 * "Add an account / a seat" as ONE control, used by the seats panel and by the
 * subscription row's Connect: the terms note (shown once, when a SECOND account
 * is added — spec §0) sits inline with the action and proceeds straight into the
 * sign-in; there is no state in which the action is hidden behind the note.
 */
export function AddSeatGate({
  provider,
  view,
  accountId,
  accountLabel,
  onDone,
  onCancel,
}: {
  provider: SeatProviderId;
  view: ProviderView | null;
  accountId?: string;
  accountLabel?: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [noteShown, setNoteShown] = useState(() => !accountId && needsSecondAccountNote(view, readTosAck()));
  if (noteShown) {
    return (
      <div className="space-y-2" data-testid="add-seat-tos">
        <Callout tone="warn">{SEAT_TOS_NOTE}</Callout>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="px-2 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text-muted hover:text-text"
            onClick={() => {
              try {
                window.localStorage.setItem(TOS_ACK_KEY, "1");
              } catch {
                /* the note simply shows again next time */
              }
              setNoteShown(false);
            }}
          >
            I understand
          </button>
          <button type="button" className="text-meta text-text-faint hover:text-text" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return <AddSeatFlow provider={provider} accountId={accountId} accountLabel={accountLabel} onDone={onDone} onCancel={onCancel} />;
}
