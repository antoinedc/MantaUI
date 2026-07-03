// iap.mjs — Apple IAP receipt validation + box binding (M2, BET-36 Stage 5).
//
// WHAT THIS SLICE IS: the "did this box's owner actually pay" leg. A phone
// submits an Apple receipt; the relay validates it, extracts the subscription's
// original_transaction_id, and binds receipt → box_id in the Stage-2 store.
// Once a valid, unexpired receipt is bound to a box, the Stage-4 subscription
// gate (api.mjs createDefaultSubscriptionCheck) flips that box's gated subpaths
// from 402 → pass-through. THIS file is what fills the `receipts` table Stage 2
// created; the gate seam consulting it is unchanged.
//
// APPLE SHAPE (StoreKit 2 / App Store Server Notifications v2):
//   Apple no longer ships the old base64 `latest_receipt`; the modern surface is
//   JWS (JSON Web Signature, compact `header.payload.signature`). Two inbound
//   flavours, both landing here:
//     1. client submit  → POST /api/iap/validate  with a `signedTransactionInfo`
//        JWS (the StoreKit 2 `Transaction.jwsRepresentation`).
//     2. Apple webhook   → POST /api/iap/renewed   an App Store Server
//        Notification v2: a `signedPayload` JWS whose decoded body has
//        `data.signedTransactionInfo` (another JWS) — a RENEWAL/expiry event.
//   The JWS header carries an `x5c` cert chain (leaf → intermediate → Apple
//   root). Real validation = verify that chain up to Apple's G3 root AND verify
//   the JWS signature with the leaf's public key.
//
// WHAT'S DEFERRED TO LIVE PROVISIONING (documented, gated behind the verifier):
//   Verifying the x5c chain against Apple's ACTUAL root cert requires the Apple
//   Root CA - G3 cert to be provisioned on the box at deploy time (a human
//   step, same class as the APNs cert in push.mjs). Until it's provisioned, the
//   default verifier validates STRUCTURE (three-part JWS, decodable header with
//   an x5c array, decodable JSON payload) + EXPIRY, and treats the crypto
//   signature check as "not yet enforced" — logged once, loud. A production
//   verifier (injected: `verifyJws`) does the full x5c-chain + signature check.
//   The seam is `createReceiptValidator({ verifyJws })`; nothing else changes
//   when live keys land. We NEVER hardcode a cert here.
//
// TESTABILITY: everything is pure + injectable. `parseJws` / `decodeJwsPayload`
// operate on strings. `createReceiptValidator({ verifyJws, now })` takes an
// injectable crypto verifier (default = structural-only) and clock, so a test
// drives a valid fixture → bound, an expired one → rejected, and a malformed
// one → rejected, with the crypto stubbed. `bindReceipt(store, ...)` is the one
// store-touching function.

// ---------------------------------------------------------------------------
// JWS parsing (pure, no crypto — structure only)
// ---------------------------------------------------------------------------

/** base64url → utf8 string. Returns null on malformed input. */
function b64urlToString(seg) {
  if (typeof seg !== "string" || !seg) return null;
  try {
    // Buffer accepts base64url directly on modern Node; normalize defensively.
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Split + decode a compact JWS `header.payload.signature`. Returns
 * { header, payload, signature, raw } with header/payload as parsed JSON, or
 * null if the string isn't a well-formed three-part JWS with JSON segments.
 * NO signature verification — that's the injectable verifier's job.
 *
 * @param {string} jws
 */
export function parseJws(jws) {
  if (typeof jws !== "string" || !jws) return null;
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const headerStr = b64urlToString(h);
  const payloadStr = b64urlToString(p);
  if (headerStr == null || payloadStr == null || !sig) return null;
  let header;
  let payload;
  try {
    header = JSON.parse(headerStr);
    payload = JSON.parse(payloadStr);
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;
  if (!payload || typeof payload !== "object") return null;
  return { header, payload, signature: sig, raw: jws };
}

/**
 * Convenience: parse a JWS and return just its decoded payload object, or null.
 */
export function decodeJwsPayload(jws) {
  return parseJws(jws)?.payload ?? null;
}

// ---------------------------------------------------------------------------
// Transaction field extraction (Apple field names → our normalized shape)
// ---------------------------------------------------------------------------

/**
 * Normalize an Apple decoded transaction payload into the fields the store
 * needs. Apple uses `originalTransactionId`, `productId`, and `expiresDate`
 * (ms since epoch). Returns { originalTransactionId, productId, expiresAt } or
 * null when the mandatory originalTransactionId is missing.
 */
export function extractTransaction(payload) {
  if (!payload || typeof payload !== "object") return null;
  const otid =
    payload.originalTransactionId ??
    payload.original_transaction_id ??
    null;
  if (typeof otid !== "string" || !otid) return null;
  const productId =
    payload.productId ?? payload.product_id ?? null;
  // Apple expiresDate is ms since epoch. A non-consumable / lifetime purchase
  // has no expiry → null (the gate treats null as "never expires").
  const rawExp = payload.expiresDate ?? payload.expires_date ?? null;
  const expiresAt =
    rawExp == null || rawExp === ""
      ? null
      : Number.isFinite(Number(rawExp))
        ? Number(rawExp)
        : null;
  return {
    originalTransactionId: otid,
    productId: typeof productId === "string" ? productId : null,
    expiresAt,
  };
}

/**
 * From an App Store Server Notification v2 (`signedPayload` JWS), reach the
 * inner `data.signedTransactionInfo` JWS and decode ITS transaction payload.
 * Returns the decoded inner transaction payload, or null.
 */
export function extractNotificationTransaction(signedPayloadJws) {
  const outer = decodeJwsPayload(signedPayloadJws);
  if (!outer || typeof outer !== "object") return null;
  const inner =
    outer?.data?.signedTransactionInfo ??
    outer?.data?.signed_transaction_info ??
    null;
  if (typeof inner !== "string" || !inner) return null;
  return decodeJwsPayload(inner);
}

// ---------------------------------------------------------------------------
// Crypto verifier seam (structural default; live x5c verifier injected)
// ---------------------------------------------------------------------------

/**
 * Build the default STRUCTURAL JWS verifier. It confirms the JWS parses, its
 * header declares an x5c cert chain (a non-empty array), and the payload
 * decodes — but does NOT verify the x5c chain against Apple's root or check the
 * signature bytes. That full check needs the Apple Root CA - G3 cert
 * provisioned at deploy time (a human step); until then this returns
 * `{ ok: true, verified: false }` and logs once so it's obvious in prod logs
 * that crypto enforcement is pending. A production verifier (full x5c chain +
 * signature) is injected as `verifyJws` and returns `{ ok, verified: true }`.
 *
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.warn]
 * @returns {(jws:string)=>{ ok:boolean, verified:boolean, reason?:string }}
 */
export function createStructuralJwsVerifier({ warn = console.warn } = {}) {
  let warnedDeferred = false;
  return function verifyStructural(jws) {
    const parsed = parseJws(jws);
    if (!parsed) return { ok: false, verified: false, reason: "malformed_jws" };
    const x5c = parsed.header?.x5c;
    if (!Array.isArray(x5c) || x5c.length === 0) {
      return { ok: false, verified: false, reason: "missing_x5c" };
    }
    if (!warnedDeferred) {
      warnedDeferred = true;
      warn(
        "[relay-iap] STRUCTURAL-ONLY receipt verification: x5c chain + signature " +
          "NOT cryptographically verified. Provision the Apple Root CA - G3 cert " +
          "and inject verifyJws before production.",
      );
    }
    return { ok: true, verified: false };
  };
}

// ---------------------------------------------------------------------------
// Receipt validator (JWS → normalized transaction, gated by the verifier)
// ---------------------------------------------------------------------------

/**
 * Build a receipt validator.
 *
 * @param {object} [opts]
 * @param {(jws:string)=>{ok:boolean,verified?:boolean,reason?:string}} [opts.verifyJws]
 *   crypto verifier seam; default createStructuralJwsVerifier().
 * @param {() => number} [opts.now=Date.now]  injectable clock (ms).
 * @param {(msg:string)=>void} [opts.warn]
 */
export function createReceiptValidator({ verifyJws, now = () => Date.now(), warn = console.warn } = {}) {
  const verify = verifyJws || createStructuralJwsVerifier({ warn });

  /**
   * Validate a client-submitted transaction JWS (StoreKit 2
   * jwsRepresentation). Returns:
   *   { ok:true, transaction:{originalTransactionId,productId,expiresAt}, verified }
   *   { ok:false, reason }
   *
   * `verified` reflects whether crypto was actually enforced (false under the
   * structural default). An EXPIRED transaction is rejected here so an old
   * receipt can't (re)open the gate.
   */
  function validate(jws) {
    const v = verify(jws);
    if (!v || v.ok !== true) {
      return { ok: false, reason: v?.reason || "verify_failed" };
    }
    const payload = decodeJwsPayload(jws);
    const tx = extractTransaction(payload);
    if (!tx) return { ok: false, reason: "no_transaction" };
    if (tx.expiresAt != null && tx.expiresAt <= now()) {
      return { ok: false, reason: "expired", transaction: tx, verified: !!v.verified };
    }
    return { ok: true, transaction: tx, verified: !!v.verified };
  }

  /**
   * Validate an App Store Server Notification v2 (`signedPayload` JWS) whose
   * inner data.signedTransactionInfo carries the renewal transaction. Same
   * result shape as validate(). The OUTER notification JWS is verified for
   * structure/crypto; the inner transaction JWS is verified too (both must
   * pass), then the inner transaction is extracted + expiry-checked.
   */
  function validateNotification(signedPayloadJws) {
    const vOuter = verify(signedPayloadJws);
    if (!vOuter || vOuter.ok !== true) {
      return { ok: false, reason: vOuter?.reason || "verify_failed_outer" };
    }
    const outer = decodeJwsPayload(signedPayloadJws);
    const innerJws =
      outer?.data?.signedTransactionInfo ??
      outer?.data?.signed_transaction_info ??
      null;
    if (typeof innerJws !== "string" || !innerJws) {
      return { ok: false, reason: "no_inner_transaction" };
    }
    const vInner = verify(innerJws);
    if (!vInner || vInner.ok !== true) {
      return { ok: false, reason: vInner?.reason || "verify_failed_inner" };
    }
    const tx = extractTransaction(decodeJwsPayload(innerJws));
    if (!tx) return { ok: false, reason: "no_transaction" };
    if (tx.expiresAt != null && tx.expiresAt <= now()) {
      return { ok: false, reason: "expired", transaction: tx, verified: !!vInner.verified };
    }
    return {
      ok: true,
      transaction: tx,
      // notificationType surfaced so a caller can distinguish RENEWAL / EXPIRED
      // / REVOKE etc. (Apple v2 puts it on the outer payload).
      notificationType: typeof outer?.notificationType === "string"
        ? outer.notificationType
        : null,
      verified: !!vInner.verified,
    };
  }

  return { validate, validateNotification, _verify: verify };
}

// ---------------------------------------------------------------------------
// Binding a validated receipt to a box (the one store-touching function)
// ---------------------------------------------------------------------------

/**
 * Bind a validated transaction to a box_id in the store. The box row must exist
 * first (FK) — a phone that submits a receipt for a box has necessarily paired
 * it, so the box has dialed in. Stores the raw JWS verbatim for audit.
 *
 * @param {object} store  a relay store (upsertReceipt).
 * @param {object} args
 * @param {string} args.boxId
 * @param {{originalTransactionId:string, productId:string|null, expiresAt:number|null}} args.transaction
 * @param {string} [args.raw]  the original JWS, stored for audit.
 * @param {() => number} [args.now=Date.now]
 * @returns the stored receipt row.
 */
export function bindReceipt(store, { boxId, transaction, raw = null } = {}, { now = () => Date.now() } = {}) {
  if (!store) throw new Error("bindReceipt: store required");
  if (!transaction || !transaction.originalTransactionId) {
    throw new Error("bindReceipt: transaction.originalTransactionId required");
  }
  return store.upsertReceipt(
    {
      originalTransactionId: transaction.originalTransactionId,
      boxId,
      productId: transaction.productId ?? null,
      expiresAt: transaction.expiresAt ?? null,
      raw,
    },
    { at: now() },
  );
}
