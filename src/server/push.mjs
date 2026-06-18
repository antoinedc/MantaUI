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
import * as tmux from "./tmux.mjs";

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
    case "question.asked": {
      // The event's properties IS the QuestionRequest: { id: que_…, sessionID,
      // questions: [{ question, header, options:[{label}], multiple?, custom? }] }.
      // Put the real question text in the body, and (for a single single-select
      // question) expose the options as notification actions so the user can
      // answer straight from the notification — iOS surfaces these on
      // long-press. `que_…` (properties.id) is the reply key.
      const qs = Array.isArray(props.questions) ? props.questions : [];
      const first = qs[0];
      const requestId = typeof props.id === "string" ? props.id : null;
      const out = {
        kind: "question",
        title: first?.header ? `Claude: ${first.header}` : "Claude has a question",
        body: first?.question || "Claude needs your input to continue.",
        sessionId,
        tag: `question-${tagBase}`,
        requestId,
      };
      // Quick-reply only makes sense for ONE single-select, non-free-text
      // question. Multi-question / multi-select / custom fall back to "open the
      // app to answer" (body tap), but still show the question text.
      if (
        requestId &&
        qs.length === 1 &&
        first &&
        !first.multiple &&
        !first.custom &&
        Array.isArray(first.options) &&
        first.options.length > 0
      ) {
        const labels = first.options
          .map((o) => o?.label)
          .filter((l) => typeof l === "string" && l.length > 0);
        if (labels.length > 0) {
          // Index→label map so the SW can build the reply from the tapped
          // action ("ans:<i>"); platforms cap the visible count themselves.
          out.answers = labels;
          out.actions = labels
            .slice(0, 4)
            .map((label, i) => ({ action: `ans:${i}`, title: label }));
        }
      }
      return out;
    }
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
        // Title is the session's "workspace / session-name" label (resolved
        // from tmux by firePush) so the user can tell WHICH chat finished at a
        // glance. Falls back to the generic copy when the label can't be
        // resolved (session not found in tmux, lookup failed).
        title: typeof ctx.label === "string" && ctx.label ? ctx.label : "Claude is done",
        body: "Your turn finished.",
        sessionId,
        tag: `done-${tagBase}`,
      };
    }
    default:
      return null;
  }
}

/**
 * Build the "workspace / session-name" notification title for an opencode
 * sessionID by scanning tmux projects (workspace = tmux session, session-name
 * = window name). Pure — takes the already-fetched projects list so it can be
 * unit-tested without a live tmux.
 *
 * @param {Array<{tmuxSession:string, windows:Array<{name:string, opencodeSessionId:string|null}>}>} projects
 * @param {string|null} sessionId
 * @returns {string|null} "workspace / session-name", or null if not found.
 */
export function buildSessionLabel(projects, sessionId) {
  if (!sessionId || !Array.isArray(projects)) return null;
  for (const proj of projects) {
    const wins = Array.isArray(proj?.windows) ? proj.windows : [];
    for (const w of wins) {
      if (w?.opencodeSessionId === sessionId) {
        const workspace = proj.tmuxSession || "";
        const name = w.name || "";
        if (workspace && name) return `${workspace} / ${name}`;
        return workspace || name || null;
      }
    }
  }
  return null;
}

// Resolve a sessionID → "workspace / session-name" by querying live tmux.
// Best-effort: any failure returns null so the push falls back to generic copy.
async function resolveSessionLabel(sessionId) {
  if (!sessionId) return null;
  try {
    const projects = await tmux.listProjects();
    return buildSessionLabel(projects, sessionId);
  } catch {
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

    // Resolve the "workspace / session-name" title only for the "done"
    // (session.idle) case — the other notifications keep their action-specific
    // titles ("Permission needed", etc.). Avoids a tmux query per event.
    const label =
      type === "session.idle" ? await resolveSessionLabel(sid) : null;

    const payload = classifyPushEvent(evt, {
      focusSessionId: _focus.sessionId,
      focusVisible: _focus.visible,
      wasBusy: sid ? _busy.has(sid) : false,
      pendingAttention: sid ? _pending.has(sid) : false,
      label,
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
