// ===== Auto-handoff — card actions =====
//
// What pressing a card's buttons does. Context-free on purpose: the inline
// `handoff` tool part sits deep inside the memoized transcript tree and the
// pinned card sits above the composer, and both must act the same way. Every
// function here either resolves with its effect done or REJECTS with wording the
// card shows — nothing swallows an error (AGENTS.md "never stub a control").

import type { HandoffHow, HandoffMode, HandoffRecord } from "../shared/api";
import { announceRecord, applyRecord, loadSession, patchSessionInfo, useHandoffStore } from "./handoffStore";
import { describeHandoffError, describeRewriteError } from "./handoff";
import { getMantaPreload } from "./preloadAccess";
import { resolveSessionOwner, useStore } from "./store";

const COMMIT_WAIT_MS = 30_000;
const WINDOW_RETRIES = 3;

/** Copy the raw handoff markdown. Rejects when neither the OS bridge nor the browser clipboard accepts it. */
export async function copyHandoffText(text: string): Promise<void> {
  const preload = getMantaPreload();
  if (preload?.clipboardWriteText) {
    await preload.clipboardWriteText(text);
    return;
  }
  if (!navigator.clipboard?.writeText) throw new Error("The clipboard isn't available here.");
  await navigator.clipboard.writeText(text);
}

/** Resolves when `id` reaches `committed`; rejects on `failed`/`cancelled` or after the wait. */
function waitForCommit(id: string, timeoutMs = COMMIT_WAIT_MS): Promise<HandoffRecord> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): boolean => {
      const rec = useHandoffStore.getState().records[id]?.record;
      if (!rec) return false;
      if (rec.state === "committed") {
        resolve(rec);
        return true;
      }
      if (rec.state === "failed" || rec.state === "cancelled") {
        reject(new Error(rec.reason || "The handoff didn't start."));
        return true;
      }
      return false;
    };
    if (settle()) return;
    const off = useHandoffStore.subscribe(() => {
      if (settle()) {
        off();
        if (timer) clearTimeout(timer);
      }
    });
    timer = setTimeout(() => {
      off();
      reject(new Error("Still starting — it will finish in the background."));
    }, timeoutMs);
  });
}

/** Bring the window that owns `sessionId` to the front, refreshing the window list if it isn't there yet. */
export async function openSessionWindow(sessionId: string): Promise<void> {
  const find = () => resolveSessionOwner(useStore.getState().projects, sessionId);
  let owner = find();
  for (let i = 0; !owner && i < WINDOW_RETRIES; i++) {
    await useStore.getState().refresh();
    owner = find();
    if (!owner) await new Promise((r) => setTimeout(r, 400));
  }
  if (!owner) throw new Error("The new session's window isn't listed yet — find it in the sidebar.");
  await useStore.getState().activateWindow(owner.tmuxSession, owner.windowIndex);
}

/**
 * Start a ready handoff. Replacement: the pane showing the predecessor switches
 * itself on the commit event (HandoffPanel reconcile) — here we only make sure
 * that event exists even if the bus dropped it. Branch: only THIS client
 * switches, to the new window.
 */
export async function startHandoff(
  record: HandoffRecord,
  how: HandoffHow,
  disposition: "send" | "draft",
): Promise<void> {
  let started: HandoffRecord;
  try {
    const res = await window.api.handoffStart({ id: record.id, how, disposition });
    if (!res?.handoff) throw new Error("The box didn't return the handoff.");
    started = res.handoff;
  } catch (e) {
    // A start that lost a race: show what the record is now.
    if (/already_started/i.test(String((e as Error)?.message ?? e))) {
      const res = await window.api.handoffGet({ id: record.id }).catch(() => null);
      if (res?.handoff) applyRecord(res.handoff);
    }
    throw new Error(describeHandoffError(e));
  }
  applyRecord(started);
  const committed = started.state === "committed" ? started : await waitForCommit(started.id);
  if (how === "clear") {
    announceRecord(committed);
    return;
  }
  if (!committed.successorId) throw new Error("The new session was started, but the box didn't name it.");
  await openSessionWindow(committed.successorId);
}

/** Retry a failed handoff: the box regenerates if needed and returns it to `ready`. */
export async function retryHandoff(id: string): Promise<void> {
  try {
    const res = await window.api.handoffRetry({ id });
    if (!res?.handoff) throw new Error("The box didn't return the handoff.");
    applyRecord(res.handoff);
  } catch (e) {
    throw new Error(describeHandoffError(e));
  }
}

/**
 * Rewrite a ready/failed handoff in the session itself (the expensive path the
 * card prices on its button). The box answers with the record now `generating`;
 * its settle arrives on the bus. Rejects with the box's own sentence (busy, not
 * ready, …) so the card can show why nothing happened.
 */
export async function rewriteHandoff(id: string): Promise<void> {
  try {
    const res = await window.api.handoffRewrite({ id });
    if (!res?.handoff) throw new Error("The box didn't return the handoff.");
    applyRecord(res.handoff);
  } catch (e) {
    throw new Error(describeRewriteError(e));
  }
}

/**
 * Dismiss a ready/failed card: the box hides it and stops proposing handoffs in
 * that session. The card goes away from the record we get back; the session is
 * refetched so its `dismissed` flag follows.
 */
export async function dismissHandoff(id: string): Promise<void> {
  let dismissed: HandoffRecord;
  try {
    const res = await window.api.handoffDismiss({ id });
    if (!res?.handoff) throw new Error("The box didn't return the handoff.");
    dismissed = res.handoff;
  } catch (e) {
    throw new Error(describeHandoffError(e));
  }
  applyRecord(dismissed);
  await loadSession(dismissed.fromSessionId);
}

/**
 * Set one session's handoff mode (never the box default). Optimistic: the
 * toggle shows `mode` at once and is rolled back if the box refuses.
 */
export async function setSessionHandoffMode(sessionId: string, mode: HandoffMode): Promise<void> {
  const prev = useHandoffStore.getState().sessions[sessionId]?.info;
  patchSessionInfo(sessionId, { mode, modeIsDefault: false });
  try {
    const res = await window.api.handoffSetMode({ sessionId, mode });
    patchSessionInfo(sessionId, { mode: res?.mode ?? mode, modeIsDefault: false });
  } catch (e) {
    patchSessionInfo(sessionId, { mode: prev?.mode, modeIsDefault: prev?.modeIsDefault });
    throw e;
  }
}

/** `/handoff [goal]` and the "Hand off" button: always lands a `ready` card (spec §4.1). */
export async function createHandoff(input: {
  sessionId: string;
  trigger: "user" | "button";
  goal?: string;
}): Promise<HandoffRecord> {
  try {
    const goal = input.goal?.trim();
    const res = await window.api.handoffCreate({
      sessionId: input.sessionId,
      trigger: input.trigger,
      action: "suggest",
      ...(goal ? { goal } : {}),
    });
    if (!res?.handoff) throw new Error("The box didn't return the handoff.");
    applyRecord(res.handoff);
    return res.handoff;
  } catch (e) {
    throw new Error(describeHandoffError(e));
  }
}
