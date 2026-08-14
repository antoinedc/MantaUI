import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  isValidToken,
  verifySignature,
  resolveSignature,
  isRedelivery,
  isEventFiltered,
  formatWebhookTurn,
  createRateLimiter,
  toMeta,
  deliveryUrl,
  createHook,
  upsertForgeHook,
  findForgeHook,
  listForgeHooks,
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

// The OFFICIAL GitHub HMAC test vector (BET-797). Secret "It's a Secret to
// Everybody", raw payload "Hello, World!" → sha256=757107ea… This pins the
// exact wire scheme the forge uses, so a GitHub redelivery to the box's own
// hostname is verified against the identical bytes.
test("verifySignature matches the official GitHub HMAC test vector", () => {
  const header =
    "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  assert.equal(verifySignature("It's a Secret to Everybody", "Hello, World!", header), true);
  assert.equal(verifySignature("It's a Secret to Everybody", "Hello, World", header), false);
});

test("resolveSignature accepts X-Hub-Signature-256 for a github hook", () => {
  const body = '{"action":"labeled"}';
  const headers = { "x-hub-signature-256": sign("whsec_g", body) };
  assert.equal(resolveSignature("github", "whsec_g", body, headers), true);
});

test("resolveSignature accepts X-Manta-Signature for a github hook too", () => {
  const body = '{"action":"labeled"}';
  const headers = { "x-manta-signature": sign("whsec_g", body) };
  assert.equal(resolveSignature("github", "whsec_g", body, headers), true);
});

test("resolveSignature rejects a bad header and unknown providers (never coerced)", () => {
  const body = "x";
  const headers = { "x-hub-signature-256": "sha256=deadbeef" };
  assert.equal(resolveSignature("github", "whsec_g", body, headers), false);
  // Unknown provider falls back to manta semantics (never weakens to unsigned).
  assert.equal(resolveSignature("bogus", "whsec_g", body, headers), false);
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
  return join(tmpdir(), `manta-webhooks-test-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
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

test("upsertForgeHook persists a github hook and refreshes it on re-save", async () => {
  const path = tmpStore();
  const load = () => loadHooks(path);
  const save = (h) => saveHooks(h, path);
  try {
    const first = await upsertForgeHook(
      { repoKey: "github.com/o/r", label: "github.com/o/r", token: "a".repeat(32), secret: "s1", events: ["issues"] },
      { load, save },
    );
    assert.equal(first.provider, "github");
    assert.equal(first.secret, "s1");
    assert.match(first.url, /\/hook\/[0-9a-f]{32}$/);

    // Re-save for the same repo refreshes secret+events, does NOT duplicate.
    const second = await upsertForgeHook(
      { repoKey: "github.com/o/r", label: "github.com/o/r", token: "a".repeat(32), secret: "s2", events: ["issues", "pull_request"] },
      { load, save },
    );
    assert.equal(second.secret, "s2");
    assert.equal(second.events.length, 2);
    const all = await loadHooks(path);
    assert.equal(all.filter((h) => h.repoKey === "github.com/o/r").length, 1);
  } finally {
    await rm(path, { force: true });
  }
});

test("upsertForgeHook persists a gitlab provider + the remote hookId (BET-855)", async () => {
  const path = tmpStore();
  const load = () => loadHooks(path);
  const save = (h) => saveHooks(h, path);
  try {
    const hook = await upsertForgeHook(
      {
        repoKey: "gitlab.com/grp/r",
        provider: "gitlab",
        label: "gitlab.com/grp/r",
        token: "b".repeat(32),
        secret: "s1",
        hookId: 42,
        events: ["issues"],
      },
      { load, save },
    );
    assert.equal(hook.provider, "gitlab");
    assert.equal(hook.hookId, 42, "the remote hookId is persisted for the health check");

    // Same provider+repo refresh keeps the hookId even when not re-supplied.
    const refreshed = await upsertForgeHook(
      {
        repoKey: "gitlab.com/grp/r",
        provider: "gitlab",
        label: "gitlab.com/grp/r",
        token: "c".repeat(32),
        secret: "s2",
        events: ["issues"],
      },
      { load, save },
    );
    assert.equal(refreshed.hookId, 42, "re-save preserves the previously stored hookId");
    const all = await loadHooks(path);
    assert.equal(all.filter((h) => h.provider === "gitlab" && h.repoKey === "gitlab.com/grp/r").length, 1);
  } finally {
    await rm(path, { force: true });
  }
});

test("findForgeHook is provider-scoped — a gitlab repo does not collide with a github one (BET-855)", async () => {
  const path = tmpStore();
  const load = () => loadHooks(path);
  const save = (h) => saveHooks(h, path);
  try {
    // Same owner/repo under different providers — distinct records.
    await upsertForgeHook(
      { repoKey: "x.com/o/r", provider: "github", label: "g", token: "a".repeat(32), secret: "s", events: [] },
      { load, save },
    );
    await upsertForgeHook(
      { repoKey: "x.com/o/r", provider: "gitlab", label: "l", token: "b".repeat(32), secret: "t", hookId: 7, events: [] },
      { load, save },
    );
    const githubHook = await findForgeHook("x.com/o/r", { provider: "github", load });
    const gitlabHook = await findForgeHook("x.com/o/r", { provider: "gitlab", load });
    assert.notEqual(githubHook, null);
    assert.notEqual(gitlabHook, null);
    assert.equal(githubHook.secret, "s");
    assert.equal(gitlabHook.secret, "t");
    assert.equal(gitlabHook.hookId, 7);
    assert.equal(githubHook.hookId, null);
    // Legacy callers (no provider arg) default to github — unchanged.
    assert.equal((await findForgeHook("x.com/o/r", { load })).secret, "s");
  } finally {
    await rm(path, { force: true });
  }
});

test("listForgeHooks returns only forge records with their hookId (BET-855)", async () => {
  const path = tmpStore();
  const load = () => loadHooks(path);
  const save = (h) => saveHooks(h, path);
  try {
    await createHook(
      { label: "manta hook", sessionID: "ses_1" },
      { load, save },
    );
    await upsertForgeHook(
      { repoKey: "g.com/o/r", provider: "github", label: "g", token: "a".repeat(32), secret: "s", events: [] },
      { load, save },
    );
    await upsertForgeHook(
      { repoKey: "gitlab.com/o/r", provider: "gitlab", label: "l", token: "b".repeat(32), secret: "t", hookId: 3, events: [] },
      { load, save },
    );
    const all = await listForgeHooks({ load });
    assert.equal(all.length, 2);
    assert.ok(all.every((h) => h.provider !== "manta"), "manta hooks are excluded");
    const gl = all.find((h) => h.provider === "gitlab");
    assert.equal(gl.hookId, 3);
  } finally {
    await rm(path, { force: true });
  }
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

test("deliverWebhook returns 429 (rate limit) BEFORE signature verification", async () => {
  let sent = 0;
  // Rate limiter exhausted AND a bad signature — the 429 must win, proving the
  // flood guard fires before the HMAC cost (BET-797).
  const res = await deliverWebhook(
    { token: "a".repeat(32), rawBody: '{"a":1}', headers: { "x-hub-signature-256": "sha256=deadbeef" } },
    {
      load: async () => [fakeHook({ provider: "github" })],
      save: async () => {},
      sendPrompt: async () => { sent++; },
      take: () => false,
    },
  );
  assert.equal(res.status, 429);
  assert.equal(sent, 0);
});

test("deliverWebhook verifies a github hook via X-Hub-Signature-256 and routes to forgeIngest", async () => {
  const body = '{"action":"labeled","issue":1}';
  let ingested = null;
  let sent = 0;
  const res = await deliverWebhook(
    { token: "a".repeat(32), rawBody: body, headers: { "x-hub-signature-256": sign("whsec_test", body) } },
    {
      load: async () => [fakeHook({ provider: "github" })],
      save: async () => {},
      sendPrompt: async () => { sent++; },
      forgeIngest: async (args) => { ingested = args; },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(sent, 0); // a forge hook never wakes a session
  assert.ok(ingested, "forge hook must route to forgeIngest");
  assert.equal(ingested.hook.provider, "github");
  assert.equal(ingested.event, undefined);
});

test("deliverWebhook dedupes a redelivered X-GitHub-Delivery (acts once)", async () => {
  const body = '{"action":"labeled"}';
  const signed = sign("whsec_test", body);
  const headers = {
    "x-hub-signature-256": signed,
    "x-github-event": "issues",
    "x-github-delivery": "dlv-123",
  };
  let ingests = 0;
  const saved = []; // capture store mutations after each delivery
  let hooks = [fakeHook({ provider: "github" })];
  const deps = {
    load: async () => hooks,
    save: async (h) => { hooks = h; saved.push(hooks[0].seenDeliveryIds ?? []); },
    sendPrompt: async () => {},
    forgeIngest: async () => { ingests++; },
  };
  const first = await deliverWebhook({ token: "a".repeat(32), rawBody: body, headers }, deps);
  assert.equal(first.status, 200);
  assert.equal(ingests, 1);
  // Redelivery: same delivery id, GitHub re-sends — ignored.
  const second = await deliverWebhook({ token: "a".repeat(32), rawBody: body, headers }, deps);
  assert.equal(second.status, 200);
  assert.equal(second.deduped, true);
  assert.equal(ingests, 1, "redelivered event must not act twice");
  // The delivery id persisted so the second delivery saw it.
  assert.ok(saved.at(-1)?.includes("dlv-123"));
});

test("deliverWebhook drops an event type the hook was not registered for", async () => {
  const body = '{"something":"else"}';
  const headers = {
    "x-hub-signature-256": sign("whsec_test", body),
    "x-github-event": "pull_request", // hook only registered for "issues"
  };
  let ingests = 0;
  const res = await deliverWebhook(
    { token: "a".repeat(32), rawBody: body, headers },
    {
      load: async () => [fakeHook({ provider: "github", events: ["issues"] })],
      save: async () => {},
      sendPrompt: async () => {},
      forgeIngest: async () => { ingests++; },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(res.filtered, true);
  assert.equal(ingests, 0, "filtered event must not reach ingest");
});

test("isRedelivery / isEventFiltered pure semantics", () => {
  const hook = { provider: "github", seenDeliveryIds: ["d1"], events: ["issues"] };
  assert.equal(isRedelivery(hook, "d1"), true);
  assert.equal(isRedelivery(hook, "d2"), false);
  assert.equal(isRedelivery({}, undefined), false);
  assert.equal(isEventFiltered(hook, "issues"), false);
  assert.equal(isEventFiltered(hook, "pull_request"), true);
  assert.equal(isEventFiltered({}, "anything"), false); // no whitelist → never filters
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

test("deliverWebhook surfaces a defer-queue-full rejection as 429, not 202 (BET-772)", async () => {
  let sent = 0;
  let enqueueCalls = 0;
  const res = await deliverWebhook(
    { token: "a".repeat(32), rawBody: "{}", signatureHeader: "" },
    {
      load: async () => [fakeHook({ unsigned: true })],
      save: async () => {},
      sendPrompt: async () => { sent++; },
      isBusy: () => true,
      enqueue: async () => {
        enqueueCalls++;
        // The shared engine rejects when the session's pending queue is full.
        return { delivered: false, queued: false, rejected: true };
      },
    },
  );
  // The sender must NOT be told "queued, will be delivered" for a dropped
  // prompt — surface it as a non-202 so the sender knows the delivery failed.
  assert.equal(res.status, 429);
  assert.equal(res.queued, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.error, "queue full");
  assert.equal(sent, 0); // it was deferred-and-rejected, never sent now
  assert.equal(enqueueCalls, 1);
});
