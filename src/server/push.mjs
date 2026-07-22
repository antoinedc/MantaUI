// push.mjs — Web Push (VAPID) for the mobile PWA + APNs native push for the
// iOS Capacitor app (BET-181, supplementary delivery leg; the Web Push
// VAPID leg stays for the frozen PWA build).
//
// Sends notifications to home-screen-installed PWAs for the events a user
// can't otherwise see when the app is backgrounded/closed:
//   - permission.asked   → "Permission needed" (blocking; always notify)
//   - question.asked     → "Question"          (blocking; always notify)
//   - session.error      → "Error"             (always notify, EXCEPT a
//                          MessageAbortedError, which is an intentional abort
//                          — user abort or mid-flight queued-message drain —
//                          and must NOT push)
//   - session.idle       → "Claude is done"    (only if the session was busy
//                          AND the user isn't actively viewing that session)
//
// iOS (16.4+) delivers Web Push only to a PWA added to the home screen, and
// REQUIRES that every received push results in a visible notification — so we
// decide whether to notify on the SERVER (here) rather than silently dropping
// in the service worker. Focus-suppression for the "done" case relies on the
// client POSTing /push/focus on visibility / session changes.
//
// APNs is the second delivery leg for native iOS Capacitor apps. The box no
// longer holds APNs credentials (the .p8 lives on the hosted gateway, see
// src/gateway/apns.mjs, BET-199); this file owns the box-side device-token
// store (APNS_TOKENS_PATH / addApnsToken / removeApnsToken) and fans every
// registered token out to the gateway via POST ${GATEWAY_BASE}/push (BET-201).
// Same routing decisions, same suppression. 410 / BadDeviceToken /
// Unregistered prune the token (the gateway classifies and reports; this file
// owns the prune side-effect). A stale or rotated token never makes a
// successful delivery without first being re-registered by the app.
//
// State persists under ~/.manta/ alongside config.json:
//   vapid.json      — generated VAPID keypair (stable across restarts so
//                     existing subscriptions keep working)
//   push-subs.json  — array of PushSubscription JSON objects
//   apns-tokens.json — array of { token, registeredAt } objects (kind:"apns")
//
// The pure classifier `classifyPushEvent` is exported for unit tests; the
// stateful glue (busy-set tracking, focus, subscription IO, actual send)
// lives in firePush / the subscription helpers.

import webpush from "web-push";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { STATE_DIRNAME } from "../shared/paths.mjs";
import * as tmux from "./tmux.mjs";

const DIR = join(homedir(), STATE_DIRNAME);
const VAPID_PATH = join(DIR, "vapid.json");
const SUBS_PATH = join(DIR, "push-subs.json");
const APNS_TOKENS_PATH = join(DIR, "apns-tokens.json");

// (APNs signing + HTTP/2 lives in src/gateway/apns.mjs — BET-199. Boxes no
// longer hold the .p8; this file only orchestrates via the gateway.)

// VAPID `subject` must be a mailto: or https: URI identifying the sender.
const VAPID_SUBJECT = "mailto:app@mantaui.com";

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
// APNs device-token store (BET-181)
//
// Same persistence shape as the Web Push subscription store, but the entries
// are { kind:"apns", token, registeredAt } instead of PushSubscription JSON.
// The `kind` discriminator lets us fold both registries into a single
// unified-store migration later without a separate file; for now they live
// side-by-side. De-dupe on the `token` value (a token rotated by APNs or
// reinstalled by the user comes back as a new entry; old ones get pruned on
// 410).
// ---------------------------------------------------------------------------

async function loadApnsTokens(path = APNS_TOKENS_PATH) {
  try {
    if (existsSync(path)) {
      const arr = JSON.parse(await readFile(path, "utf-8"));
      return Array.isArray(arr) ? arr : [];
    }
  } catch {
    /* corrupt file → start empty */
  }
  return [];
}

async function saveApnsTokens(tokens, path = APNS_TOKENS_PATH) {
  await atomicWrite(path, JSON.stringify(tokens, null, 2));
}

/** Upsert a device token. De-dupes by token value; updates registeredAt.
 *  `store` injection (test-only) lets tests run against a tmpdir file
 *  instead of the production path. */
export async function addApnsToken(token, { store } = {}) {
  if (typeof token !== "string" || !token) {
    throw new Error("token must be a non-empty string");
  }
  const path = store ?? APNS_TOKENS_PATH;
  const tokens = await loadApnsTokens(path);
  const next = tokens.filter((t) => t.token !== token);
  next.push({ kind: "apns", token, registeredAt: Date.now() });
  await saveApnsTokens(next, path);
  return { ok: true, count: next.length };
}

/** Remove a token by value (used on 410 / BadDeviceToken / Unregistered).
 *  `store` injection (test-only) — see addApnsToken. */
export async function removeApnsToken(token, { store } = {}) {
  const path = store ?? APNS_TOKENS_PATH;
  if (!token) return { ok: true, count: (await loadApnsTokens(path)).length };
  const tokens = await loadApnsTokens(path);
  const next = tokens.filter((t) => t.token !== token);
  if (next.length !== tokens.length) await saveApnsTokens(next, path);
  return { ok: true, count: next.length };
}

/** Test hook. */
export async function _loadApnsTokensForTest(store) {
  return loadApnsTokens(store ?? APNS_TOKENS_PATH);
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
// Desktop presence — the Electron app reports "I'm focused" so a mobile "done"
// push is suppressed when the user is heads-down on the desktop (Discord's
// "active on desktop ⇒ no mobile push" rule). The desktop reaches this server
// directly over HTTPS and POSTs /push/desktop-presence on focus/blur/system-idle.
//
// Two timers gate suppression so a crashed/asleep desktop can't permanently
// mute mobile:
//   - lastSeen TTL (DESKTOP_PRESENCE_TTL_MS): no heartbeat in this long ⇒
//     desktop is gone, mobile pushes resume regardless of the last `visible`.
//   - grace window (DESKTOP_GRACE_MS): even after an explicit blur/idle, keep
//     suppressing for this long so a quick desktop window-switch doesn't buzz
//     the phone. Matches the ~30s Discord-style grace.
//
// Single user → a single snapshot. `visible` is the last reported foreground
// state; `lastActive` is the last time desktop was actually focused (set on a
// visible:true heartbeat), which the grace window is measured from.
// ---------------------------------------------------------------------------

export const DESKTOP_PRESENCE_TTL_MS = 60_000; // heartbeat staleness cutoff
export const DESKTOP_GRACE_MS = 30_000; // keep suppressing after blur/idle

let _desktop = { visible: false, lastSeen: 0, lastActive: 0 };

/**
 * Record a desktop presence heartbeat. The desktop posts these on focus, blur,
 * and system idle/resume; an absent heartbeat (TTL) means the desktop is gone.
 * @param {{visible?: boolean}} report
 * @param {number} [now] injectable clock for tests
 */
export function setDesktopPresence({ visible } = {}, now = Date.now()) {
  const vis = !!visible;
  _desktop = {
    visible: vis,
    lastSeen: now,
    // lastActive only advances while the desktop is actually foreground, so the
    // grace window is measured from when the user last had it focused.
    lastActive: vis ? now : _desktop.lastActive,
  };
  // The user is back at the desk → cancel any pending desktop→mobile
  // escalations. They'll see the desktop notification (clicking it focuses the
  // app, which trips this naturally); buzzing the phone now would duplicate.
  if (vis) cancelAllEscalations();
  return _desktop;
}

export function getDesktopPresence() {
  return _desktop;
}

/**
 * Pure: should a mobile "done" push be suppressed because the desktop is (or
 * was just) active? Suppress when the desktop is focused on ANY session, OR
 * was focused within the grace window — provided the heartbeat is fresh (TTL).
 *
 * @param {{visible:boolean, lastSeen:number, lastActive:number}} desktop
 * @param {number} now
 * @returns {boolean}
 */
export function shouldSuppressForDesktop(desktop, now = Date.now()) {
  if (!desktop) return false;
  // Stale heartbeat → desktop is gone (crash, sleep, network drop). Don't let
  // a dead desktop mute mobile forever.
  if (now - (desktop.lastSeen ?? 0) > DESKTOP_PRESENCE_TTL_MS) return false;
  // Currently foreground on desktop → suppress.
  if (desktop.visible) return true;
  // Recently foreground (within the grace window) → still suppress so a quick
  // desktop window-switch / brief blur doesn't immediately buzz the phone.
  if (now - (desktop.lastActive ?? 0) <= DESKTOP_GRACE_MS) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Cross-device router (the single arbiter — see docs/manta-tools-notify.md)
//
// Every notification (automatic opencode event OR an AI `notify` call) runs
// through `routeNotification`, which decides — knowing BOTH device presences —
// whether it goes to desktop, mobile, both, or escalates desktop→mobile. This
// is what guarantees "no duplicates": one place sees everything.
// ---------------------------------------------------------------------------

// How long a desktop-first informational notif waits before escalating to a
// mobile push, when the desktop is idle/away (app open but no recent input).
export const ESCALATE_MS = 90_000;

/**
 * Notification tier (Slack/Discord parity):
 *  - "blocking": permission/question/error, or an urgent notify → reaches
 *    every device immediately, never delayed or escalation-gated.
 *  - "informational": "done" / normal notify → desktop-first ladder.
 * @param {{kind?: string, urgent?: boolean}} payload
 */
export function notifTier(payload) {
  const k = payload?.kind;
  if (k === "permission" || k === "question" || k === "error") return "blocking";
  if (k === "notify" && payload?.urgent) return "blocking";
  return "informational";
}

/**
 * Pure routing decision for one notification payload.
 *
 * @param {{kind?:string, urgent?:boolean, sessionId?:string|null}} payload
 * @param {{ desktop:any, focusSessionId:string|null, focusVisible:boolean }} presence
 * @param {number} now
 * @returns {{ desktop:boolean, mobileNow:boolean, escalateAfterMs:number|null }}
 *
 * The `desktop:true` directive is "emit a desktop notification"; the Electron
 * app does the final "am I literally viewing this session right now?"
 * suppression locally (it knows its focused window + active session), so we
 * don't plumb the desktop's session to the server. Mobile's "viewing this"
 * suppression must be server-side (a push can't be un-sent) → `focus*`.
 */
export function routeNotification(payload, presence, now = Date.now()) {
  const tier = notifTier(payload);
  const desktop = presence?.desktop;
  // Heartbeat fresh ⇒ the Mac app is reachable (even if the user is idle).
  const reachable =
    !!desktop && now - (desktop.lastSeen ?? 0) <= DESKTOP_PRESENCE_TTL_MS;
  // Active ⇒ focused + recent input (or within the grace window), fresh.
  const active = shouldSuppressForDesktop(desktop, now);
  // Mobile is foregrounded ON this very session ⇒ the in-app UI already shows
  // it; no push needed for this device.
  const mobileViewingThis =
    !!presence?.focusVisible &&
    !!presence?.focusSessionId &&
    presence.focusSessionId === payload?.sessionId;

  if (tier === "blocking") {
    // Both devices, now. Desktop client self-suppresses if viewing S.
    return { desktop: true, mobileNow: !mobileViewingThis, escalateAfterMs: null };
  }

  // informational
  if (active) {
    // At the desk → desktop only.
    return { desktop: true, mobileNow: false, escalateAfterMs: null };
  }
  if (reachable) {
    // Idle/away but app open → desktop now, escalate to mobile if unhandled.
    return {
      desktop: true,
      mobileNow: false,
      escalateAfterMs: mobileViewingThis ? null : ESCALATE_MS,
    };
  }
  // Desktop gone (no heartbeat) → mobile only.
  return { desktop: false, mobileNow: !mobileViewingThis, escalateAfterMs: null };
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

  // Every notification's TITLE is the session's "workspace / session-name"
  // label (resolved from tmux by firePush) so the user can tell WHICH chat the
  // push is about at a glance. The kind-specific context moves to the body.
  // When the label can't be resolved (session not in tmux, lookup failed) we
  // fall back to the per-kind descriptive title via titleOr(fallback).
  const label = typeof ctx?.label === "string" && ctx.label ? ctx.label : null;
  const titleOr = (fallback) => label ?? fallback;

  switch (type) {
    case "permission.asked":
      return {
        kind: "permission",
        title: titleOr("Permission needed"),
        body: label
          ? "Permission needed — Claude wants to run a tool. Tap to review."
          : "Claude wants to run a tool. Tap to review.",
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
      // Body shows the question text, prefixed with the header when we have a
      // label in the title (so the "what kind" cue isn't lost). Without a label
      // the title still carries the header (legacy "Claude: <header>" form).
      const qBody = first?.question || "Claude needs your input to continue.";
      const out = {
        kind: "question",
        title: titleOr(
          first?.header ? `Claude: ${first.header}` : "Claude has a question",
        ),
        body:
          label && first?.header ? `${first.header} — ${qBody}` : qBody,
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
      // A MessageAbortedError is NOT a failure — it's the signal opencode
      // emits when the running turn was intentionally aborted. manta aborts on
      // purpose in two cases: an explicit user abort, and the mid-flight
      // queued-message DRAIN (user submits while running → manta aborts the
      // in-flight turn and resubmits the queued prompt transparently; see
      // ChatPanel `maybeDrainQueuedPrompt` + `isDrainAbortError`). The
      // renderer swallows this error's banner client-side, but that
      // suppression is renderer-only and never reaches the server push path,
      // so without this check every drain fired a spurious "Error — The turn
      // failed." push. Neither abort flavour should ever notify, so we drop
      // the push for ANY MessageAbortedError. opencode nests the class name at
      // properties.error.name (the renderer reads the same field).
      const errName =
        props.error && typeof props.error === "object"
          ? props.error.name
          : undefined;
      if (errName === "MessageAbortedError") return null;
      const msg =
        typeof props.message === "string" && props.message
          ? props.message
          : typeof props.error === "string" && props.error
            ? props.error
            : "The turn failed.";
      return {
        kind: "error",
        title: titleOr("Claude hit an error"),
        // Prefix with "Error —" when the title is the session label, so the
        // notification still reads as an error and not a normal message.
        body: label ? `Error — ${msg.slice(0, 174)}` : msg.slice(0, 180),
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
        title: titleOr("Claude is done"),
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
 * Pure: should a push be dropped because its session can't be resolved to a
 * tmux chat window (null label)? Such a session is a SUBAGENT child (it
 * inherited the parent's directory, runs on the same scoped /event stream, but
 * has no `@manta-session-id` of its own) or a stale orphan — there is no chat for
 * the user to land on, and the push would be a nameless notification that
 * deep-links nowhere.
 *
 * Covers `done`, `error`, `permission`, and `question`: an orphan session has
 * no chat window for the user to act in or land on, so a push to any of these
 * kinds is useless. A `done` would be a nameless "Claude is done"; an `error`
 * would be a nameless "The turn failed"; a `permission`/`question` would
 * require user action the user can't take from a push that deep-links to a
 * sessionId the app can't find.
 *
 * @param {{kind?: string}|null} payload  classifyPushEvent result
 * @param {string|null} label             resolved "workspace / session-name", or null
 * @returns {boolean}
 */
export function shouldSuppressUnresolvedNotification(payload, label) {
  if (!label) {
    const k = payload?.kind;
    return k === "done" || k === "error" || k === "permission" || k === "question";
  }
  return false;
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

// ---------------------------------------------------------------------------
// Desktop sink + escalation state
//
// `_desktopSink` is injected by index.mjs and publishes a `desktopNotify` bus
// envelope, which the Electron app consumes and renders as an OS Notification.
// push.mjs stays decoupled from the bus (mirrors
// how schedule.mjs takes an injected sendPrompt).
// ---------------------------------------------------------------------------

let _desktopSink = null;

/** Inject the desktop notification sink (publishes to the bus). */
export function setDesktopSink(fn) {
  _desktopSink = typeof fn === "function" ? fn : null;
}

// Pending desktop→mobile escalations, keyed by notification tag. Each holds the
// timer + the sessionId so we can cancel by session when the ask is answered.
const _escalations = new Map();

function cancelEscalation(tag) {
  const e = _escalations.get(tag);
  if (e) {
    clearTimeout(e.timer);
    _escalations.delete(tag);
  }
}

/** Cancel every pending escalation (user returned to the desk). */
export function cancelAllEscalations() {
  for (const e of _escalations.values()) clearTimeout(e.timer);
  _escalations.clear();
}

/** Cancel pending escalations for one session (the ask was answered/resumed). */
export function cancelEscalationsForSession(sessionId) {
  if (!sessionId) return;
  for (const [tag, e] of _escalations) {
    if (e.sessionId === sessionId) {
      clearTimeout(e.timer);
      _escalations.delete(tag);
    }
  }
}

/** Test hook: tags with a pending escalation timer. */
export function _pendingEscalationTags() {
  return [..._escalations.keys()];
}

/**
 * Run a notification payload through the router and fire the chosen legs.
 * Desktop leg = sink (immediate); mobile leg = push now OR an escalation timer.
 */
async function dispatchNotification(payload, now = Date.now()) {
  const route = routeNotification(
    payload,
    {
      desktop: _desktop,
      focusSessionId: _focus.sessionId,
      focusVisible: _focus.visible,
    },
    now,
  );

  // A re-notify for the same tag supersedes any pending escalation.
  cancelEscalation(payload.tag);

  console.log(
    `[push] route kind=${payload.kind} sid=${payload.sessionId} ` +
      `→ desktop=${route.desktop} mobileNow=${route.mobileNow} ` +
      `escalateMs=${route.escalateAfterMs ?? "-"}`,
  );

  if (route.desktop && _desktopSink) {
    try {
      _desktopSink(payload);
    } catch (e) {
      console.warn("[push] desktop sink failed:", e?.message ?? e);
    }
  }

  if (route.mobileNow) {
    await sendPush(payload);
  } else if (route.escalateAfterMs != null) {
    const timer = setTimeout(() => {
      _escalations.delete(payload.tag);
      sendPush(payload).catch(() => {});
    }, route.escalateAfterMs);
    timer.unref?.();
    _escalations.set(payload.tag, { timer, sessionId: payload.sessionId ?? null });
  }
}

/**
 * AI-triggered notification — the manta-native `notify` opencode tool POSTs here
 * via POST /api/notify. Session-tied: carries the originating sessionID so it
 * deep-links + dedupes like every other push.
 *
 * @param {{message:string, title?:string, urgent?:boolean, sessionID?:string}} args
 */
export async function fireNotify({ message, title, urgent, sessionID } = {}) {
  const sid = typeof sessionID === "string" ? sessionID : null;
  const label = await resolveSessionLabel(sid);
  const payload = {
    kind: "notify",
    urgent: !!urgent,
    title: title || label || "Notification",
    body: typeof message === "string" ? message : "",
    sessionId: sid,
    tag: `notify-${sid ?? "global"}`,
  };
  await dispatchNotification(payload);
  return { ok: true };
}

async function sendPush(payload) {
  // APNs is the PRIMARY (native iOS) leg and MUST NOT be gated on the Web Push
  // (PWA) leg. Previously this function awaited webpush.sendNotification for
  // every subscription BEFORE calling sendApnsFanout. A single stale Apple Web
  // Push endpoint (web.push.apple.com) hangs its request, which starved/delayed
  // the APNs fanout — so high-frequency automatic events (done/question/error)
  // almost never reached the native device, while the occasional `notify` won
  // the race. Fire APNs first and unconditionally; run Web Push independently
  // so it can never block or drop the native push. Neither leg's failure
  // affects the other.
  const apnsLeg = sendApnsFanout(payload).catch((e) =>
    console.warn("[push] apns fanout failed:", e?.message ?? e),
  );
  const webLeg = sendWebPush(payload).catch((e) =>
    console.warn("[push] web push leg failed:", e?.message ?? e),
  );
  await Promise.allSettled([apnsLeg, webLeg]);
}

// Web Push (VAPID) delivery leg — kept for the frozen PWA build. Independent
// of APNs: isolated here so a hung/stale endpoint can't block native pushes.
async function sendWebPush(payload) {
  await ensureVapid();
  const subs = await loadSubs();
  if (subs.length === 0) return;
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        // Bound the send: a stale Apple Web Push endpoint can hang its request
        // indefinitely. web-push accepts a per-call `timeout` (ms) — cap it so
        // a dead PWA endpoint can't keep the caller's await pending forever.
        await webpush.sendNotification(s, body, { timeout: 10_000 });
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

// ---------------------------------------------------------------------------
// APNs native-push delivery leg (BET-181 → BET-199 → BET-201)
//
// APNs signing + HTTP/2 lives in src/gateway/apns.mjs (BET-199). Boxes no
// longer hold the .p8. This file owns the box-side device-token store
// (APNS_TOKENS_PATH / addApnsToken / removeApnsToken) and fans every
// registered token out to the hosted gateway via POST ${GATEWAY_BASE}/push
// (BET-201). The gateway is the SOLE APNs client; the box only orchestrates.
// Pruning is box-side (we own the token registry) — on a 200 from the gateway
// we walk the per-token results and call removeApnsToken for every
// `prune:true` entry.
// ---------------------------------------------------------------------------

// Gateway base URL. Env override exists for tests only (no config key).
const GATEWAY_BASE = process.env.MANTA_GATEWAY_BASE || "https://gateway.mantaui.com";

// Box identity lives in ~/.manta/auth.json alongside box_token (see
// auth.mjs). We don't import auth.mjs here — it would create a cycle once
// BET-202 wires the registration module into index.mjs. Read just the two
// fields we need directly.
const AUTH_PATH = join(homedir(), STATE_DIRNAME, "auth.json");

async function readBoxGatewayIdentity() {
  try {
    if (!existsSync(AUTH_PATH)) return null;
    const raw = await readFile(AUTH_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const box_id = typeof parsed?.box_id === "string" ? parsed.box_id : null;
    const gateway_token =
      typeof parsed?.gateway_token === "string" ? parsed.gateway_token : null;
    if (!box_id || !gateway_token) return null;
    return { box_id, gateway_token };
  } catch {
    return null;
  }
}

// Test hooks — let unit tests inject fakes without touching globals.
let _fetchImpl = null;
let _loadApnsTokensOverride = null;
let _removeApnsTokenOverride = null;
let _gatewayBaseOverride = null;
let _readBoxGatewayIdentityOverride = null;

export function _setFanoutFakesForTest({
  fetchImpl,
  loadApnsTokens,
  removeApnsToken,
  gatewayBase,
  readBoxGatewayIdentity: readId,
} = {}) {
  if (fetchImpl !== undefined) _fetchImpl = fetchImpl;
  if (loadApnsTokens !== undefined) _loadApnsTokensOverride = loadApnsTokens;
  if (removeApnsToken !== undefined) _removeApnsTokenOverride = removeApnsToken;
  if (gatewayBase !== undefined) _gatewayBaseOverride = gatewayBase;
  if (readId !== undefined) _readBoxGatewayIdentityOverride = readId;
}

export function _resetFanoutFakesForTest() {
  _fetchImpl = null;
  _loadApnsTokensOverride = null;
  _removeApnsTokenOverride = null;
  _gatewayBaseOverride = null;
  _readBoxGatewayIdentityOverride = null;
}

/**
 * Fan APNs out via the hosted gateway. Reads the box's device-token store,
 * POSTs { box_id, tokens, payload } to ${GATEWAY_BASE}/push with a Bearer
 * token read from ~/.manta/auth.json, and prunes every `prune:true` entry
 * on a 200 response. Best-effort: any failure (network, non-2xx, missing
 * auth) is logged and dropped — push must never crash the event bus.
 *
 * @param {object} payload
 * @param {object} [opts] reserved for forward-compat; ignored today
 */
export async function sendApnsFanout(payload, opts = {}) {
  // Read the device-token registry. If there are no tokens, nothing to do.
  const tokens = await (_loadApnsTokensOverride
    ? _loadApnsTokensOverride()
    : loadApnsTokens());
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  const tokenValues = tokens.map((t) => t?.token).filter((t) => typeof t === "string");
  if (tokenValues.length === 0) return;

  // Resolve the box identity + gateway_token from auth.json.
  const ident = await (_readBoxGatewayIdentityOverride
    ? _readBoxGatewayIdentityOverride()
    : readBoxGatewayIdentity());
  if (!ident) {
    console.warn(
      "[push] gateway send skipped: ~/.manta/auth.json missing box_id or gateway_token " +
        "(box has not yet registered with the gateway; BET-202 will start that on boot)",
    );
    return;
  }
  const base = _gatewayBaseOverride ?? GATEWAY_BASE;
  const url = `${base}/push`;
  const doFetch = _fetchImpl ?? globalThis.fetch;

  let resp;
  try {
    resp = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ident.gateway_token}`,
      },
      body: JSON.stringify({
        box_id: ident.box_id,
        tokens: tokenValues,
        payload,
      }),
    });
  } catch (e) {
    console.warn(
      `[push] gateway send failed: ${e?.message ?? e} (url=${url})`,
    );
    return;
  }

  if (!resp || !resp.ok) {
    console.warn(
      `[push] gateway send failed: status=${resp?.status ?? "?"} url=${url}`,
    );
    return;
  }

  // Walk per-token results; prune entries the gateway classified as dead.
  let results;
  try {
    const body = await resp.json();
    results = body?.results;
  } catch (e) {
    console.warn("[push] gateway send failed: malformed JSON:", e?.message ?? e);
    return;
  }
  if (!Array.isArray(results)) return;
  const remove = _removeApnsTokenOverride ?? removeApnsToken;
  for (const r of results) {
    if (r?.prune === true && typeof r.token === "string") {
      await remove(r.token).catch(() => {});
    }
  }
  console.log(
    `[push] gateway ok count=${tokenValues.length} pruned=${
      results.filter((r) => r?.prune === true).length
    }`,
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
        // The session resumed → the user is acting on it; cancel any pending
        // desktop→mobile escalation for it (don't buzz the phone for work
        // that's already moving again).
        cancelEscalationsForSession(sid);
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
        // The ask was answered → cancel its pending escalation.
        cancelEscalationsForSession(sid);
      }
    }

    // Resolve the "workspace / session-name" label for every notifying event
    // so ALL pushes show which chat they came from in the title. Only the four
    // types that can produce a notification trigger the tmux lookup, so we
    // never pay the query cost for the firehose of streaming events.
    const NOTIFYING = new Set([
      "permission.asked",
      "question.asked",
      "session.error",
      "session.idle",
    ]);
    const label = NOTIFYING.has(type) ? await resolveSessionLabel(sid) : null;

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

    // Suppress an unresolvable notification: no tmux window stamps this
    // sessionID (label is null), so it's a SUBAGENT child session (it inherited
    // the parent's directory and runs on the same scoped /event stream) or a
    // stale orphan — NOT a chat the user opened. Such a push has no workspace/
    // name (generic "Claude is done" / "The turn failed" / "Permission needed"
    // / "Claude has a question") and deep-links to a sessionId the app can't
    // find, dumping the user on the session list. The desktop renderer hides
    // subagent idles via its childSessionIds allowlist; the server pump has no
    // parent/child awareness, so the null-label test is our proxy: if we can't
    // name the chat, the user has nothing actionable to land on. This applies
    // to done/error/permission/question — all are useless without a resolvable
    // session label.
    if (shouldSuppressUnresolvedNotification(payload, label)) {
      console.log(
        `[push] ${payload.kind} sid=${sid} suppressed=unresolvable-session ` +
          `(no tmux @manta-session-id → subagent/orphan)`,
      );
      return;
    }

    // Route across devices (desktop / mobile / escalation). The router
    // subsumes the old "suppress mobile done while active on desktop" rule and
    // adds the desktop leg + desktop-first escalation. See routeNotification.
    await dispatchNotification(payload);
  } catch (e) {
    console.warn("[push] firePush error:", e?.message ?? e);
  }
}

// Test hook.
export function _resetPushState() {
  _busy.clear();
  _pending.clear();
  cancelAllEscalations();
  _desktopSink = null;
  _focus = { sessionId: null, visible: false };
  _desktop = { visible: false, lastSeen: 0, lastActive: 0 };
}
