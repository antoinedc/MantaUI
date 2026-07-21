// push.test.mjs — POST /push behavior.
//
// Gateway is STATELESS about device tokens: it does NOT maintain an
// apns-tokens.json (that's box-side state). The gateway returns per-token
// `{token, ok, prune}` results so the box can prune its own store. These
// tests cover auth, the 20-token cap, the hex validation, the order-
// preserved results, and the apnsConfig-disabled → 503 short-circuit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { handlePush } from "./index.mjs";
import { isHexToken } from "./index.mjs";

const VALID_BOX_ID = "abcdef0123456789abcdef0123456789";
const makeToken = (seed) => seed.padStart(32, "0").slice(-32);
const makeHexToken = (seed) => seed.padStart(64, "0").slice(-64);

const ENTRY = {
  gateway_token: makeToken("good"),
  ip: "1.2.3.4",
  host: `${VALID_BOX_ID}.boxes.mantaui.com`,
  registeredAt: 1,
  updatedAt: 1,
  recordId: 12345,
};

// Each test that exercises the APNs sender path needs a real .p8 file
// (the JWT signing reads + verifies the PEM before any send). Generate one
// per test that needs it; clean up in finally.
async function makeApnsCfg() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const p8Path = join(
    tmpdir(),
    `bui-gw-pushtest-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.p8`,
  );
  await writeFile(p8Path, pem, "utf-8");
  return {
    cfg: {
      teamId: "FSQ3HS4Z24",
      keyId: "82P7483297",
      bundleId: "com.antoinedc.mantaui",
      p8Path,
    },
    cleanup: () => rm(p8Path, { force: true }),
  };
}

function makeStore(entry = ENTRY) {
  return { [VALID_BOX_ID]: entry };
}

// Invoke handlePush with the common defaults (seeded store, a no-op fetch,
// and the good bearer). `body` fields merge onto a valid baseline; `store`,
// `apnsConfig`, and `apnsSender` are overridable per test.
function callPush({ body = {}, store = makeStore(), apnsConfig = null, apnsSender } = {}) {
  return handlePush({
    body: {
      box_id: VALID_BOX_ID,
      tokens: [makeHexToken("a")],
      payload: { title: "T", body: "B" },
      __bearer: makeToken("good"),
      ...body,
    },
    store,
    apnsConfig,
    apnsSender: apnsSender ?? (async () => ({ status: 200, body: null })),
  });
}

test("isHexToken: accepts hex strings (1–128 chars)", () => {
  assert.equal(isHexToken(makeHexToken("a")), true);
  assert.equal(isHexToken("ABCDEF"), true);
  assert.equal(isHexToken("xyz"), false); // non-hex
  assert.equal(isHexToken(""), false);
  assert.equal(isHexToken(null), false);
});

test("handlePush: 401 without Authorization header", async () => {
  const r = await handlePush({
    body: { box_id: VALID_BOX_ID, tokens: [], payload: { title: "T", body: "B" } },
    store: makeStore(),
    apnsConfig: null,
    apnsSender: async () => ({ status: 200, body: null }),
  });
  assert.equal(r.status, 401);
});

test("handlePush: 401 when token does not match stored value", async () => {
  const r = await handlePush({
    body: {
      box_id: VALID_BOX_ID,
      tokens: [makeHexToken("a")],
      payload: { title: "T", body: "B" },
      __bearer: makeToken("wrong"),
    },
    store: makeStore(),
    apnsConfig: null,
    apnsSender: async () => ({ status: 200, body: null }),
  });
  assert.equal(r.status, 401);
});

test("handlePush: 401 when box_id is not in store", async () => {
  const r = await callPush({ body: { box_id: "0".repeat(32) } });
  assert.equal(r.status, 401);
});

test("handlePush: 400 when box_id is malformed", async () => {
  const r = await callPush({ body: { box_id: "XYZ", tokens: [], payload: {} } });
  assert.equal(r.status, 400);
});

test("handlePush: 400 when tokens is not an array", async () => {
  const r = await callPush({ body: { tokens: "not-an-array", payload: {} } });
  assert.equal(r.status, 400);
});

test("handlePush: 400 when tokens exceeds 20", async () => {
  const tokens = Array.from({ length: 21 }, (_, i) => makeHexToken(i.toString()));
  const r = await callPush({ body: { tokens, payload: {} } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /too_many_tokens/);
});

test("handlePush: 400 when any token is not hex", async () => {
  const r = await callPush({ body: { tokens: [makeHexToken("a"), "NOT-HEX!"], payload: {} } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "invalid_token");
});

test("handlePush: 400 when payload is missing", async () => {
  const r = await callPush({ body: { tokens: [makeHexToken("a")], payload: undefined } });
  assert.equal(r.status, 400);
});

test("handlePush: 503 when apnsConfig is null (gateway not yet configured)", async () => {
  const r = await callPush({ apnsConfig: null });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "apns_disabled");
});

test("handlePush: returns per-token results in input order with ok+prune shape", async () => {
  const { cfg, cleanup } = await makeApnsCfg();
  try {
    const calls = [];
    const tokA = makeHexToken("01");
    const tokB = makeHexToken("02");
    const tokC = makeHexToken("03");
    const tokD = makeHexToken("04");
    const sender = async (req) => {
      calls.push(req.path);
      if (req.path.includes(tokA)) return { status: 200, body: null };
      if (req.path.includes(tokB)) return { status: 410, body: { reason: "Unregistered" } };
      if (req.path.includes(tokC)) return { status: 400, body: { reason: "BadDeviceToken" } };
      return { status: 500, body: null };
    };
    const tokens = [tokA, tokB, tokC, tokD];
    const r = await handlePush({
      body: {
        box_id: VALID_BOX_ID,
        tokens,
        payload: { title: "T", body: "B" },
        __bearer: makeToken("good"),
      },
      store: makeStore(),
      apnsConfig: cfg,
      apnsSender: sender,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.results, [
      { token: tokA, ok: true,  prune: false },
      { token: tokB, ok: false, prune: true  },
      { token: tokC, ok: false, prune: true  },
      { token: tokD, ok: false, prune: false }, // 500 = transient, keep
    ]);
    assert.equal(calls.length, 4, "every token must have been sent exactly once");
  } finally {
    await cleanup();
  }
});

// Every APNs rejection that means "this device token is dead" must surface
// prune=true so the box drops it. Table-driven over the (status, reason)
// pairs the classification treats as prunable.
for (const { label, status, reason } of [
  { label: "410 Gone", status: 410, reason: "Unregistered" },
  { label: "400 BadDeviceToken", status: 400, reason: "BadDeviceToken" },
  { label: "400 Unregistered", status: 400, reason: "Unregistered" },
]) {
  test(`handlePush: prune=true is returned for ${label}`, async () => {
    const { cfg, cleanup } = await makeApnsCfg();
    try {
      const r = await callPush({
        apnsConfig: cfg,
        apnsSender: async () => ({ status, body: { reason } }),
      });
      assert.equal(r.status, 200);
      assert.equal(r.json.results[0].prune, true);
    } finally {
      await cleanup();
    }
  });
}

test("handlePush: a throwing sender → ok:false, prune:false (call continues for siblings)", async () => {
  const { cfg, cleanup } = await makeApnsCfg();
  try {
    const calls = [];
    // Use distinct hex tokens for each; the sender inspects the path and
    // throws on the middle one.
    const tokGood = makeHexToken("01");
    const tokBad = makeHexToken("02");
    const tokGood2 = makeHexToken("03");
    const sender = async (req) => {
      calls.push(req.path);
      if (req.path.includes(tokBad)) throw new Error("socket reset");
      return { status: 200, body: null };
    };
    const r = await handlePush({
      body: {
        box_id: VALID_BOX_ID,
        tokens: [tokGood, tokBad, tokGood2],
        payload: { title: "T", body: "B" },
        __bearer: makeToken("good"),
      },
      store: makeStore(),
      apnsConfig: cfg,
      apnsSender: sender,
    });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 3, "all three tokens attempted even when one throws");
    assert.deepEqual(r.json.results, [
      { token: tokGood,  ok: true,  prune: false },
      { token: tokBad,   ok: false, prune: false },
      { token: tokGood2, ok: true,  prune: false },
    ]);
  } finally {
    await cleanup();
  }
});
