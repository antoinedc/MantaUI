// ===== Background-job approval card — report the outcome of Approve / Decline =====
//
// The card used to hide first and fire-and-forget the RPC: a rejection was
// swallowed, the box's `{ok:false}` was never read, and the poll re-showed the
// card a few seconds later with no explanation. This module is the one place a
// press ends in a visible outcome, without asserting anything the wire cannot
// establish (`ok:false` means "the box has no such pending approval" — expired,
// answered from another client, or already resolved by an earlier request of
// ours whose reply was lost; it is NOT proof that no job started).

import type { DelegateApproval, DelegateApprovalTool } from "../shared/types";
import { useStore } from "./store";

export type ApprovalDecisionKind = "approve" | "decline";

/** `done` — the box applied it. `unavailable` — the box has no such pending
 *  approval (reason unknown). `unconfirmed` — the call rejected (network, auth,
 *  HTTP, timeout) or the reply was malformed: the box may or may not have
 *  applied it. */
export type ApprovalDecisionOutcome = "done" | "unavailable" | "unconfirmed" | "refused";
// `refused` — the box rejected the submitted rules (`{ok:false, error}`, e.g. an
// empty/blank rule) and STILL holds the approval pending: the caller shows the
// box's message on the card and lets the user fix and retry. No toast.

export const APPROVAL_FEEDBACK_COPY = {
  declineUnavailable:
    "This approval is no longer available. Check background jobs to see whether it was already started.",
  approveUnavailable:
    "This approval is no longer available. Check background jobs before trying to start it again.",
  declineUnconfirmed:
    "Couldn’t confirm that the background job was declined. Check background jobs before trying again.",
  approveUnconfirmed:
    "Couldn’t confirm that the background job was started. Check background jobs before trying again.",
} as const;

export function classifyApprovalReply(reply: unknown): ApprovalDecisionOutcome {
  const r = reply as { ok?: unknown; error?: unknown } | null | undefined;
  const ok = r?.ok;
  if (ok === true) return "done";
  if (ok === false) return typeof r?.error === "string" && r.error ? "refused" : "unavailable";
  return "unconfirmed";
}

/**
 * Run a decision RPC, classify the result and push the toast. Never throws — a
 * failure is a toast plus an `unconfirmed` outcome the caller turns into a
 * retryable card. `done` is silent: the card disappearing (Decline) or the job
 * appearing as a background session (Approve) is the visible result.
 */
export async function settleApprovalDecision(
  kind: ApprovalDecisionKind,
  call: () => Promise<unknown>,
): Promise<ApprovalDecisionOutcome> {
  let outcome: ApprovalDecisionOutcome;
  try {
    outcome = classifyApprovalReply(await call());
  } catch {
    outcome = "unconfirmed";
  }
  if (outcome === "done" || outcome === "refused") return outcome;
  const { pushAppToast } = useStore.getState();
  if (outcome === "unavailable") {
    if (kind === "decline") pushAppToast({ message: APPROVAL_FEEDBACK_COPY.declineUnavailable });
    else pushAppToast({ tone: "error", message: APPROVAL_FEEDBACK_COPY.approveUnavailable });
  } else {
    pushAppToast({
      tone: "error",
      message: kind === "decline" ? APPROVAL_FEEDBACK_COPY.declineUnconfirmed : APPROVAL_FEEDBACK_COPY.approveUnconfirmed,
    });
  }
  return outcome;
}

/** Per-approval decision state: a decision is in flight, or it failed
 *  unconfirmed and the card may be shown again carrying the rules the user
 *  submitted (so a narrowed grant is never silently widened on retry). */
export type ApprovalDecisionState =
  | { state: "inflight" }
  | { state: "retry"; tools: DelegateApprovalTool[] };

export const copyTools = (tools: DelegateApprovalTool[]): DelegateApprovalTool[] =>
  tools.map((t) => ({ ...t }));

/**
 * Which approval the card should show after an (authoritative) poll.
 *  - an in-flight approval is never shown;
 *  - an empty/filtered list clears a displayed approval;
 *  - a retryable approval keeps the user's submitted rules over the box's;
 *  - the same id keeps its identity so the card's local edit state survives.
 */
export function nextPendingApproval(args: {
  current: DelegateApproval | null;
  polled: DelegateApproval[];
  decisions: ReadonlyMap<string, ApprovalDecisionState>;
}): DelegateApproval | null {
  const { current, polled, decisions } = args;
  const next = polled.find((a) => decisions.get(a.id)?.state !== "inflight");
  if (!next) return null;
  const decision = decisions.get(next.id);
  if (decision?.state === "retry") {
    if (current?.id === next.id) return current;
    return { ...next, tools: copyTools(decision.tools) };
  }
  if (current?.id === next.id) return current;
  return next;
}
