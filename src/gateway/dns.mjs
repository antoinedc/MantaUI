// dns.mjs — OVH DNS client for the gateway service.
//
// When a box registers with the gateway, the gateway creates an A record
// `<box_id>.boxes.mantaui.com → <box public IP>` in OVH's DNS zone, so the
// phone/desktop can connect to the box via `https://<box_id>.boxes.mantaui.com`
// (Caddy on the box terminates TLS). On re-registration with a changed IP,
// the same record is updated (PUT by id, no zone search required).
//
// OVH's request-signing formula (per https://eu.api.ovh.com/1.0/):
//   signature = "$1$" + hex(SHA1(applicationSecret + "+" + consumerKey +
//                                "+" + method + "+" + url + "+" + body))
// Headers on every call:
//   X-Ovh-Application: <applicationKey>
//   X-Ovh-Consumer:    <consumerKey>
//   X-Ovh-Timestamp:   <unix-seconds>
//   X-Ovh-Signature:   <the signature above>
// The signature covers the FULL url (scheme+host+path+query), the METHOD
// (uppercase), and the raw BODY (empty string for GET / PUT without body).
//
// All network I/O goes through an injectable `fetchImpl(url, opts)` so tests
// never hit OVH. The default uses the global `fetch` (Node 18+ has it
// built-in). OVH creds come from env: OVH_APP_KEY, OVH_APP_SECRET,
// OVH_CONSUMER_KEY — loaded by systemd EnvironmentFile=/etc/manta-gateway/ovh.env.

import { createHash } from "node:crypto";

export const OVH_DEFAULT_ENDPOINT = "https://eu.api.ovh.com/1.0";
export const OVH_ZONE = "mantaui.com";
export const OVH_RECORD_FIELD_TYPE = "A";
export const OVH_RECORD_TTL = 0; // 0 = use zone SOA default (auto)

// Compute the OVH sub-domain for a box_id. OVH wants the relative name
// (NOT including the zone): `<box_id>.boxes`. Pure helper — also exported
// so the gateway's /register route can build the sub-domain it passes to
// createOrUpdate.
export function ovhSubDomainFor(box_id) {
  if (typeof box_id !== "string" || !box_id) {
    throw new Error("ovhSubDomainFor: box_id required");
  }
  return `${box_id}.boxes`;
}

// ---------------------------------------------------------------------------
// Signature (pure, deterministic, fully testable)
// ---------------------------------------------------------------------------

// Compute the OVH `$1$<sha1_hex>` signature for one request.
//
// @param {string} appSecret
// @param {string} consumerKey
// @param {string} method      UPPERCASE ("GET", "POST", "PUT", "DELETE")
// @param {string} url         Full URL (scheme+host+path+query, no fragment)
// @param {string} body        Raw request body ("" when none — GET, or PUT/POST without a body)
//
// Returns the value to put in the `X-Ovh-Signature` header.
export function ovhSignature({ appSecret, consumerKey, method, url, body }) {
  if (typeof appSecret !== "string" || !appSecret) {
    throw new Error("ovhSignature: appSecret required");
  }
  if (typeof consumerKey !== "string" || !consumerKey) {
    throw new Error("ovhSignature: consumerKey required");
  }
  if (typeof method !== "string" || !method) {
    throw new Error("ovhSignature: method required");
  }
  if (typeof url !== "string" || !url) {
    throw new Error("ovhSignature: url required");
  }
  const b = typeof body === "string" ? body : "";
  const sha = createHash("sha1")
    .update(appSecret)
    .update("+")
    .update(consumerKey)
    .update("+")
    .update(method.toUpperCase())
    .update("+")
    .update(url)
    .update("+")
    .update(b)
    .digest("hex");
  return `$1$${sha}`;
}

// Compose the five auth headers for one OVH call. `timestamp` injectable so
// tests pin the value (the server-side timestamp drifts).
export function ovhHeaders({ appKey, appSecret, consumerKey, method, url, body, timestamp }) {
  const ts =
    typeof timestamp === "number"
      ? String(Math.floor(timestamp))
      : String(Math.floor(Date.now() / 1000));
  return {
    "X-Ovh-Application": appKey,
    "X-Ovh-Consumer": consumerKey,
    "X-Ovh-Timestamp": ts,
    "X-Ovh-Signature": ovhSignature({
      appSecret,
      consumerKey,
      method,
      url,
      body,
      timestamp: ts,
    }),
    "Content-Type": "application/json",
  };
}

// Resolve which fields the gateway needs from process.env. Exported so the
// caller (index.mjs) can fail fast at startup if any are missing. The env
// vars are loaded from /etc/manta-gateway/ovh.env by the systemd unit.
export function ovhCredsFromEnv(env = process.env) {
  const appKey = env.OVH_APP_KEY;
  const appSecret = env.OVH_APP_SECRET;
  const consumerKey = env.OVH_CONSUMER_KEY;
  const endpoint = env.OVH_ENDPOINT || OVH_DEFAULT_ENDPOINT;
  if (!appKey || !appSecret || !consumerKey) {
    return {
      ok: false,
      error:
        "OVH creds missing (need OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY; loaded from /etc/manta-gateway/ovh.env)",
    };
  }
  return { ok: true, appKey, appSecret, consumerKey, endpoint };
}

// ---------------------------------------------------------------------------
// High-level: create / update / refresh
// ---------------------------------------------------------------------------

// POST /domain/zone/<zone>/record — create one A record. Returns the OVH
// record id (number) on success.
//
// `boxId` is the 32-hex box_id; `subDomain` is the relative name WITHOUT
// the zone ("<box_id>.boxes"). OVH returns the record id as a JSON
// number; we forward it verbatim.
export async function createRecord({
  boxId,
  subDomain,
  target,
  fetchImpl = globalThis.fetch,
  creds,
  zone = OVH_ZONE,
  fieldType = OVH_RECORD_FIELD_TYPE,
  ttl = OVH_RECORD_TTL,
  timestamp,
}) {
  if (typeof boxId !== "string" || !boxId) throw new Error("createRecord: boxId required");
  if (typeof subDomain !== "string" || !subDomain) throw new Error("createRecord: subDomain required");
  if (typeof target !== "string" || !target) throw new Error("createRecord: target required");
  if (!creds) throw new Error("createRecord: creds required");
  if (typeof fetchImpl !== "function") throw new Error("createRecord: fetchImpl required");

  const url = `${creds.endpoint}/domain/zone/${zone}/record`;
  const body = JSON.stringify({ fieldType, subDomain, target, ttl });
  const res = await fetchImpl(url, {
    method: "POST",
    headers: ovhHeaders({
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      consumerKey: creds.consumerKey,
      method: "POST",
      url,
      body,
      timestamp,
    }),
    body,
  });
  if (!res || res.ok !== true) {
    const status = res?.status ?? 0;
    const errBody = res?.body ?? res?.text ?? null;
    throw new Error(`OVH createRecord failed: status=${status} body=${JSON.stringify(errBody)}`);
  }
  const id = res.body;
  if (typeof id !== "number" && typeof id !== "string") {
    throw new Error(`OVH createRecord: unexpected id shape: ${JSON.stringify(id)}`);
  }
  return Number(id);
}

// PUT /domain/zone/<zone>/record/<id> — update the target of an existing
// record. Returns true on 2xx, throws on failure.
export async function updateRecord({
  recordId,
  subDomain,
  target,
  fetchImpl = globalThis.fetch,
  creds,
  zone = OVH_ZONE,
  fieldType = OVH_RECORD_FIELD_TYPE,
  ttl = OVH_RECORD_TTL,
  timestamp,
}) {
  if (typeof recordId !== "number" && typeof recordId !== "string") {
    throw new Error("updateRecord: recordId required");
  }
  if (typeof subDomain !== "string" || !subDomain) throw new Error("updateRecord: subDomain required");
  if (typeof target !== "string" || !target) throw new Error("updateRecord: target required");
  if (!creds) throw new Error("updateRecord: creds required");
  if (typeof fetchImpl !== "function") throw new Error("updateRecord: fetchImpl required");

  const id = Number(recordId);
  const url = `${creds.endpoint}/domain/zone/${zone}/record/${id}`;
  const body = JSON.stringify({ fieldType, subDomain, target, ttl });
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: ovhHeaders({
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      consumerKey: creds.consumerKey,
      method: "PUT",
      url,
      body,
      timestamp,
    }),
    body,
  });
  if (!res || res.ok !== true) {
    const status = res?.status ?? 0;
    const errBody = res?.body ?? res?.text ?? null;
    throw new Error(`OVH updateRecord failed: status=${status} body=${JSON.stringify(errBody)}`);
  }
  return true;
}

// POST /domain/zone/<zone>/refresh — push the pending changes to OVH's
// resolvers. Without this, the new/updated A record sits in OVH's queue
// for ~120s before propagation. We call refresh after every create/update
// so the box's public hostname resolves within seconds.
export async function refreshZone({
  fetchImpl = globalThis.fetch,
  creds,
  zone = OVH_ZONE,
  timestamp,
}) {
  if (!creds) throw new Error("refreshZone: creds required");
  if (typeof fetchImpl !== "function") throw new Error("refreshZone: fetchImpl required");
  const url = `${creds.endpoint}/domain/zone/${zone}/refresh`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: ovhHeaders({
      appKey: creds.appKey,
      appSecret: creds.appSecret,
      consumerKey: creds.consumerKey,
      method: "POST",
      url,
      body: "",
      timestamp,
    }),
  });
  if (!res || res.ok !== true) {
    const status = res?.status ?? 0;
    const errBody = res?.body ?? res?.text ?? null;
    throw new Error(`OVH refreshZone failed: status=${status} body=${JSON.stringify(errBody)}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// createOrUpdate — single entry point the /register route calls
// ---------------------------------------------------------------------------

// Idempotent: if the store already has an `ovhRecordId`, PUT a target
// update; otherwise POST a new record and persist the returned id. Always
// refreshes the zone after a write.
//
// Returns { recordId, action: "create" | "update" }.
export async function createOrUpdate({
  boxId,
  subDomain,
  target,
  existingRecordId = null,
  fetchImpl = globalThis.fetch,
  creds,
}) {
  if (!creds) throw new Error("createOrUpdate: creds required");
  if (typeof fetchImpl !== "function") throw new Error("createOrUpdate: fetchImpl required");

  let recordId;
  let action;
  if (existingRecordId != null) {
    await updateRecord({
      recordId: existingRecordId,
      subDomain,
      target,
      fetchImpl,
      creds,
    });
    recordId = existingRecordId;
    action = "update";
  } else {
    recordId = await createRecord({
      boxId,
      subDomain,
      target,
      fetchImpl,
      creds,
    });
    action = "create";
  }
  await refreshZone({ fetchImpl, creds });
  return { recordId, action };
}
