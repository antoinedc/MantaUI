import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRelayPush,
  createStubPushSender,
  routeNotification,
  shouldSuppressForDesktop,
  PUSH_PLATFORMS,
} from "./push.mjs";
import { openStore } from "./store.mjs";

const ACCT_1 = "1111111111111111aaaaaaaaaaaaaaaa";
const ACCT_2 = "2222222222222222bbbbbbbbbbbbbbbb";
const silent = () => {};

// A payload the phone would receive: "Claude is done" informational.
function donePayload(sessionId = "ses_abc") {
  return { kind: "done", title: "Claude is done", body: "Your turn finished.", sessionId, tag: `done-${sessionId}` };
}
function blockingPayload(sessionId = "ses_abc") {
  return { kind: "question", title: "Question", body: "Which?", sessionId, tag: `q-${sessionId}` };
}

// ---------------------------------------------------------------------------
// reused decision logic (import, not duplicated)
// ---------------------------------------------------------------------------

test("push reuses src/server routeNotification: blocking → both devices, mobile now", () => {
  const route = routeNotification(blockingPayload(), { desktop: null, focusSessionId: null, focusVisible: false }, 1000);
  assert.equal(route.desktop, true);
  assert.equal(route.mobileNow, true);
  assert.equal(route.escalateAfterMs, null);
});

test("push reuses shouldSuppressForDesktop: desktop active suppresses informational mobile", () => {
  const now = 100000;
  // Desktop foreground + fresh heartbeat → suppress.
  const active = { visible: true, lastSeen: now, lastActive: now };
  assert.equal(shouldSuppressForDesktop(active, now), true);
  const route = routeNotification(
    donePayload(),
    { desktop: active, focusSessionId: null, focusVisible: false },
    now,
  );
  // Active on desktop → desktop-only, no mobile push.
  assert.equal(route.desktop, true);
  assert.equal(route.mobileNow, false);
});

// ---------------------------------------------------------------------------
// device-token registration + lookup
// ---------------------------------------------------------------------------

test("register/lookup device tokens per account and platform", (t) => {
  const store = openStore();
  t.after(() => store.close());
  const push = createRelayPush({ store, log: silent, warn: silent });

  push.register({ accountId: ACCT_1, platform: "apns", token: "apns-token-1" });
  push.register({ accountId: ACCT_1, platform: "fcm", token: "fcm-token-1" });
  push.register({ accountId: ACCT_2, platform: "apns", token: "apns-token-2" });

  const t1 = push.tokensFor(ACCT_1);
  assert.equal(t1.length, 2);
  assert.deepEqual(
    t1.map((r) => r.platform).sort(),
    ["apns", "fcm"],
  );
  const t2 = push.tokensFor(ACCT_2);
  assert.equal(t2.length, 1);
  assert.equal(t2[0].token, "apns-token-2");

  // Re-register overwrites (token rotation) rather than duplicating.
  push.register({ accountId: ACCT_1, platform: "apns", token: "apns-token-1-rotated" });
  const t1b = push.tokensFor(ACCT_1);
  assert.equal(t1b.length, 2, "still one row per platform after rotation");
  assert.equal(
    t1b.find((r) => r.platform === "apns").token,
    "apns-token-1-rotated",
  );

  assert.equal(push.unregister(ACCT_1, "fcm"), true);
  assert.equal(push.tokensFor(ACCT_1).length, 1);
});

test("PUSH_PLATFORMS is apns + fcm", () => {
  assert.deepEqual([...PUSH_PLATFORMS], ["apns", "fcm"]);
});

// ---------------------------------------------------------------------------
// deliver — routing decision drives the stub sender
// ---------------------------------------------------------------------------

test("deliver: mobile-now payload fans out to every registered token via stub sender", async (t) => {
  const store = openStore();
  t.after(() => store.close());
  const sender = createStubPushSender({ log: silent });
  const push = createRelayPush({ store, sender, log: silent, warn: silent });

  push.register({ accountId: ACCT_1, platform: "apns", token: "apns-1" });
  push.register({ accountId: ACCT_1, platform: "fcm", token: "fcm-1" });

  // Blocking payload → mobileNow true regardless of presence.
  const res = await push.deliver({ accountId: ACCT_1, payload: blockingPayload() });
  assert.equal(res.route.mobileNow, true);
  assert.equal(res.delivered.length, 2);
  assert.equal(sender.sent.length, 2);
  assert.deepEqual(sender.sent.map((s) => s.platform).sort(), ["apns", "fcm"]);
  // The payload the sender received is the same notification payload.
  assert.equal(sender.sent[0].payload.kind, "question");
});

test("deliver: desktop-active informational payload does NOT push mobile", async (t) => {
  const store = openStore();
  t.after(() => store.close());
  const sender = createStubPushSender({ log: silent });
  const now = 500000;
  const push = createRelayPush({
    store,
    sender,
    now: () => now,
    log: silent,
    warn: silent,
    presence: { desktop: { visible: true, lastSeen: now, lastActive: now } },
  });
  push.register({ accountId: ACCT_1, platform: "apns", token: "apns-1" });

  const res = await push.deliver({ accountId: ACCT_1, payload: donePayload() });
  assert.equal(res.route.mobileNow, false);
  assert.equal(res.suppressed, "not_mobile_now");
  assert.equal(sender.sent.length, 0, "no mobile push while active on desktop");
});

test("deliver: no registered tokens → suppressed no_device_tokens", async (t) => {
  const store = openStore();
  t.after(() => store.close());
  const sender = createStubPushSender({ log: silent });
  const push = createRelayPush({ store, sender, log: silent, warn: silent });

  const res = await push.deliver({ accountId: ACCT_1, payload: blockingPayload() });
  assert.equal(res.route.mobileNow, true);
  assert.equal(res.suppressed, "no_device_tokens");
  assert.equal(sender.sent.length, 0);
});

test("deliver: a failing platform prunes the dead token", async (t) => {
  const store = openStore();
  t.after(() => store.close());
  const sender = createStubPushSender({ log: silent, failPlatform: "apns" });
  const push = createRelayPush({ store, sender, log: silent, warn: silent });

  push.register({ accountId: ACCT_1, platform: "apns", token: "dead-apns" });
  push.register({ accountId: ACCT_1, platform: "fcm", token: "good-fcm" });

  const res = await push.deliver({ accountId: ACCT_1, payload: blockingPayload() });
  // fcm delivered, apns failed → only fcm counted delivered.
  assert.deepEqual(res.delivered.map((d) => d.platform), ["fcm"]);
  // dead apns token pruned.
  const remaining = push.tokensFor(ACCT_1);
  assert.deepEqual(remaining.map((r) => r.platform), ["fcm"]);
});

test("deliver: rejects missing accountId / payload", async (t) => {
  const store = openStore();
  t.after(() => store.close());
  const push = createRelayPush({ store, log: silent, warn: silent });
  await assert.rejects(() => push.deliver({ payload: blockingPayload() }), /accountId required/);
  await assert.rejects(() => push.deliver({ accountId: ACCT_1 }), /payload object required/);
});

test("createRelayPush requires a store", () => {
  assert.throws(() => createRelayPush({}), /store required/);
});
