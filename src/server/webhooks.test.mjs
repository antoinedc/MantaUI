import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  isValidToken,
  verifySignature,
  formatWebhookTurn,
  createRateLimiter,
  toMeta,
  deliveryUrl,
  createHook,
  listHooks,
  deleteHook,
  deliverWebhook,
  loadHooks,
  saveHooks,
} from "./webhooks.mjs";

// ----------------------------------------------------------------------------
// isValidToken
// ----------------------------------------------------------------------------

test("isValidToken accepts 32 lowercase hex chars only", () => {
  assert.equal(isValidToken("a".repeat(32)), true);
  assert.equal(isValidToken("0123456789abcdef0123456789abcdef"), true);
  assert.equal(isValidToken("A".repeat(32)), false); // uppercase
  assert.equal(isValidToken("a".repeat(31)), false); // too short
  assert.equal(isValidToken("a".repeat(33)), false); // too long
  assert.equal(isValidToken("../etc/passwd"), false);
  assert.equal(isValidToken(""), false);
  assert.equal(isValidToken(null), false);
});

// ----------------------------------------------------------------------------
// verifySignature
// ----------------------------------------------------------------------------

function sign(secret, body) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

test("verifySignature accepts a correct signature", () => {
  const body = '{"event":"task.completed"}';
  assert.equal(verifySignature("whsec_x", body, sign("whsec_x", body)), true);
});

test("verifySignature rejects a wrong signature", () => {
  const body = '{"event":"task.completed"}';
  assert.equal(verifySignature("whsec_x", body, sign("whsec_OTHER", body)), false);
});

test("verifySignature rejects a tampered body", () => {
  const sig = sign("whsec_x", '{"a":1}');
  assert.equal(verifySignature("whsec_x", '{"a":2}', sig), false);
});

test("verifySignature rejects missing / malformed headers", () => {
  const body = "x";
  assert.equal(verifySignature("whsec_x", body, undefined), false);
  assert.equal(verifySignature("whsec_x", body, ""), false);
  assert.equal(verifySignature("whsec_x", body, "md5=abc"), false);
  assert.equal(verifySignature("whsec_x", body, "sha256="), false);
  assert.equal(verifySignature("whsec_x", body, "sha256=zzzz"), false); // non-hex
  assert.equal(verifySignature("", body, sign("", body)), false); // empty secret
});

// ----------------------------------------------------------------------------
// formatWebhookTurn
// ----------------------------------------------------------------------------

test("formatWebhookTurn marks the payload untrusted and fences it", () => {
  const out = formatWebhookTurn({
    label: "multica done",
    instructions: "Summarize the run.",
    payload: { event: "task.completed", key: "CAPO-1" },
  });
  assert.match(out, /Inbound webhook "multica done"/);
  assert.match(out, /untrusted DATA/);
  assert.match(out, /Summarize the run\./);
  assert.match(out, /```json/);
  assert.match(out, /"key": "CAPO-1"/);
});

test("formatWebhookTurn handles empty instructions and string payloads", () => {
  const out = formatWebhookTurn({ label: "", instructions: "", payload: "raw text" });
  assert.match(out, /Inbound webhook "webhook"/); // default label
  assert.match(out, /raw text/);
  assert.doesNotMatch(out, /\n\n\n/); // no blank instructions block
});

// ----------------------------------------------------------------------------
// createRateLimiter (token bucket)
// ----------------------------------------------------------------------------

test("createRateLimiter allows up to capacity then throttles, refilling over time", () => {
  let t = 0;
  const take = createRateLimiter({ capacity: 3, refillPerSec: 0.5, now: () => t });
  assert.equal(take("k"), true);
  assert.equal(take("k"), true);
  assert.equal(take("k"), true);
  assert.equal(take("k"), false); // bucket empty
  t = 2000; // +2s → +1 token at 0.5/s
  assert.equal(take("k"), true);
  assert.equal(take("k"), false);
  // separate key has its own bucket
  assert.equal(take("other"), true);
});

// ----------------------------------------------------------------------------
// toMeta / deliveryUrl
// ----------------------------------------------------------------------------

test("toMeta strips secret and token, keeps url + metadata", () => {
  const meta = toMeta({
    id: "i",
    token: "t".repeat(32),
    secret: "whsec_xyz",
    label: "l",
    url: "https://app.mantaui.com/hook/" + "t".repeat(32),
    unsigned: false,
    sessionID: "ses_1",
    deliveries: 4,
  });
  assert.equal(meta.secret, undefined);
  assert.equal(meta.token, undefined);
  assert.equal(meta.label, "l");
  assert.equal(meta.deliveries, 4);
  assert.match(meta.url, /\/hook\//);
});

test("deliveryUrl builds /hook/<token> from a base", () => {
  assert.equal(deliveryUrl("abc", "https://x.test/"), "https://x.test/hook/abc");
});

// ----------------------------------------------------------------------------
// CRUD round-trip (real temp store)
// ----------------------------------------------------------------------------

function tmpStore() {
  return join(tmpdir(), `bui-webhooks-test-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}

test("createHook → listHooks → deleteHook round-trip via temp store", async () => {
  const path = tmpStore();
  const events = [];
  const load = () => loadHooks(path);
  const save = (h) => saveHooks(h, path);
  const publish = (e) => events.push(e);
  try {
    const created = await createHook(
      { label: "ci green", instructions: "deploy", sessionID: "ses_1" },
      { load, save, publish },
    );
    assert.equal(created.ok, true);
    assert.match(created.secret, /^whsec_/);
    assert.match(created.url, /\/hook\/[0-9a-f]{32}$/);
    assert.equal(events.at(-1).kind, "webhook.updated");

    const list = await listHooks("ses_1", { load });
    assert.equal(list.length, 1);
    assert.equal(list[0].secret, undefined); // never re-exposed
    assert.equal(list[0].label, "ci green");

    // other session sees nothing
    assert.equal((await listHooks("ses_other", { load })).length, 0);

    const del = await deleteHook(created.hook.id, { load, save, publish });
    assert.equal(del.deleted, true);
    assert.equal((await listHooks("ses_1", { load })).length, 0);
  } finally {
    await rm(path, { force: true });
  }
});

test("createHook rejects missing sessionID / label", async () => {
  const load = async () => [];
  const save = async () => {};
  assert.equal((await createHook({ label: "x" }, { load, save })).ok, false);
  assert.equal((await createHook({ sessionID: "s" }, { load, save })).ok, false);
});

// ----------------------------------------------------------------------------
// deliverWebhook — status codes + send/defer
// ----------------------------------------------------------------------------

function fakeHook(over = {}) {
  return {
    id: "h1",
    token: "a".repeat(32),
    secret: "whsec_test",
    unsigned: false,
    label: "multica",
    instructions: "",
    sessionID: "ses_1",
    deliveries: 0,
    lastDeliveredAt: null,
    ...over,
  };
}

test("deliverWebhook returns 404 for an unknown token", async () => {
  const res = await deliverWebhook(
    { token: "b".repeat(32), rawBody: "{}", signatureHeader: "" },
    { load: async () => [fakeHook()], save: async () => {}, sendPrompt: async () => {} },
  );
  assert.equal(res.status, 404);
});

test("deliverWebhook returns 404 for a malformed token without touching the store", async () => {
  let loaded = false;
  const res = await deliverWebhook(
    { token: "../x", rawBody: "{}", signatureHeader: "" },
    { load: async () => { loaded = true; return []; }, save: async () => {}, sendPrompt: async () => {} },
  );
  assert.equal(res.status, 404);
  assert.equal(loaded, false);
});

test("deliverWebhook returns 401 on bad signature, never sends", async () => {
  let sent = 0;
  const res = await deliverWebhook(
    { token: "a".repeat(32), rawBody: '{"a":1}', signatureHeader: "sha256=deadbeef" },
    { load: async () => [fakeHook()], save: async () => {}, sendPrompt: async () => { sent++; } },
  );
  assert.equal(res.status, 401);
  assert.equal(sent, 0);
});

test("deliverWebhook returns 429 when rate-limited, never sends", async () => {
  let sent = 0;
  const res = await deliverWebhook(
    { token: "a".repeat(32), rawBody: "{}", signatureHeader: "" },
    {
      load: async () => [fakeHook({ unsigned: true })],
      save: async () => {},
      sendPrompt: async () => { sent++; },
      take: () => false,
    },
  );
  assert.equal(res.status, 429);
  assert.equal(sent, 0);
});

test("deliverWebhook happy path sends the formatted turn and stamps metadata", async () => {
  const body = '{"event":"task.completed","key":"CAPO-1"}';
  let saved = null;
  let sentText = null;
  const res = await deliverWebhook(
    { token: "a".repeat(32), rawBody: body, signatureHeader: sign("whsec_test", body) },
    {
      load: async () => [fakeHook()],
      save: async (hooks) => { saved = hooks; },
      sendPrompt: async ({ sessionId, text }) => {
        assert.equal(sessionId, "ses_1");
        sentText = text;
      },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(res.queued, false);
  assert.match(sentText, /CAPO-1/);
  assert.match(sentText, /untrusted DATA/);
  assert.equal(saved[0].deliveries, 1);
  assert.ok(saved[0].lastDeliveredAt);
});

test("deliverWebhook on an unsigned hook skips signature verification", async () => {
  let sent = 0;
  const res = await deliverWebhook(
    { token: "a".repeat(32), rawBody: '{"x":1}', signatureHeader: "" },
    {
      load: async () => [fakeHook({ unsigned: true })],
      save: async () => {},
      sendPrompt: async () => { sent++; },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(sent, 1);
});

test("deliverWebhook defers (202) on a busy session instead of draining", async () => {
  let sent = 0;
  let queued = null;
  const res = await deliverWebhook(
    { token: "a".repeat(32), rawBody: "{}", signatureHeader: "" },
    {
      load: async () => [fakeHook({ unsigned: true })],
      save: async () => {},
      sendPrompt: async () => { sent++; },
      isBusy: () => true,
      enqueue: (sid, text) => { queued = { sid, text }; },
    },
  );
  assert.equal(res.status, 202);
  assert.equal(res.queued, true);
  assert.equal(sent, 0); // did NOT send / abort the in-flight turn
  assert.equal(queued.sid, "ses_1");
  assert.match(queued.text, /Inbound webhook/);
});
