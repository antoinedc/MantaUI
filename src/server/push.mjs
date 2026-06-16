// push.mjs — Web Push (VAPID) for the mobile PWA.
//
// Sends notifications to home-screen-installed PWAs for the events a user
// can't otherwise see when the app is backgrounded/closed:
//   - permission.asked   → "Permission needed" (blocking; always notify)
//   - question.asked     → "Question"          (blocking; always notify)
//   - session.error      → "Error"             (always notify)
//   - session.idle       → "Claude is done"    (only if the session was busy
//                          AND the user isn't actively viewing that session)
//
// iOS (16.4+) delivers Web Push only to a PWA added to the home screen, and
// REQUIRES that every received push results in a visible notification — so we
// decide whether to notify on the SERVER (here) rather than silently dropping
// in the service worker. Focus-suppression for the "done" case relies on the
// client POSTing /push/focus on visibility / session changes.
//
// State persists under ~/.bui-mobile/ alongside config.json:
//   vapid.json      — generated VAPID keypair (stable across restarts so
//                     existing subscriptions keep working)
//   push-subs.json  — array of PushSubscription JSON objects
//
// The pure classifier `classifyPushEvent` is exported for unit tests; the
// stateful glue (busy-set tracking, focus, subscription IO, actual send)
// lives in firePush / the subscription helpers.

import webpush from "web-push";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const DIR = join(homedir(), ".bui-mobile");
const VAPID_PATH = join(DIR, "vapid.json");
const SUBS_PATH = join(DIR, "push-subs.json");

// VAPID `subject` must be a mailto: or https: URI identifying the sender.
const VAPID_SUBJECT = "mailto:bui@useronda.com";

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// VAPID keys — load once, generate + persist on first run.
// ---------------------------------------------------------------------------

let _vapid = null;

async function ensureVapid() {
  if (_vapid) return _vapid;
  try {
    if (existsSync(VAPID_PATH)) {
      _vapid = JSON.parse(await readFile(VAPID_PATH, "utf-8"));
    }
  } catch {
    _vapid = null;
  }
  if (!_vapid?.publicKey || !_vapid?.privateKey) {
    _vapid = webpush.generateVAPIDKeys();
    try {
      await atomicWrite(VAPID_PATH, JSON.stringify(_vapid, null, 2));
    } catch (e) {
      console.warn("[push] failed to persist VAPID keys:", e?.message ?? e);
    }
  }
  webpush.setVapidDetails(VAPID_SUBJECT, _vapid.publicKey, _vapid.privateKey);
  return _vapid;
}

/** The VAPID public key the client needs for pushManager.subscribe(). */
export async function getVapidPublic() {
  const v = await ensureVapid();
  return v.publicKey;
}

// ---------------------------------------------------------------------------
// Subscription store
// ---------------------------------------------------------------------------

async function loadSubs() {
  try {
    if (existsSync(SUBS_PATH)) {
      const arr = JSON.parse(await readFile(SUBS_PATH, "utf-8"));
      return Array.isArray(arr) ? arr : [];
    }
  } catch {
    /* corrupt file → start empty rather than crash the pump */
  }
  return [];
}

async function saveSubs(subs) {
  await atomicWrite(SUBS_PATH, JSON.stringify(subs, null, 2));
}

/** Add (or replace by endpoint) a PushSubscription. */
export async function addSubscription(sub) {
  if (!sub?.endpoint) throw new Error("subscription missing endpoint");
  const subs = await loadSubs();
  const next = subs.filter((s) => s.endpoint !== sub.endpoint);
  next.push(sub);
  await saveSubs(next);
  return { ok: true, count: next.length };
}

/** Remove a subscription by endpoint (client unsubscribed, or it went dead). */
export async function removeSubscription(endpoint) {
  if (!endpoint) return { ok: true, count: (await loadSubs()).length };
  const subs = await loadSubs();
  const next = subs.filter((s) => s.endpoint !== endpoint);
  if (next.length !== subs.length) await saveSubs(next);
  return { ok: true, count: next.length };
}

// ---------------------------------------------------------------------------
// Focus state — single user, so a single { sessionId, visible } snapshot.
// The client reports it so the "done" push can be suppressed for the session
// the user is actively looking at. On background/close the client reports
// visible:false, which re-enables all "done" pushes.
// ---------------------------------------------------------------------------

let _focus = { sessionId: null, visible: false };

export function setFocus({ sessionId, visible }) {
  _focus = {
    sessionId: typeof sessionId === "string" ? sessionId : null,
    visible: !!visible,
  };
  return _focus;
}

export function getFocus() {
  return _focus;
}

// ---------------------------------------------------------------------------
// Event classification (pure) + dispatch (stateful)
// ---------------------------------------------------------------------------

/**
 * Decide whether an opencode event should produce a notification and, if so,
 * what it says. Pure — all state comes in via `ctx`.
 *
 * @param {{type?: string, properties?: any}} evt
 * @param {{ focusSessionId: string|null, focusVisible: boolean, wasBusy: boolean, pendingAttention?: boolean }} ctx
 * @returns {{ kind: string, title: string, body: string, sessionId: string|null, tag: string }|null}
 */
export function classifyPushEvent(evt, ctx) {
  const type = evt?.type;
  const props = evt?.properties ?? {};
  const sessionId = typeof props.sessionID === "string" ? props.sessionID : null;
  const tagBase = sessionId ?? "global";

  switch (type) {
    case "permission.asked":
      return {
        kind: "permission",
        title: "Permission needed",
        body: "Claude wants to run a tool. Tap to review.",
        sessionId,
        tag: `perm-${tagBase}`,
      };
    case "question.asked":
      return {
        kind: "question",
        title: "Claude has a question",
        body: "Claude needs your input to continue. Tap to answer.",
        sessionId,
        tag: `question-${tagBase}`,
      };
    case "session.error": {
      const msg =
        typeof props.message === "string" && props.message
          ? props.message
          : typeof props.error === "string" && props.error
            ? props.error
            : "The turn failed.";
      return {
        kind: "error",
        title: "Claude hit an error",
        body: msg.slice(0, 180),
        sessionId,
        tag: `error-${tagBase}`,
      };
    }
    case "session.idle": {
      // A turn that pauses on a Question/permission tool also emits idle —
      // but it's NOT "done", it's blocked on the user. The question/permission
      // push already covers it, so suppress the redundant "done".
      if (ctx.pendingAttention) return null;
      // Only notify if the session actually ran (avoids "done" pushes on a
      // fresh connect that emits idle) AND the user isn't watching it.
      if (!ctx.wasBusy) return null;
      if (ctx.focusVisible && ctx.focusSessionId === sessionId) return null;
      return {
        kind: "done",
        title: "Claude is done",
        body: "Your turn finished.",
        sessionId,
        tag: `done-${tagBase}`,
      };
    }
    default:
      return null;
  }
}

// Sessions seen "busy" since their last idle — gates the "done" push so we
// don't notify on spurious idles. Keyed by sessionID.
const _busy = new Set();

// Sessions with an unanswered question/permission. While present, the session's
// idle is "blocked on the user", not "done" — so the "done" push is suppressed
// (the question/permission push already told them to act).
const _pending = new Set();

async function sendPush(payload) {
  await ensureVapid();
  const subs = await loadSubs();
  if (subs.length === 0) return;
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(s, body);
      } catch (e) {
        // 404/410 = subscription gone (PWA uninstalled / expired). Prune it.
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          await removeSubscription(s.endpoint).catch(() => {});
        } else {
          console.warn("[push] send failed:", code ?? "", e?.message ?? e);
        }
      }
    }),
  );
}

/**
 * Forward an opencode event to the push pipeline. Maintains the busy-set and
 * focus-aware suppression, then sends to all subscriptions. Best-effort: any
 * failure is logged, never thrown (the event bus must not break).
 *
 * NOTE: the caller must NOT invoke this for a permission.asked that was
 * auto-allowed by trust mode (there's nothing for the user to do).
 */
export async function firePush(evt) {
  try {
    const type = evt?.type;
    const props = evt?.properties ?? {};
    const sid = typeof props.sessionID === "string" ? props.sessionID : null;

    // Track busy → idle transitions so "done" only fires after real work.
    // Resuming work also clears any pending-attention flag (the user answered,
    // or we missed the reply event — either way it's no longer blocked).
    if (type === "session.status") {
      const t = props.status?.type;
      if ((t === "busy" || t === "retry") && sid) {
        _busy.add(sid);
        _pending.delete(sid);
      }
      return;
    }

    // Mark/clear pending attention so a paused-on-question idle isn't "done".
    if (sid) {
      if (type === "question.asked" || type === "permission.asked") {
        _pending.add(sid);
      } else if (
        type === "question.replied" ||
        type === "question.rejected" ||
        type === "permission.replied" ||
        type === "permission.rejected"
      ) {
        _pending.delete(sid);
      }
    }

    const payload = classifyPushEvent(evt, {
      focusSessionId: _focus.sessionId,
      focusVisible: _focus.visible,
      wasBusy: sid ? _busy.has(sid) : false,
      pendingAttention: sid ? _pending.has(sid) : false,
    });

    // Clear the busy flag once the session settles or errors.
    if ((type === "session.idle" || type === "session.error") && sid) {
      _busy.delete(sid);
    }
    // An error clears any pending attention too (the ask won't be answered).
    if (type === "session.error" && sid) _pending.delete(sid);

    if (!payload) return;
    await sendPush(payload);
  } catch (e) {
    console.warn("[push] firePush error:", e?.message ?? e);
  }
}

// Test hook.
export function _resetPushState() {
  _busy.clear();
  _pending.clear();
  _focus = { sessionId: null, visible: false };
}
