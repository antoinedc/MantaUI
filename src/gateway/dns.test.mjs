// dns.test.mjs — unit tests for the Cloudflare DNS client (gateway-side).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cloudflareCredsFromEnv,
  ovhCredsFromEnv,
  dnsRecordName,
  ovhSubDomainFor,
  DNS_ZONE,
  OVH_ZONE,
  CF_DEFAULT_ENDPOINT,
  createRecord,
  updateRecord,
  createOrUpdate,
} from "./dns.mjs";

const CREDS = {
  apiToken: "cf-token-abc",
  zoneId: "zone123",
  endpoint: CF_DEFAULT_ENDPOINT,
};

// A Cloudflare-shaped fetch fake. `result` is the object the API would put in
// `.result`; success defaults to true. Records every call.
function cfFetch({ result = { id: "rec_xyz" }, success = true, status = 200, calls } = {}) {
  return async (url, init) => {
    calls?.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ success, result, errors: success ? [] : [{ message: "nope" }] }),
    };
  };
}

test("cloudflareCredsFromEnv: ok=true when token + zoneId present", () => {
  const r = cloudflareCredsFromEnv({
    CLOUDFLARE_API_TOKEN: "t",
    CLOUDFLARE_ZONE_ID: "z",
  });
  assert.equal(r.ok, true);
  assert.equal(r.apiToken, "t");
  assert.equal(r.zoneId, "z");
  assert.equal(r.endpoint, CF_DEFAULT_ENDPOINT);
});

test("cloudflareCredsFromEnv: honors CLOUDFLARE_ENDPOINT override", () => {
  const r = cloudflareCredsFromEnv({
    CLOUDFLARE_API_TOKEN: "t",
    CLOUDFLARE_ZONE_ID: "z",
    CLOUDFLARE_ENDPOINT: "https://api.cf.test/v4",
  });
  assert.equal(r.endpoint, "https://api.cf.test/v4");
});

test("cloudflareCredsFromEnv: ok=false when any are missing", () => {
  assert.equal(cloudflareCredsFromEnv({ CLOUDFLARE_API_TOKEN: "t" }).ok, false);
  assert.equal(cloudflareCredsFromEnv({ CLOUDFLARE_ZONE_ID: "z" }).ok, false);
  assert.equal(cloudflareCredsFromEnv({}).ok, false);
});

test("ovhCredsFromEnv is an alias of cloudflareCredsFromEnv (back-compat)", () => {
  assert.equal(ovhCredsFromEnv, cloudflareCredsFromEnv);
});

test("OVH_ZONE alias equals DNS_ZONE (mantaui.com)", () => {
  assert.equal(DNS_ZONE, "mantaui.com");
  assert.equal(OVH_ZONE, DNS_ZONE);
});

test("dnsRecordName / ovhSubDomainFor: <box_id>.boxes.mantaui.com (full name)", () => {
  const bid = "0".repeat(32);
  assert.equal(dnsRecordName(bid), `${bid}.boxes.mantaui.com`);
  assert.equal(ovhSubDomainFor(bid), `${bid}.boxes.mantaui.com`);
  assert.throws(() => dnsRecordName(""), /box_id/);
});

test("createRecord: POSTs to /zones/<id>/dns_records unproxied + returns string id", async () => {
  const calls = [];
  const fetchImpl = cfFetch({ result: { id: "rec_777" }, calls });
  const id = await createRecord({
    subDomain: "0".repeat(32) + ".boxes.mantaui.com",
    target: "1.2.3.4",
    fetchImpl,
    creds: CREDS,
  });
  assert.equal(id, "rec_777");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${CREDS.endpoint}/zones/${CREDS.zoneId}/dns_records`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${CREDS.apiToken}`);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.type, "A");
  assert.equal(body.name, "0".repeat(32) + ".boxes.mantaui.com");
  assert.equal(body.content, "1.2.3.4");
  assert.equal(body.proxied, false);
});

test("createRecord: throws on success=false with status in message", async () => {
  const fetchImpl = cfFetch({ success: false, status: 403 });
  await assert.rejects(
    () => createRecord({
      subDomain: "0".repeat(32) + ".boxes.mantaui.com",
      target: "1.2.3.4",
      fetchImpl,
      creds: CREDS,
    }),
    /status=403/,
  );
});

test("createRecord: throws when result.id is not a string", async () => {
  const fetchImpl = cfFetch({ result: { id: 12345 } });
  await assert.rejects(
    () => createRecord({
      subDomain: "x.boxes.mantaui.com",
      target: "1.2.3.4",
      fetchImpl,
      creds: CREDS,
    }),
    /unexpected id shape/,
  );
});

test("updateRecord: PUTs to /zones/<id>/dns_records/<recordId>", async () => {
  const calls = [];
  const fetchImpl = cfFetch({ result: { id: "rec_777" }, calls });
  const r = await updateRecord({
    recordId: "rec_777",
    subDomain: "0".repeat(32) + ".boxes.mantaui.com",
    target: "5.6.7.8",
    fetchImpl,
    creds: CREDS,
  });
  assert.equal(r, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].url, `${CREDS.endpoint}/zones/${CREDS.zoneId}/dns_records/rec_777`);
  assert.equal(JSON.parse(calls[0].init.body).content, "5.6.7.8");
});

test("updateRecord: requires a string recordId", async () => {
  await assert.rejects(
    () => updateRecord({
      recordId: 123,
      subDomain: "x.boxes.mantaui.com",
      target: "5.6.7.8",
      fetchImpl: cfFetch(),
      creds: CREDS,
    }),
    /recordId required/,
  );
});

test("createOrUpdate: no existing recordId → POST, action=create", async () => {
  const calls = [];
  const fetchImpl = cfFetch({ result: { id: "rec_new" }, calls });
  const r = await createOrUpdate({
    boxId: "0".repeat(32),
    subDomain: "0".repeat(32) + ".boxes.mantaui.com",
    target: "9.9.9.9",
    fetchImpl,
    creds: CREDS,
  });
  assert.equal(r.recordId, "rec_new");
  assert.equal(r.action, "create");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
});

test("createOrUpdate: existing recordId → PUT, action=update, no create call", async () => {
  const calls = [];
  const fetchImpl = cfFetch({ result: { id: "rec_existing" }, calls });
  const r = await createOrUpdate({
    boxId: "0".repeat(32),
    subDomain: "0".repeat(32) + ".boxes.mantaui.com",
    target: "9.9.9.9",
    existingRecordId: "rec_existing",
    fetchImpl,
    creds: CREDS,
  });
  assert.equal(r.recordId, "rec_existing");
  assert.equal(r.action, "update");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].url, `${CREDS.endpoint}/zones/${CREDS.zoneId}/dns_records/rec_existing`);
});

test("createOrUpdate: no Cloudflare refresh step (single call per op)", async () => {
  // OVH needed a POST /refresh after every write; Cloudflare does not. Assert
  // exactly ONE network call happens per createOrUpdate (regression guard).
  const calls = [];
  const fetchImpl = cfFetch({ result: { id: "rec_1" }, calls });
  await createOrUpdate({
    boxId: "0".repeat(32),
    subDomain: "x.boxes.mantaui.com",
    target: "1.1.1.1",
    fetchImpl,
    creds: CREDS,
  });
  assert.equal(calls.length, 1);
});
