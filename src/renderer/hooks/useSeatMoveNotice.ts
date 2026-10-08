// The "moved to another seat" notice for ONE conversation (multi-account, spec
// §5.3 last paragraph). Two sources, one line:
//   - the box's `accounts.moved` bus event for this conversation (instant), and
//   - the conversation's `lastMove` from accounts:session-seat, so a move that
//     happened while the chat was closed still shows on open if it is < 30 min old.
// The same move arrives from both with different clocks, so they are matched by
// (conversation, from-seat, to-seat) — never by timestamp — and a dismissal /
// auto-hide is remembered under that key. Dismissals live at module level so
// switching to another conversation and back does not resurrect the line.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useStore } from "../store";
import { refreshSessionSeat } from "../accountsData";
import {
  SEAT_MOVE_NOTICE_AUTOHIDE_MS,
  SEAT_MOVE_NOTICE_FRESH_MS,
  formatSeatMoveNotice,
  findSeat,
  hasSeatChoice,
  seatDisplayName,
  seatMoveNoticeKey,
} from "../chatUtils";
import type { AccountsMovedPayload } from "../../shared/types";

const hiddenKeys = new Set<string>();

type Candidate = {
  key: string;
  at: number;
  from?: string;
  to?: string;
  provider?: string;
  fromLabel?: string;
  toLabel?: string;
  reason?: string;
  trigger?: { kind: string; pct: number };
  crossOrg?: boolean;
};

export function useSeatMoveNotice(sessionId: string): { text: string | null; dismiss: () => void } {
  const sessionSeat = useStore((s) => s.sessionSeats[sessionId] ?? null);
  const accounts = useStore((s) => s.accounts);
  const multi = accounts.some((p) => hasSeatChoice(p));
  const [live, setLive] = useState<Candidate | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  // Learn the conversation's seat (and its lastMove) on open. Only a box with a
  // real seat choice can have moved anything.
  useEffect(() => {
    if (multi && sessionId) void refreshSessionSeat(sessionId);
  }, [multi, sessionId]);

  useEffect(() => {
    setLive(null);
    if (!window.api.onAccountsMoved) return;
    return window.api.onAccountsMoved((p: AccountsMovedPayload) => {
      if (!sessionId || p.sessionId !== sessionId) return;
      const key = seatMoveNoticeKey(sessionId, p.from, p.to);
      // A fresh move event un-hides an earlier identical hop.
      hiddenKeys.delete(key);
      setLive({
        key,
        at: Date.now(),
        from: p.from,
        to: p.to,
        provider: p.provider,
        fromLabel: p.fromLabel,
        toLabel: p.toLabel,
        reason: p.reason,
        trigger: p.trigger,
        crossOrg: p.crossOrg,
      });
      rerender();
    });
  }, [sessionId]);

  // Candidate from the box's record.
  const now = Date.now();
  const last = sessionSeat?.lastMove;
  let stored: Candidate | null = null;
  if (sessionSeat && last && Number.isFinite(last.at) && now - last.at < SEAT_MOVE_NOTICE_FRESH_MS) {
    stored = {
      key: seatMoveNoticeKey(sessionId, last.from, sessionSeat.seatId),
      at: last.at,
      from: last.from,
      to: sessionSeat.seatId,
      provider: sessionSeat.provider,
      fromLabel: last.fromLabel,
      reason: last.reason,
      trigger: last.trigger,
      crossOrg: last.crossOrg,
    };
  }
  let cand: Candidate | null = null;
  if (live && stored && live.key === stored.key) {
    // Same move seen twice: the box's record wins where it has a value.
    cand = {
      ...live,
      ...Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined)),
    } as Candidate;
  } else {
    cand = live && (!stored || live.at >= stored.at) ? live : stored;
  }

  const key = cand && !hiddenKeys.has(cand.key) ? cand.key : null;
  const keyRef = useRef<string | null>(null);
  keyRef.current = key;

  // Auto-hide 5 minutes after the line first shows (a handover from the event
  // to the stored record keeps the same key, so the timer is not restarted).
  useEffect(() => {
    if (!key) return;
    const t = setTimeout(() => {
      hiddenKeys.add(key);
      rerender();
    }, SEAT_MOVE_NOTICE_AUTOHIDE_MS);
    return () => clearTimeout(t);
  }, [key]);

  const dismiss = useCallback(() => {
    if (keyRef.current) hiddenKeys.add(keyRef.current);
    rerender();
  }, []);

  if (!cand || !key) return { text: null, dismiss };
  const provider = cand.provider ?? sessionSeat?.provider ?? "claude";
  const toLabel =
    cand.toLabel ||
    (cand.to
      ? seatDisplayName(
          accounts,
          provider,
          cand.to,
          sessionSeat?.seatId === cand.to ? sessionSeat.accountLabel : null,
          sessionSeat?.seatId === cand.to ? sessionSeat.seatLabel : null,
        )
      : "");
  // The seat it left: the box's label, else the live view's short seat name.
  const fromLabel =
    cand.fromLabel ||
    (cand.from ? findSeat(accounts.find((p) => p.provider === provider), cand.from)?.seat.label : "") ||
    "";
  return {
    text: formatSeatMoveNotice({
      reason: cand.reason,
      fromLabel,
      toLabel,
      trigger: cand.trigger,
      crossOrg: cand.crossOrg,
    }),
    dismiss,
  };
}

/** Test seam: forget every dismissal. */
export function resetSeatMoveNoticeForTests(): void {
  hiddenKeys.clear();
}
