// push.mjs — native (APNs) push for the iOS client, fanned out via the hosted
// gateway (BET-181, BET-199, BET-201).
//
// Sends notifications for the events a user can't otherwise see when the app
// is backgrounded/closed:
//   - permission.asked   → "Permission needed" (blocking; always notify)
//   - question.asked     → "Question"          (blocking; always notify)
//   - session.error      → "Error"             (always notify, EXCEPT a
//                          MessageAbortedError, which is an intentional abort
//                          — user abort or mid-flight queued-message drain —
//                          and must NOT push)
//   - session.idle       → "Claude is done"    (only if the session was busy
//                          AND the user isn't actively viewing that session)
//
// BET-559: the Web Push (VAPID) leg that served the retired mobile PWA was
// removed along with the PWA itself. This file is APNs-only now.
//
// The box no longer holds APNs credentials (the .p8 lives on the hosted
// gateway, see src/gateway/apns.mjs, BET-199); this file owns the box-side
// device-token store (APNS_TOKENS_PATH / addApnsToken / removeApnsToken) and
// fans every registered token out to the gateway via POST ${GATEWAY_BASE}/push
// (BET-201). Same routing decisions, same suppression. 410 / BadDeviceToken /
// Unregistered prune the token (the gateway classifies and reports; this file
// owns the prune side-effect). A stale or rotated token never makes a
// successful delivery without first being re-registered by the app.
//
// State persists under ~/.manta/ alongside config.json:
//   apns-tokens.json — array of { token, registeredAt } objects (kind:"apns")
//
// The pure classifier `classifyPushEvent` is exported for unit tests; the
// stateful glue (busy-set tracking, focus, subscription IO, actual send)
// lives in firePush / the fan-out helpers.

import { join } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { planPageUrl } from "../shared/planMode.mjs";
import { publicBaseUrl } from "./gatewayRegister.mjs";
import * as tmux from "./tmux.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { loadJobs } from "./delegate.mjs";
import { createSeenIdFilter } from "./seenIds.mjs";

const DIR = statePath();
const APNS_TOKENS_PATH = join(DIR, "apns-tokens.json");

// (APNs signing + HTTP/2 lives in src/gateway/apns.mjs — BET-199. Boxes no
// longer hold the .p8; this file only orchestrates via the gateway.)

// VAPID `subject` must be a mailto: or https: URI identifying the sender.
const VAPID_SUBJECT = "mailto:app@mantaui.com";

// Atomic reads/writes route through jsonStore.mjs (single source of truth for
// the temp-file-then-rename dance). `writeJsonAtomic` takes already-serialized
// bytes and creates the parent dir, matching the old per-store copy.

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
  const arr = readJsonSync(path, []);
  return Array.isArray(arr) ? arr : [];
}

/**
 * Token-shape gate. MUST stay in sync with the gateway's `isHexToken`
 * (src/gateway/index.mjs): the gateway 400s the ENTIRE /push batch when ANY
 * token fails its check, so one bad stored token silences push for every
 * real device and — because pruning only runs on a 200 — the bad entry can
 * never self-heal. Concretely: the iOS Simulator "registers" 80-byte
 * (160-hex-char) pseudo-tokens that APNs cannot route; real APNs device
 * tokens are 32 bytes (64 hex chars) today, and Apple documents the length
 * may change — hence the same 1..128 bound the gateway enforces, not a
 * hardcoded 64.
 */
export function isValidApnsToken(t) {
  return typeof t === "string" && /^[0-9a-fA-F]{1,128}$/.test(t);
}

async function saveApnsTokens(tokens, path = APNS_TOKENS_PATH) {
  await writeJsonAtomic(path, JSON.stringify(tokens, null, 2));
}

/** Upsert a device token. De-dupes by token value; updates registeredAt.
 *  `store` injection (test-only) lets tests run against a tmpdir file
 *  instead of the production path. */
export async function addApnsToken(token, { store } = {}) {
  if (typeof token !== "string" || !token) {
    throw new Error("token must be a non-empty string");
  }
  if (!isValidApnsToken(token)) {
    // Reject at the single registration chokepoint (both the HTTP route and
    // the rpc channel funnel here) — see isValidApnsToken for why one bad
    // token in the store kills push for every device.
    throw new Error(
      `token rejected: not a 1-128 char hex APNs device token (len=${token.length}); ` +
        "simulator pseudo-tokens are not registrable",
    );
  }
  const path = store ?? APNS_TOKENS_PATH;
  // APNs tokens are hex; case is insignificant, so normalise to lowercase at
  // this single registration chokepoint — one phone can never occupy two
  // case-differing entries (which would receive every notification twice).
  const norm = token.toLowerCase();
  const tokens = await loadApnsTokens(path);
  const next = tokens.filter((t) => t.token !== norm);
  next.push({ kind: "apns", token: norm, registeredAt: Date.now() });
  await saveApnsTokens(next, path);
  return { ok: true, count: next.length };
}

/** Remove a token by value (used on 410 / BadDeviceToken / Unregistered).
 *  `store` injection (test-only) — see addApnsToken. */
export async function removeApnsToken(token, { store } = {}) {
  const path = store ?? APNS_TOKENS_PATH;
  if (!token) return { ok: true, count: (await loadApnsTokens(path)).length };
  const tokens = await loadApnsTokens(path);
  // Normalise the same way addApnsToken does, so a prune of an upper-case
  // spelling reported by the gateway still matches the stored (lowercased) entry.
  const key = typeof token === "string" ? token.toLowerCase() : token;
  const next = tokens.filter((t) => t.token !== key);
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
// Desktop presence — raw observations (idle + lock) POSTed by the app every 30s
// forever; away/present/gone policy lives here (computeAwayAt + desktopState).
// ---------------------------------------------------------------------------

// No input anywhere for this long ⇒ the user left the desk. 10 min matches
// Discord's push "inactive timeout" ceiling / Slack's cursor default; long on
// purpose because waiting on a running turn without typing is normal in manta.
export const IDLE_AWAY_MS = 10 * 60_000;
// Screen locked this long ⇒ user left. Locking is PROOF, so far shorter than
// idle (Slack: 1 min lock vs 10 min idle).
export const LOCK_AWAY_MS = 5 * 60_000;
// No heartbeat this long ⇒ app not running (quit/crash/sleep). Comfortably
// above the desktop's 30s heartbeat interval.
export const PRESENCE_TTL_MS = 90_000;

let _desktop = { lastSeen: 0, idleSeconds: 0, lockedSeconds: null, awayAt: Infinity };
/** Record a presence heartbeat; detect "the user came back"; recompute awayAt. */
export function setDesktopPresence({ idleSeconds, lockedSeconds } = {}, now = Date.now()) {
  // Coerce defensively (a malformed body must never throw or poison the record).
  const idle =
    typeof idleSeconds === "number" && Number.isFinite(idleSeconds) && idleSeconds >= 0
      ? idleSeconds
      : 0;
  const locked =
    typeof lockedSeconds === "number" &&
    Number.isFinite(lockedSeconds) &&
    lockedSeconds >= 0
      ? lockedSeconds
      : null;

  // A LOWER idleSeconds than last = new input since last beat = the user came
  // back (skip on first beat, lastSeen 0); cancel parked mobile pushes.
  if (now > 0 && _desktop.lastSeen !== 0 && idle < _desktop.idleSeconds) {
    cancelAllDeferredMobile();
  }

  _desktop = { lastSeen: now, idleSeconds: idle, lockedSeconds: locked, awayAt: computeAwayAt({ lastSeen: now, idleSeconds: idle, lockedSeconds: locked }) };
  return _desktop;
}

export function getDesktopPresence() {
  return _desktop;
}
/** The epoch-ms instant at which this desktop is "away". Two conditions, ONE
 * answer (min): whichever trips first wins, so a machine that locks after 2 min
 * crosses at lock+5min and idle+10min never fires separately. Infinity when
 * neither can trip (never in practice — the idle candidate is always finite).
 */
export function computeAwayAt({ lastSeen, idleSeconds, lockedSeconds }) {
  const byIdle = lastSeen + Math.max(0, IDLE_AWAY_MS - idleSeconds * 1000);
  const byLock =
    lockedSeconds == null
      ? Infinity
      : lastSeen + Math.max(0, LOCK_AWAY_MS - lockedSeconds * 1000);
  return Math.min(byIdle, byLock);
}

/**
 * Three states (replaces the old visible/stale pair): "gone" = no heartbeat in
 * TTL (app not running); "away" = running but past awayAt; "present" = running
 * and the user is at the machine.
 */
export function desktopState(desktop, now = Date.now()) {
  if (!desktop || now - (desktop.lastSeen ?? 0) > PRESENCE_TTL_MS) return "gone";
  return now >= (desktop.awayAt ?? Infinity) ? "away" : "present";
}

// ---------------------------------------------------------------------------
// Cross-device router (the single arbiter — see docs/manta-tools-notify.md)
//
// Every notification (automatic opencode event OR an AI `notify` call) runs
// through `routeNotification`, which decides — knowing BOTH device presences —
// whether it goes to desktop, mobile, both, or escalates desktop→mobile. This
// is what guarantees "no duplicates": one place sees everything.
// ---------------------------------------------------------------------------

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
 * Pure routing for one notification. `deferMobile` (= park for the ticker) is
 * how the phone gets at most one delivery per notif, delayed not added. Desktop
 * "viewing S" is client-side; mobile's is server-side via `focus*` (can't un-send).
 */
export function routeNotification(payload, presence, now = Date.now()) {
  const tier = notifTier(payload);
  const desktop = presence?.desktop;
  const state = desktopState(desktop, now);
  const mobileViewingThis =
    !!presence?.focusVisible &&
    !!presence?.focusSessionId &&
    presence.focusSessionId === payload?.sessionId;

  if (tier === "blocking") {
    // Both devices, now; user has confirmed this branch — do not change it.
    return { desktop: true, mobileNow: !mobileViewingThis, deferMobile: false };
  }
  switch (state) {
    case "present": // at the desk → desktop now, park mobile until they leave
      return { desktop: true, mobileNow: false, deferMobile: !mobileViewingThis };
    case "away": // left the desk but Mac open → desktop now + mobile now
      return { desktop: true, mobileNow: !mobileViewingThis, deferMobile: false };
    case "gone":
    default: // desktop not running → mobile only
      return { desktop: false, mobileNow: !mobileViewingThis, deferMobile: false };
  }
}

// ---------------------------------------------------------------------------
// Event classification (pure) + dispatch (stateful)
// ---------------------------------------------------------------------------

/**
 * Whether a question is opencode's plan_exit approval — the "Plan ready"
 * handoff at the end of plan mode (BET-993). opencode's plan_exit question
 * literal starts with "Plan at " and carries header "Build Agent". We match
 * either so the detection survives opencode phrasing drift.
 */
function isPlanExitQuestion(q) {
  if (!q || typeof q !== "object") return false;
  const question = typeof q.question === "string" ? q.question : "";
  return question.startsWith("Plan at ") || q.header === "Build Agent";
}

// MantaUI's notification body for the plan_exit approval, replacing opencode's
// raw "Plan at <derived .md path>…" text so no opencode path ever leaks to the
// user. The plan page URL (BET-992) is appended when the box is addressable.
const PLAN_READY_BODY =
  "Your plan is ready to review — open it, then approve or keep planning.";

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
    case "permission.asked": {
      const requestId = typeof props.id === "string" ? props.id : null;
      const out = {
        kind: "permission",
        title: titleOr("Permission needed"),
        body: label
          ? "Permission needed — Claude wants to run a tool. Tap to review."
          : "Claude wants to run a tool. Tap to review.",
        sessionId,
        tag: `perm-${tagBase}`,
      };
      if (requestId) {
        out.requestId = requestId;
        // Static action set — permission replies are always these three, so the
        // client can pre-register them as a fixed notification category (unlike
        // question answers, whose titles vary per ask).
        out.actions = [
          { action: "allow-once", title: "Allow once" },
          { action: "allow-always", title: "Always allow" },
          { action: "deny", title: "Deny" },
        ];
      }
      return out;
    }
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
      // opencode's plan_exit approval is MantaUI's "Plan ready" handoff: swap
      // the raw "Plan at <path>.md…" question for a clean line + the plan page
      // URL (BET-992) when the box is addressable. Everything else is unchanged.
      const isPlan = isPlanExitQuestion(first);
      let qBody = first?.question || "Claude needs your input to continue.";
      if (isPlan) {
        const url = planPageUrl(sessionId, publicBaseUrl());
        qBody = url ? `${PLAN_READY_BODY}\n\n${url}` : PLAN_READY_BODY;
      }
      const out = {
        kind: "question",
        title: titleOr(
          first?.header ? `Claude: ${first.header}` : "Claude has a question",
        ),
        body: isPlan
          ? qBody
          : label && first?.header
            ? `${first.header} — ${qBody}`
            : qBody,
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
 * Pure: should a push be dropped? Either of two reasons, both meaning "the user
 * is not watching this session and has nothing actionable to land on":
 *
 * 1. The session can't be resolved to a tmux chat window (null label). Such a
 *    session is a SUBAGENT child (it inherited the parent's directory, runs on
 *    the same scoped /event stream, but has no `@manta-session-id` of its own)
 *    or a stale orphan — there is no chat for the user to land on, and the push
 *    would be a nameless notification that deep-links nowhere. Covers `done`,
 *    `error`, `permission`, and `question`.
 * 2. The session is a BACKGROUND JOB's own child (isBackgroundJob). The parent
 *    transcript already receives the job's completion report, so a `done`/`error`
 *    push for it is pure duplicate noise — but a `permission`/`question` means
 *    the job is BLOCKED and will sit forever until the user acts, so those stay.
 *
 * @param {{kind?: string}|null} payload  classifyPushEvent result
 * @param {string|null} label             resolved "workspace / session-name", or null
 * @param {boolean}     isBackgroundJob   true when this session is a background job's own child
 * @returns {boolean}
 */
export function shouldSuppressNotification(payload, label, isBackgroundJob) {
  const k = payload?.kind;
  if (isBackgroundJob === true) return k === "done" || k === "error";
  if (!label) return k === "done" || k === "error" || k === "permission" || k === "question";
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

// Is this opencode session a background job's own child session? Such a job
// reports its outcome into the parent's transcript, so a done/error push for
// it is pure duplicate noise. Best-effort: any failure returns false, so a
// broken store degrades to today's behaviour (notify) rather than silence.
async function isBackgroundJobSession(sessionId) {
  if (!sessionId) return false;
  try {
    const jobs = await loadJobs();
    return jobs.some((j) => j.childSessionID === sessionId);
  } catch {
    return false;
  }
}

// Sessions seen "busy" since their last idle — gates the "done" push so we
// don't notify on spurious idles. Keyed by sessionID.
const _busy = new Set();
// De-dupes raw opencode events (each arrives on both streams) — see seenIds.mjs.
const _seenEvents = createSeenIdFilter();
// Sessions with an unanswered question/permission. While present, the session's
// idle is "blocked on the user", not "done" — so the "done" push is suppressed
// (the question/permission push already told them to act).
const _pending = new Set();

// ---------------------------------------------------------------------------
// Desktop sink + deferred mobile delivery
// ---------------------------------------------------------------------------

let _desktopSink = null;

/** Inject the desktop notification sink (publishes to the bus). */
export function setDesktopSink(fn) {
  _desktopSink = typeof fn === "function" ? fn : null;
}

// Parked mobile-push deliveries keyed by tag (same-tag entry is overwritten).
const _deferredMobile = new Map();
/** Cancel every parked mobile delivery (user returned to the desk). */
export function cancelAllDeferredMobile() {
  _deferredMobile.clear();
}
/** Drop parked deliveries for one session (the ask was answered/resumed). */
export function cancelDeferredMobileForSession(sessionId) {
  if (!sessionId) return;
  for (const [tag, entry] of _deferredMobile) {
    if (entry.sessionId === sessionId) _deferredMobile.delete(tag);
  }
}

/** Test hook: tags with a parked mobile delivery. */
export function _deferredMobileTags() {
  return [..._deferredMobile.keys()];
}
/** Walk parked deliveries: deliver when away/gone; drop after 30 min; else leave. */
export async function flushDeferredMobile(now = Date.now()) {
  const STALE_DEFERRED_MS = 30 * 60_000;
  for (const [tag, entry] of [..._deferredMobile]) {
    const state = desktopState(_desktop, now);
    if (state === "away" || state === "gone") {
      _deferredMobile.delete(tag);
      await sendPush(entry.payload).catch((e) =>
        console.warn("[push] deferred send failed:", e?.message ?? e),
      );
    } else if (now - entry.deferredAt > STALE_DEFERRED_MS) {
      _deferredMobile.delete(tag);
    }
  }
}
/** 30s poller that flushes parked deliveries; started from index.mjs. */
export function startDeferredMobilePoller({ intervalMs = 30_000 } = {}) {
  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await flushDeferredMobile();
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** Fire routed legs: sink if desktop, sendPush now if mobileNow, else park it. */
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

  // A re-notify for the same tag supersedes any parked delivery.
  if (_deferredMobile.has(payload.tag)) _deferredMobile.delete(payload.tag);

  console.log(
    `[push] route kind=${payload.kind} sid=${payload.sessionId} ` +
      `→ desktop=${route.desktop} mobileNow=${route.mobileNow} ` +
      `deferMobile=${route.deferMobile}`,
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
  } else if (route.deferMobile) {
    _deferredMobile.set(payload.tag, {
      payload,
      sessionId: payload.sessionId ?? null,
      deferredAt: now,
    });
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
  // APNs is now the ONLY delivery leg (BET-559 removed the Web Push/VAPID leg
  // along with the retired PWA). Fire it and surface failures as warnings so a
  // gateway/HTTP error never throws out of the notification path.
  const apnsLeg = sendApnsFanout(payload).catch((e) =>
    console.warn("[push] apns fanout failed:", e?.message ?? e),
  );
  await apnsLeg;
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
const AUTH_PATH = statePath("auth.json");

async function readBoxGatewayIdentity() {
  const parsed = readJsonSync(AUTH_PATH, null);
  if (!parsed) return null;
  const box_id = typeof parsed.box_id === "string" ? parsed.box_id : null;
  const gateway_token =
    typeof parsed.gateway_token === "string" ? parsed.gateway_token : null;
  if (!box_id || !gateway_token) return null;
  return { box_id, gateway_token };
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
  const allValues = tokens.map((t) => t?.token).filter((t) => typeof t === "string");
  // Self-heal before sending: drop entries the gateway would reject (one invalid
  // token 400s the WHOLE batch) AND collapse case-insensitive duplicates (case is
  // insignificant, so a two-spelling store delivers twice) — same repair as the
  // invalid-token self-heal. `remove` is case-insensitive (see removeApnsToken).
  const pruneToken = _removeApnsTokenOverride ?? removeApnsToken;
  const survivors = new Set();
  const toPrune = [];
  for (const t of allValues) {
    if (!isValidApnsToken(t) || survivors.has(t.toLowerCase())) {
      toPrune.push(t);
    } else {
      survivors.add(t.toLowerCase());
    }
  }
  if (toPrune.length > 0) {
    for (const t of toPrune) {
      await pruneToken(t).catch(() => {});
    }
    console.warn(
      `[push] pruned ${toPrune.length} stored token(s): invalid or case-duplicate`,
    );
  }
  const tokenValues = [...survivors];
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
    // Each opencode event arrives on BOTH the global and scoped stream; drop one
    // already seen so one event = one notification (unless it has no id).
    if (_seenEvents.seen(evt?.id)) return;

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
        // The session resumed → the user is acting on it; cancel any parked
        // desktop→mobile delivery for it (don't buzz the phone for work
        // that's already moving again).
        cancelDeferredMobileForSession(sid);
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
        // The ask was answered → cancel its parked delivery.
        cancelDeferredMobileForSession(sid);
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
    const isJob = NOTIFYING.has(type) ? await isBackgroundJobSession(sid) : false;

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
    if (shouldSuppressNotification(payload, label, isJob)) {
      console.log(
        `[push] ${payload.kind} sid=${sid} ` +
          (isJob
            ? `suppressed=background-job (parent gets the completion report)`
            : `suppressed=unresolvable-session (no tmux @manta-session-id → subagent/orphan)`),
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
  cancelAllDeferredMobile();
  _desktopSink = null;
  _focus = { sessionId: null, visible: false };
  _desktop = { lastSeen: 0, idleSeconds: 0, lockedSeconds: null, awayAt: Infinity };
}
