// Pure logic for the session's pending-message inbox (OpenCode V2 cleanup spec
// §1 K3/K4 + §2 Behaviour). No React, no window.api — everything here is
// unit-tested in inboxState.test.ts.
//
//   - the K3 client acceptance rule (epoch / rev / retired epochs / resync),
//   - the busy-send decision (which path a send takes while a turn runs),
//   - the K4 cancel outcome → what the user sees.

import type { OpencodeInboxCancelResult, OpencodeInboxItem, OpencodeInboxSnapshot } from "../shared/types";

// ===== K3 acceptance rule =====

export type InboxShown = OpencodeInboxSnapshot;

/** Narrow an unknown RPC result / frame payload to a snapshot, or null. */
export function parseInboxSnapshot(raw: unknown): InboxShown | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { epoch?: unknown; rev?: unknown; items?: unknown };
  if (typeof r.epoch !== "string" || r.epoch === "") return null;
  if (typeof r.rev !== "number" || !Number.isFinite(r.rev)) return null;
  if (!Array.isArray(r.items)) return null;
  const items = r.items.filter(
    (i): i is OpencodeInboxItem =>
      !!i && typeof i === "object" && typeof (i as { id?: unknown }).id === "string",
  );
  return { epoch: r.epoch, rev: r.rev, items };
}

/**
 * The client-wide set of epochs known to belong to a dead manta-server
 * process. Shared by every panel: a restarted server is newer by definition,
 * and once ANY panel has seen the new epoch nothing from the old one may land
 * anywhere.
 */
const retiredEpochs = new Set<string>();

/** Test seam only. */
export function resetRetiredInboxEpochs(): void {
  retiredEpochs.clear();
}

/**
 * K3: should `incoming` replace `shown`?
 *  - retired epoch → never;
 *  - same epoch → only a higher rev;
 *  - a new, non-retired epoch → yes, and the previous epoch is retired.
 * Returns the state to show (`shown` itself when the payload is dropped).
 */
export function acceptInbox(
  shown: InboxShown | null,
  incoming: InboxShown | null,
  retired: Set<string> = retiredEpochs,
): { next: InboxShown | null; accepted: boolean } {
  if (!incoming) return { next: shown, accepted: false };
  if (retired.has(incoming.epoch)) return { next: shown, accepted: false };
  if (!shown) return { next: incoming, accepted: true };
  if (incoming.epoch === shown.epoch) {
    return incoming.rev > shown.rev ? { next: incoming, accepted: true } : { next: shown, accepted: false };
  }
  retired.add(shown.epoch);
  return { next: incoming, accepted: true };
}

export type InboxTracker = {
  /** What is currently shown. */
  shown(): InboxShown | null;
  /** A pushed `inbox` frame. True when it replaced the shown list. */
  offerFrame(payload: unknown): boolean;
  /** Stamp a request (`opencode:inbox`) at the moment it is issued. */
  beginRequest(): number;
  /** The request's response. Dropped when a `resync` happened after it was issued, or the tracker is disposed. */
  offerResponse(stamp: number, payload: unknown): boolean;
  /** The events socket reconnected: every answer still in flight is now stale. */
  markResync(): void;
  /** The panel stopped showing this session: nothing may land any more. */
  dispose(): void;
};

/** One tracker per panel-session; `dispose` is what drops a late answer for a session the panel no longer shows. */
export function createInboxTracker(
  onChange: (items: OpencodeInboxItem[]) => void,
  retired: Set<string> = retiredEpochs,
): InboxTracker {
  let shown: InboxShown | null = null;
  let gen = 0;
  let disposed = false;
  const offer = (payload: unknown): boolean => {
    if (disposed) return false;
    const r = acceptInbox(shown, parseInboxSnapshot(payload), retired);
    if (!r.accepted) return false;
    shown = r.next;
    onChange(shown ? shown.items : []);
    return true;
  };
  return {
    shown: () => shown,
    offerFrame: offer,
    beginRequest: () => gen,
    offerResponse: (stamp, payload) => (stamp !== gen ? false : offer(payload)),
    markResync: () => {
      gen += 1;
    },
    dispose: () => {
      disposed = true;
    },
  };
}

// ===== Busy send =====

export type BusySendPlan =
  | { kind: "refuse"; message: string }
  | { kind: "command"; name: string; args: string }
  | { kind: "prompt" };

/**
 * What a send does while the agent is working. Local slash commands (the ones
 * the composer handles itself) are refused with a visible message — never run
 * mid-turn, never dropped silently; an opencode command goes as a steered
 * command; everything else is a steered prompt.
 */
export function planBusySend(
  text: string,
  localCommandNames: ReadonlySet<string>,
  knownCommands: ReadonlyArray<{ name: string }> | null | undefined,
): BusySendPlan {
  const m = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return { kind: "prompt" };
  const name = m[1];
  if (localCommandNames.has(name)) {
    return { kind: "refuse", message: `Stop the agent or wait for it to finish before /${name}` };
  }
  if (knownCommands?.some((c) => c.name === name)) {
    return { kind: "command", name, args: m[2] ?? "" };
  }
  return { kind: "prompt" };
}

/**
 * After a successful busy send: clear the composer only if it still holds
 * EXACTLY the submitted draft; otherwise leave the user's newer text alone
 * (the submitted attachments are removed either way, by the caller).
 */
export function shouldClearDraft(submittedDraft: string | null, currentText: string): boolean {
  return submittedDraft !== null && submittedDraft === currentText;
}

// ===== Pending card =====

/** The composer's hint row while the agent runs (session surface only). */
export function busySendHint(isMac: boolean): string {
  return isMac ? "⏎ send now · ⌥⏎ after this turn" : "⏎ send now · Alt+⏎ after this turn";
}

/** The composer placeholder while the agent runs (session surface; the CTO passes its own). */
export const BUSY_PLACEHOLDER = "Message the agent…";

/** "Pending · 1 message" / "Pending · 3 messages". */
export function pendingHeaderText(count: number): string {
  return `Pending · ${count} ${count === 1 ? "message" : "messages"}`;
}

/** The row badge: a steer item reaches the agent at its next step, a queue item waits for the turn to end. */
export function inboxBadgeLabel(item: Pick<OpencodeInboxItem, "delivery">): "Now" | "After this turn" {
  return item.delivery === "steer" ? "Now" : "After this turn";
}

/** The quiet note on a Now row; After rows carry none (their action is Send now). */
export function inboxRowNote(item: Pick<OpencodeInboxItem, "delivery">, running: boolean): string | null {
  if (item.delivery !== "steer") return null;
  return running ? "at next step" : "runs next";
}

/** The stopped footer: the agent is not running and at least one After item is still parked. */
export function showStoppedFooter(items: ReadonlyArray<Pick<OpencodeInboxItem, "delivery">>, running: boolean): boolean {
  return !running && items.some((i) => i.delivery === "queue");
}

export const STOPPED_FOOTER_TEXT = "Agent stopped — these are waiting. Send now, or ×.";
export const SET_DELIVERY_UNCONFIRMED = "Couldn't confirm the change — check the pending list";

/** N1: the result of `opencode:inbox-set-delivery`. */
export type InboxSetDeliveryResult = { outcome: "changed" | "delivered" | "unknown" };

/**
 * Turn an N1 result into what the user sees. `changed` needs nothing (the next
 * inbox frame flips the badge); `delivered` is a toast; anything else —
 * `unknown`, or a malformed answer — is an error banner. Never silent.
 */
export function describeInboxSetDelivery(
  result: InboxSetDeliveryResult | null | undefined,
): { error: string | null; notice: string | null } {
  switch (result?.outcome) {
    case "changed":
      return { error: null, notice: null };
    case "delivered":
      return { error: null, notice: "Already sent to the agent" };
    default:
      return { error: SET_DELIVERY_UNCONFIRMED, notice: null };
  }
}

// ===== Cancel outcome =====

export const ATTACHMENTS_NOT_RESTORED = "Attachments weren't restored — re-attach them";

export type InboxCancelReport = {
  /** Text to put back in the composer (only with `cancelled`, and only when the gesture asked to restore). */
  restoreText: string | null;
  /** A failure / uncertainty the user must see (error banner). */
  error: string | null;
  /** A neutral notice (toast). */
  notice: string | null;
};

/**
 * Turn a K4 cancel result into what the user sees. Only `cancelled` proves the
 * message will not be sent, so only it may restore text — restoring after
 * `unknown` could make the user send it twice.
 */
export function describeInboxCancel(
  result: OpencodeInboxCancelResult | null | undefined,
  item: OpencodeInboxItem,
  opts: { restore: boolean },
): InboxCancelReport {
  switch (result?.outcome) {
    case "cancelled": {
      const cancelled = result.item ?? item;
      const lost = opts.restore && cancelled.attachmentCount > 0;
      return {
        restoreText: opts.restore ? cancelled.text : null,
        error: null,
        notice: lost ? ATTACHMENTS_NOT_RESTORED : null,
      };
    }
    case "delivered":
      return { restoreText: null, error: null, notice: "Already sent to the agent" };
    default:
      return {
        restoreText: null,
        error: "Couldn't confirm it was cancelled — it may still be sent",
        notice: null,
      };
  }
}
