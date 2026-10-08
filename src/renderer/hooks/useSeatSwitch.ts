// useSeatSwitch — the manual-mode "Use this seat" action, shared by the usage
// popover's "Other seats" rows and Settings → Accounts so the two can never
// disagree about what a press does (spec §7 / §7a).
//
// A press is one of three legal outcomes (AGENTS.md "never stub a control"):
//   - same-org seat  → applied at once, success reported;
//   - cross-org seat → asks first (the whole history is re-sent once), then
//                      applies on confirm;
//   - failure        → the specific reason is reported; the list is unchanged.

import { useCallback, useState } from "react";
import type { ProviderView, SeatView } from "../../shared/types";
import { isSameOrgMove, providerViewOrError } from "../chatUtils";
import { useStore } from "../store";

export type SeatActionReport = { ok: boolean; text: string };

/** Default reporter: an app toast (success = info, failure = error). */
export function toastReport(r: SeatActionReport): void {
  useStore.getState().pushAppToast({ message: r.text, tone: r.ok ? "info" : "error" });
}

export const CROSS_ORG_CONFIRM_COPY =
  "Conversations will re-send their history once to the new seat.";

export function useSeatSwitch(
  view: ProviderView | null | undefined,
  report: (r: SeatActionReport) => void = toastReport,
) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const apply = useCallback(
    async (seat: SeatView) => {
      if (!view || busyId) return;
      setBusyId(seat.id);
      try {
        const res = providerViewOrError(
          await window.api.accountsSetActive({ provider: view.provider, seatId: seat.id }),
        );
        if ("error" in res) {
          report({ ok: false, text: `Couldn't switch to ${seat.label}. ${res.error}` });
        } else {
          useStore.getState().upsertProviderView(res.view);
          report({ ok: true, text: `All conversations now use ${seat.label}` });
        }
      } catch {
        report({ ok: false, text: `Couldn't switch to ${seat.label} — the server didn't answer. Try again.` });
      } finally {
        setBusyId(null);
        setConfirmId(null);
      }
    },
    [view, busyId, report],
  );

  /** The "Use" press: immediate for a same-org move, else ask first. */
  const request = useCallback(
    (seat: SeatView) => {
      if (!view || busyId) return;
      if (isSameOrgMove(view, view.activeSeatId, seat.id)) void apply(seat);
      else setConfirmId(seat.id);
    },
    [view, busyId, apply],
  );

  const cancel = useCallback(() => setConfirmId(null), []);

  return { busyId, confirmId, request, apply, cancel };
}
