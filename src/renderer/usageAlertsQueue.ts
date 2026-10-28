// usageAlertsQueue.ts — the client side of the box's usage-alert protocol
// (WS09 SF-M16). The box owns the alerts; frames are DELTAS and a snapshot
// (`usage:alerts`) is the authority, so this pure state machine keeps the two
// consistent: a snapshot is never discarded in favour of a frame, frames that
// arrive while a snapshot is pending are buffered and replayed on top of it, a
// late answer (older epoch) is ignored, and a revision gap / box restart /
// buffer overflow re-hydrates. Identical rules and cases to iOS
// `UsageAlertQueue` (mobile/native/MantaUI/UsageAlertsLogic.swift).

import type { UsageAlert, UsageAlertFrame, UsageAlertsList } from "../shared/types";

export const ALERT_BUFFER_CAP = 200;

export type QueueAction = "none" | "hydrate";

export type AlertQueue = {
  /** Begin (re)hydration: new epoch, buffer cleared. Tag the `usage:alerts` request with the returned epoch. */
  startHydration(): number;
  /** Apply a `usage:alerts` answer. `"hydrate"` = call startHydration() and request again. */
  applySnapshot(list: UsageAlertsList, epoch: number): QueueAction;
  /** Apply a `usage.alert` frame. `"hydrate"` = call startHydration() and request a snapshot. */
  applyFrame(frame: UsageAlertFrame): QueueAction;
  /** Close an alert: it leaves the queue but its id stays "seen" (it never re-shows). */
  dismiss(id: string): void;
  /** The alerts to show, oldest first. */
  visible(): UsageAlert[];
};

export function createAlertQueue(): AlertQueue {
  let phase: "hydrating" | "live" = "hydrating";
  let epoch = 0;
  let lastBootId: string | null = null;
  let lastRevision = 0;
  let buffer: UsageAlertFrame[] = [];
  // A frame that forced a re-hydration is re-buffered by the next startHydration().
  let carry: UsageAlertFrame | null = null;
  let queue: UsageAlert[] = [];
  const seen = new Set<string>();

  const enqueue = (a: UsageAlert) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    queue.push(a);
  };

  // Rule 4: a frame while live.
  const applyLive = (f: UsageAlertFrame): QueueAction => {
    if (f.bootId !== lastBootId) {
      carry = f;
      return "hydrate";
    }
    if (f.revision <= lastRevision) return "none";
    if (f.revision > lastRevision + 1) {
      carry = f;
      return "hydrate";
    }
    if (f.alert) enqueue(f.alert);
    if (f.retired) {
      const gone = new Set(f.retired);
      queue = queue.filter((a) => !gone.has(a.id));
    }
    lastRevision = f.revision;
    return "none";
  };

  return {
    startHydration() {
      epoch += 1;
      phase = "hydrating";
      buffer = carry ? [carry] : [];
      carry = null;
      return epoch;
    },

    applySnapshot(list, forEpoch) {
      if (forEpoch !== epoch) return "none"; // a late answer from an earlier request
      if (buffer.some((f) => f.bootId !== list.bootId)) return "hydrate"; // the box restarted mid-request
      const active = new Set(list.alerts.map((a) => a.id));
      queue = queue.filter((a) => active.has(a.id)); // retirements missed while disconnected
      for (const a of list.alerts) enqueue(a);
      lastBootId = list.bootId;
      lastRevision = list.revision;
      const pending = [...buffer].sort((a, b) => a.revision - b.revision);
      buffer = [];
      phase = "live";
      for (const f of pending) {
        if (f.revision <= lastRevision) continue; // already contained in the snapshot
        if (applyLive(f) === "hydrate") return "hydrate";
      }
      return "none";
    },

    applyFrame(frame) {
      if (phase === "hydrating") {
        buffer.push(frame);
        return buffer.length > ALERT_BUFFER_CAP ? "hydrate" : "none";
      }
      return applyLive(frame);
    },

    dismiss(id) {
      queue = queue.filter((a) => a.id !== id);
    },

    visible() {
      return [...queue];
    },
  };
}
