// dns.test.mjs — unit tests for the OVH DNS client (gateway-side).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ovhSignature,
  ovhHeaders,
  ovhCredsFromEnv,
  ovhSubDomainFor,
  OVH_ZONE,
  OVH_DEFAULT_ENDPOINT,
  createRecord,
  updateRecord,
  refreshZone,
  createOrUpdate,
} from "./dns.mjs";

const CREDS = {
  appKey: "appKeyABC",
  appSecret: "secretXYZ",
  consumerKey: "consumer123",
  endpoint: "https://eu.api.ovh.com/1.0",
};

test("ovhSignature: matches SHA1(secret+consumer+method+url+body) hex + '$1$' prefix", () => {
  const appSecret = "secretXYZ";
  const consumerKey = "consumer123";
  const method = "POST";
  const url = "https://eu.api.ovh.com/1.0/domain/zone/mantaui.com/record";
  const body = '{"fieldType":"A","subDomain":"abc","target":"1.2.3.4","ttl":0}';
  const expectedSha = createHash("sha1")
    .update(appSecret)
    .update("+")
    .update(consumerKey)
    .update("+")
    .update(method)
    .update("+")
    .update(url)
    .update("+")
    .update(body)
    .digest("hex");
  assert.equal(
    ovhSignature({ appSecret, consumerKey, method, url, body }),
    `$1$${expectedSha}`,
  );
});

test("ovhSignature: empty body uses empty string (not undefined)", () => {
  const sig = ovhSignature({
    appSecret: "s",
    consumerKey: "c",
    method: "POST",
    url: "https://example/x",
    body: "",
  });
  // Just verify it produces the prefixed format and a 40-char hex tail.
  assert.match(sig, /^\$1\$[0-9a-f]{40}$/);
});

test("ovhSignature: throws when inputs are missing", () => {
  assert.throws(() => ovhSignature({ consumerKey: "c", method: "POST", url: "u", body: "" }), /appSecret/);
  assert.throws(() => ovhSignature({ appSecret: "s", method: "POST", url: "u", body: "" }), /consumerKey/);
  assert.throws(() => ovhSignature({ appSecret: "s", consumerKey: "c", url: "u", body: "" }), /method/);
  assert.throws(() => ovhSignature({ appSecret: "s", consumerKey: "c", method: "GET", body: "" }), /url/);
});

test("ovhHeaders: includes all five headers + uses injected timestamp", () => {
  const h = ovhHeaders({
    appKey: "k",
    appSecret: "s",
    consumerKey: "c",
    method: "GET",
    url: "https://example/x",
    body: "",
    timestamp: 1700000000,
  });
  assert.equal(h["X-Ovh-Application"], "k");
  assert.equal(h["X-Ovh-Consumer"], "c");
  assert.equal(h["X-Ovh-Timestamp"], "1700000000");
  assert.match(h["X-Ovh-Signature"], /^\$1\$[0-9a-f]{40}$/);
  assert.equal(h["Content-Type"], "application/json");
});

test("ovhHeaders: timestamp defaults to current unix-seconds", () => {
  const before = Math.floor(Date.now() / 1000);
  const h = ovhHeaders({
    appKey: "k", appSecret: "s", consumerKey: "c", method: "GET", url: "https://x", body: "",
  });
  const after = Math.floor(Date.now() / 1000);
  const ts = Number(h["X-Ovh-Timestamp"]);
  assert.ok(ts >= before && ts <= after);
});

test("ovhCredsFromEnv: returns ok=true when all three env vars present", () => {
  const r = ovhCredsFromEnv({
    OVH_APP_KEY: "k", OVH_APP_SECRET: "s", OVH_CONSUMER_KEY: "c",
  });
  assert.equal(r.ok, true);
  assert.equal(r.appKey, "k");
  assert.equal(r.appSecret, "s");
  assert.equal(r.consumerKey, "c");
  assert.equal(r.endpoint, OVH_DEFAULT_ENDPOINT);
});

test("ovhCredsFromEnv: honors OVH_ENDPOINT override", () => {
  const r = ovhCredsFromEnv({
    OVH_APP_KEY: "k", OVH_APP_SECRET: "s", OVH_CONSUMER_KEY: "c",
    OVH_ENDPOINT: "https://api.ovhcloud.com/1.0",
  });
  assert.equal(r.endpoint, "https://api.ovhcloud.com/1.0");
});

test("ovhCredsFromEnv: ok=false when any are missing", () => {
  const a = ovhCredsFromEnv({ OVH_APP_KEY: "k" });
  assert.equal(a.ok, false);
  const b = ovhCredsFromEnv({});
  assert.equal(b.ok, false);
});

test("ovhSubDomainFor: <box_id>.boxes", () => {
  const bid = "0".repeat(32);
  assert.equal(ovhSubDomainFor(bid), `${bid}.boxes`);
  assert.throws(() => ovhSubDomainFor(""), /box_id/);
});

test("createRecord: POSTs to /domain/zone/<zone>/record with body + returns numeric id", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, body: 12345 };
  };
  const id = await createRecord({
    boxId: "0".repeat(32),
    subDomain: "0".repeat(32) + ".boxes",
    target: "1.2.3.4",
    fetchImpl,
    creds: CREDS,
    timestamp: 1700000000,
  });
  assert.equal(id, 12345);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${CREDS.endpoint}/domain/zone/${OVH_ZONE}/record`);
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].init.body, /"fieldType":"A"/);
  assert.match(calls[0].init.body, /"subDomain":"0{32}\.boxes"/);
  assert.match(calls[0].init.body, /"target":"1\.2\.3\.4"/);
  assert.equal(calls[0].init.headers["X-Ovh-Application"], CREDS.appKey);
});

test("createRecord: throws on !ok response with status in message", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, body: { message: "forbidden" } });
  await assert.rejects(
    () => createRecord({
      boxId: "0".repeat(32),
      subDomain: "0".repeat(32) + ".boxes",
      target: "1.2.3.4",
      fetchImpl,
      creds: CREDS,
    }),
    /status=403/,
  );
});

test("updateRecord: PUTs to /domain/zone/<zone>/record/<id>", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, body: null };
  };
  const r = await updateRecord({
    recordId: 12345,
    subDomain: "0".repeat(32) + ".boxes",
    target: "5.6.7.8",
    fetchImpl,
    creds: CREDS,
    timestamp: 1700000000,
  });
  assert.equal(r, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].url, `${CREDS.endpoint}/domain/zone/${OVH_ZONE}/record/12345`);
  assert.match(calls[0].init.body, /"target":"5\.6\.7\.8"/);
});

test("refreshZone: POSTs to /domain/zone/<zone>/refresh with empty body", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, body: null };
  };
  await refreshZone({ fetchImpl, creds: CREDS, timestamp: 1700000000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${CREDS.endpoint}/domain/zone/${OVH_ZONE}/refresh`);
  assert.equal(calls[0].init.method, "POST");
  // body is empty (undefined on the request, but the signature was built with "")
  assert.ok(!calls[0].init.body);
});

test("createOrUpdate: existing recordId → PUT then refresh", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, body: url.includes("refresh") ? null : 99 };
  };
  const r = await createOrUpdate({
    boxId: "0".repeat(32),
    subDomain: "0".repeat(32) + ".boxes",
    target: "9.9.9.9",
    existingRecordId: 99,
    fetchImpl,
    creds: CREDS,
  });
  assert.equal(r.recordId, 99);
  assert.equal(r.action, "update");
  // PUT then refresh
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[1].url, `${CREDS.endpoint}/domain/zone/${OVH_ZONE}/refresh`);
});

test("createOrUpdate: no existing recordId → POST then refresh", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, body: url.includes("refresh") ? null : 7777 };
  };
  const r = await createOrUpdate({
    boxId: "0".repeat(32),
    subDomain: "0".repeat(32) + ".boxes",
    target: "9.9.9.9",
    fetchImpl,
    creds: CREDS,
  });
  assert.equal(r.recordId, 7777);
  assert.equal(r.action, "create");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[1].url, `${CREDS.endpoint}/domain/zone/${OVH_ZONE}/refresh`);
});

test("createOrUpdate: refresh is called AFTER both create and update", async () => {
  // Already covered by the two above, but make the invariant explicit.
  const order = [];
  const fetchImpl = async (url, init) => {
    order.push(`${init.method} ${url}`);
    return { ok: true, status: 200, body: url.includes("refresh") ? null : 1 };
  };
  await createOrUpdate({
    boxId: "0".repeat(32),
    subDomain: "0".repeat(32) + ".boxes",
    target: "1.1.1.1",
    fetchImpl,
    creds: CREDS,
  });
  await createOrUpdate({
    boxId: "0".repeat(32),
    subDomain: "0".repeat(32) + ".boxes",
    target: "1.1.1.1",
    existingRecordId: 1,
    fetchImpl,
    creds: CREDS,
  });
  assert.equal(order.length, 4);
  assert.match(order[0], /^POST.*\/record$/);
  assert.match(order[1], /^POST.*\/refresh$/);
  assert.match(order[2], /^PUT.*\/record\/1$/);
  assert.match(order[3], /^POST.*\/refresh$/);
});

test("ovhHeaders: signature computed against the EXACT URL passed in (no normalization)", () => {
  // We MUST pass the URL verbatim because the OVH server hashes the same
  // string. Pin the signature value so a refactor that adds e.g. a trailing
  // slash fails the test.
  const h = ovhHeaders({
    appKey: "AK",
    appSecret: "AS",
    consumerKey: "CK",
    method: "POST",
    url: "https://eu.api.ovh.com/1.0/domain/zone/mantaui.com/record",
    body: '{"x":1}',
    timestamp: 1700000000,
  });
  const expected = ovhSignature({
    appSecret: "AS",
    consumerKey: "CK",
    method: "POST",
    url: "https://eu.api.ovh.com/1.0/domain/zone/mantaui.com/record",
    body: '{"x":1}',
    timestamp: 1700000000,
  });
  assert.equal(h["X-Ovh-Signature"], expected);
});
