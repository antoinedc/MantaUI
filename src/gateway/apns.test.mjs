// apns.test.mjs — unit tests for the moved APNs client (gateway-side).
//
// The shape of `sendApns` changed because the gateway is stateless about
// device tokens: it returns `{ok, prune}` per call, and the box owns the
// actual `removeApnsToken` call. Tests cover the same behavior matrix the
// box-side tests covered (200 → ok / 410 → prune / 400 BadDeviceToken /
// 400 Unregistered / 400 other → keep / 500 → keep / transport error →
// keep) plus the JWT builder, payload, request shape, and loadApnsConfig.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm, mkdir } from "node:fs/promises";
import {
  buildApnsJwt,
  buildApnsRequest,
  buildApnsPayload,
  sendApns,
  _resetApnsJwtCache,
  loadApnsConfig,
  DEFAULT_APNS_CONFIG_PATH,
} from "./apns.mjs";

const APNS_CFG_BASE = {
  teamId: "FSQ3HS4Z24",
  keyId: "82P7483297",
  bundleId: "com.antoinedc.mantaui",
};

// Generate a P-256 EC keypair and export the private side as PKCS#8 PEM
// (the shape Apple's APNs .p8 tokens are). Returns the path; tests MUST
// clean up.
async function makeApnsKeyFile() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const path = join(
    tmpdir(),
    `bui-gw-apns-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.p8`,
  );
  await writeFile(path, pem, "utf-8");
  return { path, cleanup: () => rm(path, { force: true }) };
}

async function makeApnsKeyConfig() {
  const k = await makeApnsKeyFile();
  return { cfg: { ...APNS_CFG_BASE, p8Path: k.path }, cleanup: k.cleanup };
}

test("buildApnsJwt: header + claims match Apple APNs spec", async () => {
  const { cfg, cleanup } = await makeApnsKeyConfig();
  try {
    const IAT = 1_700_000_000;
    const jwt = await buildApnsJwt(cfg, { now: IAT });
    const parts = jwt.split(".");
    assert.equal(parts.length, 3);
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    assert.equal(header.alg, "ES256");
    assert.equal(header.kid, cfg.keyId);
    assert.equal(claims.iss, cfg.teamId);
    assert.equal(claims.iat, IAT);
    assert.ok(parts[2].length > 0);
  } finally {
    await cleanup();
  }
});

test("buildApnsJwt: rejects missing fields", async () => {
  await assert.rejects(() => buildApnsJwt({ teamId: "T", keyId: "K" }), /p8Path/);
  await assert.rejects(() => buildApnsJwt({ teamId: "T", p8Path: "/nope" }), /keyId/);
});

test("buildApnsPayload: maps notification payload to APNs `aps` envelope", () => {
  const out = buildApnsPayload({
    title: "default / my-chat",
    body: "Permission needed — Claude wants to run a tool.",
    sessionId: "ses_abc",
  });
  assert.deepEqual(out, {
    aps: {
      alert: {
        title: "default / my-chat",
        body: "Permission needed — Claude wants to run a tool.",
      },
      "thread-id": "ses_abc",
    },
    sessionId: "ses_abc",
  });
});

test("buildApnsPayload: no sessionId → no thread-id, still shaped right", () => {
  const out = buildApnsPayload({ title: "T", body: "B" });
  assert.deepEqual(out.aps.alert, { title: "T", body: "B" });
  assert.equal(out.aps["thread-id"], undefined);
  assert.equal(out.sessionId, null);
});

test("buildApnsRequest: host/path/headers/body shape (HTTP/2 style)", () => {
  const deviceToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const req = buildApnsRequest({
    cfg: APNS_CFG_BASE,
    deviceToken,
    payload: { aps: { alert: { title: "T", body: "B" } }, sessionId: null },
    jwt: "header.claims.sig",
  });
  assert.equal(req.host, "api.push.apple.com");
  assert.equal(req.path, `/3/device/${deviceToken}`);
  assert.equal(req.method, "POST");
  assert.equal(req.headers["authorization"], "bearer header.claims.sig");
  assert.equal(req.headers["apns-topic"], APNS_CFG_BASE.bundleId);
  assert.equal(req.headers["apns-push-type"], "alert");
  assert.match(req.headers["content-type"], /application\/json/);
  assert.match(req.body, /"aps"/);
});

// --- sendApns pruning rules (the classification moved verbatim) ----------

test("sendApns: 200 → ok:true, prune:false", async () => {
  const { cfg, cleanup } = await makeApnsKeyConfig();
  try {
    _resetApnsJwtCache();
    const seen = [];
    const r = await sendApns(
      { token: "tok-ok", payload: { title: "T", body: "B", sessionId: "ses_x" } },
      cfg,
      async (req) => {
        seen.push(req);
        return { status: 200, body: null };
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.prune, false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers["apns-topic"], cfg.bundleId);
    assert.equal(seen[0].headers["apns-push-type"], "alert");
    assert.match(seen[0].headers.authorization, /^bearer /);
  } finally {
    await cleanup();
  }
});

test("sendApns: 410 Gone → ok:false, prune:true", async () => {
  const { cfg, cleanup } = await makeApnsKeyConfig();
  try {
    _resetApnsJwtCache();
    const r = await sendApns(
      { token: "tok-410", payload: { title: "T", body: "B" } },
      cfg,
      async () => ({ status: 410, body: { reason: "Unregistered" } }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.prune, true);
  } finally {
    await cleanup();
  }
});

test("sendApns: 400 BadDeviceToken → ok:false, prune:true", async () => {
  const { cfg, cleanup } = await makeApnsKeyConfig();
  try {
    _resetApnsJwtCache();
    const r = await sendApns(
      { token: "tok-bad", payload: { title: "T", body: "B" } },
      cfg,
      async () => ({ status: 400, body: { reason: "BadDeviceToken" } }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.prune, true);
  } finally {
    await cleanup();
  }
});

test("sendApns: 400 Unregistered → ok:false, prune:true", async () => {
  const { cfg, cleanup } = await makeApnsKeyConfig();
  try {
    _resetApnsJwtCache();
    const r = await sendApns(
      { token: "tok-unreg", payload: { title: "T", body: "B" } },
      cfg,
      async () => ({ status: 400, body: { reason: "Unregistered" } }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.prune, true);
  } finally {
    await cleanup();
  }
});

test("sendApns: 400 with other reason → ok:false, prune:false (keep token)", async () => {
  const { cfg, cleanup } = await makeApnsKeyConfig();
  try {
    _resetApnsJwtCache();
    const r = await sendApns(
      { token: "tok-other", payload: { title: "T", body: "B" } },
      cfg,
      async () => ({ status: 400, body: { reason: "BadCertificateEnvironment" } }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.prune, false);
  } finally {
    await cleanup();
  }
});

test("sendApns: 500 → ok:false, prune:false (transient)", async () => {
  const { cfg, cleanup } = await makeApnsKeyConfig();
  try {
    _resetApnsJwtCache();
    const r = await sendApns(
      { token: "tok-500", payload: { title: "T", body: "B" } },
      cfg,
      async () => ({ status: 500, body: null }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.prune, false);
  } finally {
    await cleanup();
  }
});

test("sendApns: transport error (sender throws) → ok:false, prune:false", async () => {
  const { cfg, cleanup } = await makeApnsKeyConfig();
  try {
    _resetApnsJwtCache();
    const r = await sendApns(
      { token: "tok-throw", payload: { title: "T", body: "B" } },
      cfg,
      async () => { throw new Error("socket hangup"); },
    );
    assert.equal(r.ok, false);
    assert.equal(r.prune, false);
  } finally {
    await cleanup();
  }
});

// --- JWT cache -----------------------------------------------------------

test("_resetApnsJwtCache forces a fresh sign (verified via sendApns)", async () => {
  const { cfg, cleanup } = await makeApnsKeyConfig();
  try {
    _resetApnsJwtCache();
    const captured = [];
    const sender = async (req) => {
      captured.push(req.headers.authorization);
      return { status: 200, body: null };
    };
    await sendApns({ token: "tok-cache", payload: { title: "T", body: "B" } }, cfg, sender);
    await sendApns({ token: "tok-cache", payload: { title: "T", body: "B" } }, cfg, sender);
    assert.equal(captured.length, 2);
    assert.equal(captured[0], captured[1], "second send within cache window reuses bearer");
    _resetApnsJwtCache();
    await sendApns({ token: "tok-cache", payload: { title: "T", body: "B" } }, cfg, sender);
    assert.notEqual(captured[1], captured[2], "after reset the bearer must be freshly signed");
  } finally {
    await cleanup();
  }
});

// --- Config loading ------------------------------------------------------

test("loadApnsConfig: happy path", async () => {
  const { cfg, cleanup: p8Cleanup } = await makeApnsKeyConfig();
  const dir = join(tmpdir(), `bui-gw-cfg-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "apns.json");
  try {
    await writeFile(path, JSON.stringify(cfg), "utf-8");
    const r = await loadApnsConfig(path);
    assert.equal(r.teamId, cfg.teamId);
    assert.equal(r.keyId, cfg.keyId);
    assert.equal(r.p8Path, cfg.p8Path);
    assert.equal(r.bundleId, cfg.bundleId);
  } finally {
    await p8Cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadApnsConfig: missing file → null", async () => {
  const r = await loadApnsConfig("/nope/nope/nope.json");
  assert.equal(r, null);
});

test("loadApnsConfig: malformed JSON → null", async () => {
  const dir = join(tmpdir(), `bui-gw-cfg-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "bad.json");
  try {
    await writeFile(path, "{not-json", "utf-8");
    const r = await loadApnsConfig(path);
    assert.equal(r, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadApnsConfig: missing required fields → null", async () => {
  const dir = join(tmpdir(), `bui-gw-cfg-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "partial.json");
  try {
    await writeFile(path, JSON.stringify({ teamId: "T", keyId: "K" }), "utf-8");
    const r = await loadApnsConfig(path);
    assert.equal(r, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DEFAULT_APNS_CONFIG_PATH points at /etc/manta-gateway/apns.json", () => {
  assert.equal(DEFAULT_APNS_CONFIG_PATH, "/etc/manta-gateway/apns.json");
});
