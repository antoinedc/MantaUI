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
//                      └─ login-failed .. failed      (Try again)
//
// Every press ends in one of the three legal outcomes (AGENTS.md): it does the
// thing and says so, it fails and says why, or the control is not there.
// Cancel (and closing the card) tells the box to abort the half-made seat.

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { SeatConnect, SeatProviderId } from "../shared/types";
import { accountsErrorMessage, formatRemaining, isPollExpired, providerViewOrError } from "./chatUtils";
import { providerLabel } from "./UsageDial";
import { ClaudeLoginBlock, WaitingBlockBody } from "./ConnectProvider";
import { ProcessPanel } from "./ProcessPanel";
import { Callout } from "./Callout";
import { useStore } from "./store";
import { refreshAccounts } from "./accountsData";

const SEAT_POLL_INTERVAL_MS = 2_000;
// Matches the connect flow's caps: the Claude paste-back and the device-code
// wait. The box owns the real deadline; this only stops an unbounded poll.
const CLAUDE_LIMIT_MS = 5 * 60 * 1_000;
const DEVICE_LIMIT_MS = 15 * 60 * 1_000;

type Phase =
  | { kind: "starting" }
  | { kind: "claude"; seatId: string; sessionKey: string; cwd: string; url: string; inputError?: string }
  | { kind: "device"; seatId: string; url: string; instructions: string }
  | { kind: "different-org"; seatId: string; orgName?: string; busy: boolean }
  | { kind: "done"; label: string }
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
  const limit = phase.kind === "claude" ? CLAUDE_LIMIT_MS : DEVICE_LIMIT_MS;

  // 2. While signing in, poll the box for the verdict.
  useEffect(() => {
    if (!seatId) return;
    const startedWall = Date.now();
    setElapsed(0);
    const tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedWall) / 1000)), 1000);
    const handle = window.setInterval(async () => {
      if (!mounted.current) return;
      if (isPollExpired(startedWall, Date.now(), limit)) {
        window.clearInterval(handle);
        openSeatRef.current = null;
        void window.api.accountsCancelSeat({ seatId }).catch(() => {});
        set({ kind: "failed", message: "The sign-in didn't complete in time. Try again." });
        return;
      }
      let st;
      try {
        st = await window.api.accountsSeatStatus({ seatId });
      } catch {
        return; // box transiently unreachable — keep polling
      }
      if (!mounted.current || !st) return;
      if (st.state === "pending") return;
      window.clearInterval(handle);
      if (st.state === "ok") {
        openSeatRef.current = null;
        void refreshAccounts();
        const name = st.seat?.label ?? "the new seat";
        set({ kind: "done", label: name });
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
        message:
          st.error === "duplicate-login"
            ? "That login is already added as a seat. Sign in with a different account."
            : "The sign-in didn't complete. Try again.",
      });
    }, SEAT_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(handle);
      window.clearInterval(tick);
    };
  }, [seatId, limit, set]);

  // done is terminal — report once.
  useEffect(() => {
    if (phase.kind !== "done") return;
    onDone(`Added ${phase.label} to ${label}.`);
  }, [phase, label, onDone]);

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
      set({ kind: "done", label: orgName ?? "the new account" });
    } catch {
      set({ kind: "different-org", seatId: sid, orgName, busy: false });
      useStore.getState().pushAppToast({
        message: "Couldn't create the account — the server didn't answer. Try again.",
        tone: "error",
      });
    }
  }, [phase, set]);

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
            }
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
          remainingLabel={formatRemaining(0, elapsed * 1000, DEVICE_LIMIT_MS)}
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

      {phase.kind === "done" && <div className="text-ok">Added {phase.label}.</div>}

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
