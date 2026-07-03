// metering.mjs — per-box byte metering + rate limiting (M2, BET-36 Stage 5).
//
// WHAT THIS SLICE IS: the COGS instrument. Every phone→box request the relay
// proxies (api.mjs) carries bytes in (the phone's request) and bytes out (the
// box's response). This module accumulates those two counters per box_id in the
// Stage-2 store (the `metering` table this Stage added) and enforces a per-box
// token-bucket rate limit, reusing `createRateLimiter` from
// src/server/webhooks.mjs (import, never duplicate) with a free-tier vs
// post-subscription cap.
//
// WHY per box_id (not per account): the box_id is the metered unit — it's the
// compute the user brings, and the number the operator bills/limits on. An
// account can own several boxes; each meters independently.
//
// TWO KNOBS, both config:
//   1. BYTE COUNTERS — pure accounting, persisted via store.addUsage. No cap is
//      enforced on bytes here (billing/alerting reads store.getUsage); this
//      slice provides the accurate counters that a later billing slice consults.
//   2. RATE LIMIT — a token bucket per box. FREE-tier boxes (no active
//      subscription) get a conservative bucket; POST-SUB boxes get a larger
//      one. The caller passes `paid` (from the Stage-4 subscription gate) so the
//      right bucket applies. Numbers are documented constants below and can be
//      overridden via createBoxMeter opts.
//
// TESTABILITY: createBoxMeter({ store, now, ... }) with an in-memory store +
// injectable clock. `record(boxId, {ingress, egress})` bumps the counters and
// returns the running total. `allow(boxId, { paid })` returns bool (rate
// verdict). `meterProxy(boxId, req, resp, { paid })` is the one-call helper the
// proxy path uses: it measures req/resp byte sizes, records them, and returns
// the rate verdict — so api.mjs wires metering in ONE place.

import { createRateLimiter } from "../server/webhooks.mjs";

// ---------------------------------------------------------------------------
// Rate-limit caps (documented, overridable via opts)
// ---------------------------------------------------------------------------
//
// A token bucket: `capacity` = burst allowance, `refillPerSec` = sustained
// requests/second once the burst is spent. Free is deliberately tight (enough
// to render the metadata preview + poll, not to stream); paid is generous
// enough for live transcript + prompt traffic. These are per-box.

export const FREE_RL_CAPACITY = 30; // burst of 30 requests…
export const FREE_RL_REFILL_PER_SEC = 1; // …then 1 req/sec sustained (free tier)

export const PAID_RL_CAPACITY = 240; // burst of 240 requests…
export const PAID_RL_REFILL_PER_SEC = 20; // …then 20 req/sec sustained (subscribed)

// ---------------------------------------------------------------------------
// Byte sizing (pure)
// ---------------------------------------------------------------------------

/**
 * Best-effort byte size of a proxied HTTP message (method+path+headers+body).
 * The relay meters the on-the-wire-ish size: the body bytes plus a small,
 * deterministic accounting of the request line + header pairs, so an empty-body
 * metadata GET still costs a few bytes and a big transcript POST costs its body.
 * Pure + exported so a test pins the sizing.
 *
 * @param {{method?:string, path?:string, headers?:object, body?:any}} msg
 * @returns {number} non-negative integer byte count.
 */
export function messageBytes(msg) {
  if (!msg || typeof msg !== "object") return 0;
  let total = 0;
  if (typeof msg.method === "string") total += Buffer.byteLength(msg.method);
  if (typeof msg.path === "string") total += Buffer.byteLength(msg.path);
  const headers = msg.headers;
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      total += Buffer.byteLength(String(k));
      total += Buffer.byteLength(String(v ?? ""));
    }
  }
  total += bodyBytes(msg.body);
  // Also count the response status when present (box→phone responses).
  if (typeof msg.status === "number") total += 3;
  return total;
}

/** Byte size of a body that may be a string, Buffer, or JSON-serializable. */
export function bodyBytes(body) {
  if (body == null) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.length;
  if (body instanceof Uint8Array) return body.byteLength;
  try {
    return Buffer.byteLength(JSON.stringify(body));
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Box meter
// ---------------------------------------------------------------------------

/**
 * Create the per-box meter.
 *
 * @param {object} opts
 * @param {object} opts.store  a relay store (addUsage / getUsage).
 * @param {() => number} [opts.now=Date.now]
 * @param {object} [opts.free]  { capacity, refillPerSec } free-tier bucket.
 * @param {object} [opts.paid]  { capacity, refillPerSec } paid-tier bucket.
 * @param {(...a:any[])=>void} [opts.warn]
 */
export function createBoxMeter(opts = {}) {
  const {
    store,
    now = () => Date.now(),
    free = { capacity: FREE_RL_CAPACITY, refillPerSec: FREE_RL_REFILL_PER_SEC },
    paid = { capacity: PAID_RL_CAPACITY, refillPerSec: PAID_RL_REFILL_PER_SEC },
    warn = console.warn,
  } = opts;

  if (!store) throw new Error("createBoxMeter: store required");

  // Two independent buckets. A box's verdict comes from the bucket matching its
  // current entitlement — but each box_id has ONE bucket per tier, keyed by
  // box_id, so switching tiers doesn't reset the other tier's state.
  const freeLimiter =
    opts.freeLimiter ||
    createRateLimiter({ capacity: free.capacity, refillPerSec: free.refillPerSec, now });
  const paidLimiter =
    opts.paidLimiter ||
    createRateLimiter({ capacity: paid.capacity, refillPerSec: paid.refillPerSec, now });

  /**
   * Record byte usage for a box (creating its counter row on first sight).
   * Returns the updated running total { box_id, ingress, egress, updated_at }.
   */
  function record(boxId, { ingress = 0, egress = 0 } = {}) {
    try {
      return store.addUsage(boxId, { ingress, egress }, { at: now() });
    } catch (err) {
      // A metering write must never break the proxy path — log + continue.
      warn(`[relay-metering] record failed for box ${short(boxId)}: ${err?.message ?? err}`);
      return null;
    }
  }

  /** Current usage totals for a box, or null. */
  function usage(boxId) {
    try {
      return store.getUsage(boxId);
    } catch {
      return null;
    }
  }

  /**
   * Rate verdict for one request from a box. `paid` selects the bucket (from the
   * Stage-4 subscription gate). Returns true to allow, false to throttle (the
   * caller maps false → 429).
   */
  function allow(boxId, { paid: isPaid = false } = {}) {
    const limiter = isPaid ? paidLimiter : freeLimiter;
    return limiter(`box:${boxId}`);
  }

  /**
   * The one-call proxy-path helper. Measures the phone's request (ingress) and
   * the box's response (egress), records both, and returns the rate verdict for
   * this request. api.mjs calls this once per proxied request so metering lives
   * in a single place.
   *
   * @param {string} boxId
   * @param {object} req   the normalized phone request ({method,path,headers,body}).
   * @param {object} [resp] the box response ({status,headers,body}); may be
   *   omitted on the pre-flight rate check and supplied after the round-trip.
   * @param {{paid?:boolean}} [o]
   * @returns {{ allowed:boolean, ingress:number, egress:number, total:object|null }}
   */
  function meterProxy(boxId, req, resp, { paid: isPaid = false } = {}) {
    const ingress = messageBytes(req);
    const egress = resp ? messageBytes(resp) : 0;
    const total = record(boxId, { ingress, egress });
    const allowed = allow(boxId, { paid: isPaid });
    return { allowed, ingress, egress, total };
  }

  return {
    record,
    usage,
    allow,
    meterProxy,
    messageBytes,
    // exposed for tests / diagnostics
    _freeLimiter: freeLimiter,
    _paidLimiter: paidLimiter,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function short(boxId) {
  return typeof boxId === "string" ? boxId.slice(0, 8) : String(boxId);
}
