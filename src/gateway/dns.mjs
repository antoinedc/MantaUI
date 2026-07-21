// dns.mjs — Cloudflare DNS client for the gateway service.
//
// When a box registers with the gateway, the gateway creates an A record
// `<box_id>.boxes.mantaui.com → <box public IP>` in the `mantaui.com`
// Cloudflare zone, so the phone/desktop can connect to the box via
// `https://<box_id>.boxes.mantaui.com` (Caddy on the box terminates TLS via
// Let's Encrypt HTTP-01). On re-registration with a changed IP the same
// record is updated (PUT by id — the store keeps the record id, so no zone
// search is needed).
//
// Cloudflare's API is a plain REST surface authenticated with a single
// bearer token (no request-signing formula like OVH). The token must have
// Zone:DNS:Edit on the mantaui.com zone.
//   POST   /zones/<zone>/dns_records            create
//   PUT    /zones/<zone>/dns_records/<id>       update target
//   (no separate "refresh" step — Cloudflare propagates immediately.)
//
// Records are created UNPROXIED (`proxied: false`): the phone connects
// straight to the box's IP and the box's own Caddy terminates TLS, so the
// record must be a grey-cloud A record, not an orange-cloud proxy.
//
// All network I/O goes through an injectable `fetchImpl(url, opts)` so tests
// never hit Cloudflare. The default uses the global `fetch`. Creds come from
// env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID — loaded by systemd
// EnvironmentFile=/etc/manta-gateway/cloudflare.env.

export const CF_DEFAULT_ENDPOINT = "https://api.cloudflare.com/client/v4";
export const DNS_ZONE = "mantaui.com";
export const DNS_RECORD_TYPE = "A";
// TTL 60s — records change only when a box's IP changes (rare); a short TTL
// keeps a moved box reachable quickly. 1 = "automatic" in Cloudflare, but we
// want a concrete short value for box-IP churn.
export const DNS_RECORD_TTL = 60;

// Back-compat alias: index.mjs and store.mjs historically referenced OVH_ZONE.
// Kept so no other module needs to change its import.
export const OVH_ZONE = DNS_ZONE;

// Compute the box's DNS sub-domain for a box_id. Cloudflare wants the FULL
// record name (including the zone): `<box_id>.boxes.mantaui.com`. Pure helper
// — also exported so the gateway's /register route can build the name it
// passes to createOrUpdate. Kept the historical `ovhSubDomainFor` name (as an
// alias) so index.mjs's re-export keeps working.
export function dnsRecordName(box_id, zone = DNS_ZONE) {
  if (typeof box_id !== "string" || !box_id) {
    throw new Error("dnsRecordName: box_id required");
  }
  return `${box_id}.boxes.${zone}`;
}

// Historical alias — index.mjs imports { ovhSubDomainFor } and re-exports it,
// and handleRegister calls ovhSubDomainFor(box_id) to build the `subDomain`
// it hands to createOrUpdate. For Cloudflare the "subDomain" argument IS the
// full record name, so this returns the full name.
export function ovhSubDomainFor(box_id) {
  return dnsRecordName(box_id);
}

// ---------------------------------------------------------------------------
// Creds
// ---------------------------------------------------------------------------

// Resolve the fields the gateway needs from process.env. Exported so the
// caller (index.mjs) can fail fast at startup if any are missing. Loaded from
// /etc/manta-gateway/cloudflare.env by the systemd unit.
//
// Returns the same `{ok, ...}` shape the old ovhCredsFromEnv did so index.mjs
// needs no change. `endpoint` is included for parity + test override.
export function cloudflareCredsFromEnv(env = process.env) {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  const endpoint = env.CLOUDFLARE_ENDPOINT || CF_DEFAULT_ENDPOINT;
  if (!apiToken || !zoneId) {
    return {
      ok: false,
      error:
        "Cloudflare creds missing (need CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID; loaded from /etc/manta-gateway/cloudflare.env)",
    };
  }
  return { ok: true, apiToken, zoneId, endpoint };
}

// Back-compat alias for index.mjs, which imports { ovhCredsFromEnv }.
export const ovhCredsFromEnv = cloudflareCredsFromEnv;

// Auth headers for one Cloudflare call.
function cfHeaders(creds) {
  return {
    Authorization: `Bearer ${creds.apiToken}`,
    "Content-Type": "application/json",
  };
}

// Parse a Cloudflare JSON response body regardless of whether fetchImpl
// returned a real Response (with .json()) or a test fake (with a `body`
// field). Real global fetch → await res.json(); test fakes → res.body.
async function readCfBody(res) {
  if (res && typeof res.json === "function") {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  return res?.body ?? null;
}

// ---------------------------------------------------------------------------
// Low-level create / update
// ---------------------------------------------------------------------------

// POST /zones/<zoneId>/dns_records — create one A record. Returns the
// Cloudflare record id (string) on success.
//
// `subDomain` is the FULL record name (`<box_id>.boxes.mantaui.com`), built
// by dnsRecordName / ovhSubDomainFor.
export async function createRecord({
  subDomain,
  target,
  fetchImpl = globalThis.fetch,
  creds,
  recordType = DNS_RECORD_TYPE,
  ttl = DNS_RECORD_TTL,
}) {
  if (typeof subDomain !== "string" || !subDomain) throw new Error("createRecord: subDomain required");
  if (typeof target !== "string" || !target) throw new Error("createRecord: target required");
  if (!creds) throw new Error("createRecord: creds required");
  if (typeof fetchImpl !== "function") throw new Error("createRecord: fetchImpl required");

  const url = `${creds.endpoint}/zones/${creds.zoneId}/dns_records`;
  const body = JSON.stringify({
    type: recordType,
    name: subDomain,
    content: target,
    ttl,
    proxied: false,
  });
  const res = await fetchImpl(url, {
    method: "POST",
    headers: cfHeaders(creds),
    body,
  });
  const parsed = await readCfBody(res);
  if (!res || res.ok !== true || parsed?.success !== true) {
    const status = res?.status ?? 0;
    throw new Error(
      `Cloudflare createRecord failed: status=${status} errors=${JSON.stringify(parsed?.errors ?? null)}`,
    );
  }
  const id = parsed?.result?.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`Cloudflare createRecord: unexpected id shape: ${JSON.stringify(id)}`);
  }
  return id;
}

// PUT /zones/<zoneId>/dns_records/<id> — update an existing record's target.
// Returns true on success, throws on failure.
export async function updateRecord({
  recordId,
  subDomain,
  target,
  fetchImpl = globalThis.fetch,
  creds,
  recordType = DNS_RECORD_TYPE,
  ttl = DNS_RECORD_TTL,
}) {
  if (typeof recordId !== "string" || !recordId) {
    throw new Error("updateRecord: recordId required");
  }
  if (typeof subDomain !== "string" || !subDomain) throw new Error("updateRecord: subDomain required");
  if (typeof target !== "string" || !target) throw new Error("updateRecord: target required");
  if (!creds) throw new Error("updateRecord: creds required");
  if (typeof fetchImpl !== "function") throw new Error("updateRecord: fetchImpl required");

  const url = `${creds.endpoint}/zones/${creds.zoneId}/dns_records/${recordId}`;
  const body = JSON.stringify({
    type: recordType,
    name: subDomain,
    content: target,
    ttl,
    proxied: false,
  });
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: cfHeaders(creds),
    body,
  });
  const parsed = await readCfBody(res);
  if (!res || res.ok !== true || parsed?.success !== true) {
    const status = res?.status ?? 0;
    throw new Error(
      `Cloudflare updateRecord failed: status=${status} errors=${JSON.stringify(parsed?.errors ?? null)}`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// createOrUpdate — single entry point the /register route calls
// ---------------------------------------------------------------------------

// Idempotent: if the store already has a `recordId`, PUT a target update;
// otherwise POST a new record and return the id to persist. Cloudflare needs
// no separate zone-refresh step (changes propagate immediately), unlike OVH.
//
// Returns { recordId, action: "create" | "update" }. Signature preserved from
// the OVH version so index.mjs's call site is unchanged (it passes `boxId`,
// which is now unused here but accepted).
export async function createOrUpdate({
  boxId, // accepted for call-site compatibility; unused (name is full-qualified)
  subDomain,
  target,
  existingRecordId = null,
  fetchImpl = globalThis.fetch,
  creds,
}) {
  if (!creds) throw new Error("createOrUpdate: creds required");
  if (typeof fetchImpl !== "function") throw new Error("createOrUpdate: fetchImpl required");

  if (existingRecordId != null) {
    await updateRecord({ recordId: existingRecordId, subDomain, target, fetchImpl, creds });
    return { recordId: existingRecordId, action: "update" };
  }
  const recordId = await createRecord({ subDomain, target, fetchImpl, creds });
  return { recordId, action: "create" };
}
