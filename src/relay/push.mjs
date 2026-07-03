// push.mjs — the RELAY's native push delivery leg (M2, BET-36 Stage 5).
//
// WHAT THIS SLICE IS: the operated push leg. The box-side PWA push
// (src/server/push.mjs) decides — knowing both device presences — WHETHER a
// notification goes to desktop, mobile, both, or escalates; and it DELIVERS to
// mobile over Web Push (VAPID). The relay reuses that DECISION logic verbatim
// (import, never duplicate) but swaps the DELIVERY leg: instead of Web Push it
// speaks native APNs (iOS) / FCM (Android) so an App-Store build gets real push
// without a service worker.
//
// SEPARATION OF CONCERNS:
//   - DECISION (what to send, to which device, when) → imported from
//     src/server/push.mjs: routeNotification / notifTier / shouldSuppressForDesktop.
//     This file never re-implements the matrix; if the box-side rules change,
//     the relay's routing changes with them.
//   - DELIVERY (actually hitting APNs/FCM) → the PushSender interface below.
//     The DEFAULT sender is a STUB that records calls (and logs) so the whole
//     path is unit-testable with NO Apple/Google network. Live APNs cert / FCM
//     key provisioning is an explicit deploy-time human step: a production
//     sender is injected at start-up behind this same interface. NOTHING here
//     hardcodes a cert or key.
//   - DEVICE-TOKEN REGISTRATION: a phone POSTs its APNs/FCM token; we persist
//     account_id → {apns|fcm token} in the store (Stage-2 push_tokens table,
//     added by this slice). Delivery fans out to every token the target account
//     registered.
//
// TESTABILITY: createRelayPush({ store, sender, now }) is pure-ish — inject a
// store fake (or real in-memory openStore) + a recording sender. `deliver()`
// runs a payload through routeNotification and calls the sender only for the
// mobile leg; the desktop leg is out of the relay's scope (the relay has no
// desktop socket — that's the box↔desktop -L forward), so `route.desktop` is
// reported back but not acted on here. The register/lookup path is a thin
// wrapper over the store so a test asserts round-trips.

import {
  routeNotification,
  notifTier,
  shouldSuppressForDesktop,
} from "../server/push.mjs";

// Re-export the reused decision helpers so relay callers (and tests) import them
// from one place without reaching back into src/server. These are the SAME
// functions — no wrapping, no duplication.
export { routeNotification, notifTier, shouldSuppressForDesktop };

export const PUSH_PLATFORMS = Object.freeze(["apns", "fcm"]);

// ---------------------------------------------------------------------------
// PushSender interface + the default stub
// ---------------------------------------------------------------------------

/**
 * A PushSender delivers ONE notification to ONE device token on a platform.
 * Shape (both methods optional-but-expected):
 *   apns({ token, payload }) => Promise<{ ok, ... }>
 *   fcm({ token, payload })  => Promise<{ ok, ... }>
 *
 * The production sender (injected at deploy time) wraps `node-apn` / the FCM
 * HTTP v1 API behind this shape. The relay core never imports those directly,
 * so unit tests run with the stub and CI needs no Apple/Google credentials.
 */

/**
 * Build the default STUB sender: records every delivery and (optionally) logs.
 * Returns the sender plus a `.sent` array + `.reset()` for assertions. NEVER
 * touches the network. This is the default so a mis-wired relay in dev/CI logs
 * instead of throwing on a missing cert.
 *
 * @param {object} [opts]
 * @param {(...a:any[])=>void} [opts.log]  injectable logger (default console.log).
 * @param {boolean} [opts.failPlatform]  set 'apns'|'fcm' to simulate a delivery
 *   failure for that platform (tests exercise the prune/error path).
 */
export function createStubPushSender({ log = () => {}, failPlatform = null } = {}) {
  const sent = [];
  async function record(platform, { token, payload }) {
    const entry = { platform, token, payload, at: Date.now() };
    sent.push(entry);
    log(`[relay-push] STUB ${platform} → ${short(token)} kind=${payload?.kind ?? "?"}`);
    if (failPlatform === platform) {
      return { ok: false, error: "stub_forced_failure", platform, token };
    }
    return { ok: true, platform, token };
  }
  return {
    apns: (args) => record("apns", args),
    fcm: (args) => record("fcm", args),
    // test/diagnostic surface
    sent,
    reset() {
      sent.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Relay push core
// ---------------------------------------------------------------------------

/**
 * Create the relay's native push leg.
 *
 * @param {object} opts
 * @param {object} opts.store          a relay store (push_tokens accessors).
 * @param {object} [opts.sender]       a PushSender; default createStubPushSender.
 * @param {() => number} [opts.now=Date.now]
 * @param {(...a:any[])=>void} [opts.log]
 * @param {(...a:any[])=>void} [opts.warn]
 * @param {{ desktop?:any, focusSessionId?:string|null, focusVisible?:boolean }} [opts.presence]
 *   default cross-device presence used when a deliver() call omits its own. The
 *   relay has no live desktop socket, so absent a fresh desktop heartbeat the
 *   router routes informational notifs straight to mobile (desktop gone).
 */
export function createRelayPush(opts = {}) {
  const {
    store,
    sender = createStubPushSender(),
    now = () => Date.now(),
    log = console.log,
    warn = console.warn,
  } = opts;

  if (!store) throw new Error("createRelayPush: store required");

  // Default presence: no desktop heartbeat (the relay can't see the box↔desktop
  // -L forward), no mobile focus reported. routeNotification then treats desktop
  // as "gone" for informational notifs → mobile-only, which is the correct
  // relay default (the desktop leg is handled box-side, not here).
  const defaultPresence = {
    desktop: null,
    focusSessionId: null,
    focusVisible: false,
    ...(opts.presence || {}),
  };

  // -------------------------------------------------------------------------
  // device-token registration (thin wrapper over the store)
  // -------------------------------------------------------------------------

  /**
   * Register a phone's native device token. `platform` must be apns|fcm.
   * Overwrites the account's existing token for that platform (rotation).
   */
  function register({ accountId, platform, token }) {
    return store.registerPushToken({ accountId, platform, token }, { at: now() });
  }

  /** All device-token rows for an account. */
  function tokensFor(accountId) {
    try {
      return store.listPushTokensForAccount(accountId) || [];
    } catch {
      return [];
    }
  }

  function unregister(accountId, platform) {
    return store.unregisterPushToken(accountId, platform);
  }

  // -------------------------------------------------------------------------
  // deliver — the route → send bridge
  // -------------------------------------------------------------------------

  /**
   * Route a notification payload across devices and, when the router says to
   * push mobile NOW, fan it out to every native token the target account
   * registered. Returns a summary { route, delivered: [...], suppressed?:reason }.
   *
   * The relay owns only the mobile-native leg. `route.desktop` and any
   * `escalateAfterMs` are reported back for the caller/box to handle (the box
   * runs the desktop sink + the escalation timer); the relay does not sit on a
   * timer here — an operated push service escalates via the box-side pump, not
   * by holding relay memory across a phone's lifetime.
   *
   * @param {object} args
   * @param {string} args.accountId  the target account (owns the device tokens).
   * @param {{kind?:string, urgent?:boolean, sessionId?:string|null, title?:string, body?:string, tag?:string}} args.payload
   * @param {object} [args.presence]  override the default cross-device presence.
   */
  async function deliver({ accountId, payload, presence } = {}) {
    if (!accountId) throw new Error("deliver: accountId required");
    if (!payload || typeof payload !== "object") {
      throw new Error("deliver: payload object required");
    }
    const route = routeNotification(payload, presence || defaultPresence, now());

    log(
      `[relay-push] route acct=${short(accountId)} kind=${payload.kind ?? "?"} ` +
        `→ desktop=${route.desktop} mobileNow=${route.mobileNow} ` +
        `escalateMs=${route.escalateAfterMs ?? "-"}`,
    );

    if (!route.mobileNow) {
      // Not a mobile-now delivery — either desktop-only or an escalation the
      // box-side pump owns. Report the decision; deliver nothing native here.
      return { route, delivered: [], suppressed: "not_mobile_now" };
    }

    const tokens = tokensFor(accountId);
    if (tokens.length === 0) {
      return { route, delivered: [], suppressed: "no_device_tokens" };
    }

    const delivered = [];
    await Promise.all(
      tokens.map(async (row) => {
        const platform = row.platform;
        const fn = sender[platform];
        if (typeof fn !== "function") {
          warn(`[relay-push] no sender for platform ${platform}; skipping`);
          return;
        }
        try {
          const res = await fn({ token: row.token, payload });
          if (res && res.ok === false) {
            // Delivery rejected (bad/expired token). Prune it so a dead token
            // doesn't linger (mirrors the Web-Push 404/410 prune box-side).
            warn(
              `[relay-push] ${platform} delivery failed for ${short(row.token)}: ` +
                `${res.error ?? "unknown"}; pruning token`,
            );
            try {
              unregister(accountId, platform);
            } catch {
              /* best-effort prune */
            }
            return;
          }
          delivered.push({ platform, token: row.token });
        } catch (err) {
          warn(
            `[relay-push] ${platform} send threw for ${short(row.token)}: ` +
              `${err?.message ?? err}`,
          );
        }
      }),
    );

    return { route, delivered };
  }

  return {
    register,
    unregister,
    tokensFor,
    deliver,
    // exposed for tests / diagnostics
    _sender: sender,
    _defaultPresence: defaultPresence,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Device tokens are long opaque strings; log only a short prefix.
function short(token) {
  return typeof token === "string" ? `${token.slice(0, 8)}…` : String(token);
}
