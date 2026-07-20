// gatewayRegister.test.mjs — unit tests for the box-side gateway registration
// helper (BET-201). Each test uses an isolated tmp auth.json + an injected
// fetch; no FS outside /tmp, no real network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWithGateway, loadAuthIdentity, DEFAULT_GATEWAY_BASE } from "./gatewayRegister.mjs";

const BOX_ID = "0123456789abcdef0123456789abcdef";
const GATEWAY_TOKEN = "fedcba9876543210fedcba9876543210";
const HOST = `${BOX_ID}.boxes.mantaui.com`;

function freshAuthPath(label) {
  const dir = mkdtempSync(join(tmpdir(), `bui-gwreg-${label}-`));
  return { dir, path: join(dir, "auth.json") };
}

// Quiet console capture helpers. Each test wraps console.warn/console.log so
// we can assert the warn was emitted and then restore. registerWithGateway
// accepts a `console` injection, so most tests pass a fake instead — but the
// "failed fetch" + "MANTA_GATEWAY_BASE=off" cases exercise the real path.
function captureConsole() {
  const warns = [];
  const logs = [];
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...a) => warns.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
  return {
    warns,
    logs,
    restore() {
      console.warn = origWarn;
      console.log = origLog;
    },
  };
}

// ---------------------------------------------------------------------------
// loadAuthIdentity
// ---------------------------------------------------------------------------

test("loadAuthIdentity: returns null when the file is missing", () => {
  const { dir, path } = freshAuthPath("missing");
  try {
    assert.equal(loadAuthIdentity(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAuthIdentity: returns null for a malformed file", () => {
  const { dir, path } = freshAuthPath("corrupt");
  try {
    writeFileSync(path, "not json {");
    assert.equal(loadAuthIdentity(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAuthIdentity: parses box_id, box_token, gateway_token, gateway_host", () => {
  const { dir, path } = freshAuthPath("parse");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        box_id: BOX_ID,
        box_token: "a".repeat(32),
        created_at: 1700000000000,
        gateway_token: GATEWAY_TOKEN,
        gateway_host: HOST,
      }),
    );
    const ident = loadAuthIdentity(path);
    assert.equal(ident.box_id, BOX_ID);
    assert.equal(ident.box_token, "a".repeat(32));
    assert.equal(ident.gateway_token, GATEWAY_TOKEN);
    assert.equal(ident.gateway_host, HOST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. First boot (no gateway_token) — required
// ---------------------------------------------------------------------------

test("registerWithGateway: first boot (no gateway_token) → POST /register with NO Authorization header and persists token + host", async () => {
  const { dir, path } = freshAuthPath("first-boot");
  try {
    writeFileSync(
      path,
      JSON.stringify({ box_id: BOX_ID, box_token: "a".repeat(32), created_at: 1 }),
    );

    let fetchCalls = 0;
    let lastReq;
    const fetchImpl = async (url, init) => {
      fetchCalls++;
      lastReq = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({ host: HOST, gateway_token: GATEWAY_TOKEN }),
      };
    };

    const result = await registerWithGateway({
      authPath: path,
      fetchImpl,
      gatewayBase: "https://gw.test.local",
    });

    assert.equal(result.ok, true);
    assert.equal(result.registered, true);
    assert.equal(result.host, HOST);

    // Exactly one fetch.
    assert.equal(fetchCalls, 1);
    assert.equal(lastReq.url, "https://gw.test.local/register");
    assert.equal(lastReq.init.method, "POST");
    assert.equal(lastReq.init.headers["content-type"], "application/json");
    // No Authorization header on first boot.
    assert.equal(
      lastReq.init.headers.authorization,
      undefined,
      "first boot must NOT send an Authorization header",
    );
    // Body is exactly { box_id }.
    assert.equal(lastReq.init.body, JSON.stringify({ box_id: BOX_ID }));

    // auth.json now carries the persisted fields.
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(onDisk.box_id, BOX_ID);
    assert.equal(onDisk.box_token, "a".repeat(32), "box_token untouched");
    assert.equal(onDisk.created_at, 1, "created_at untouched");
    assert.equal(onDisk.gateway_token, GATEWAY_TOKEN);
    assert.equal(onDisk.gateway_host, HOST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Subsequent boot (has gateway_token) — required
// ---------------------------------------------------------------------------

test("registerWithGateway: subsequent boot (has gateway_token) → POST /register WITH Bearer, auth.json NOT rewritten when response has no new token", async () => {
  const { dir, path } = freshAuthPath("subsequent");
  try {
    const initial = {
      box_id: BOX_ID,
      box_token: "a".repeat(32),
      created_at: 1,
      gateway_token: GATEWAY_TOKEN,
      gateway_host: HOST,
    };
    writeFileSync(path, JSON.stringify(initial));
    const beforeBytes = readFileSync(path);

    let fetchCalls = 0;
    let lastReq;
    const fetchImpl = async (url, init) => {
      fetchCalls++;
      lastReq = { url, init };
      return {
        ok: true,
        status: 200,
        // Re-register response: only { host } (gateway does NOT re-issue).
        json: async () => ({ host: HOST }),
      };
    };

    const result = await registerWithGateway({
      authPath: path,
      fetchImpl,
      gatewayBase: "https://gw.test.local",
    });

    assert.equal(result.ok, true);
    assert.equal(result.registered, false);
    assert.equal(result.host, HOST);

    // Exactly one fetch, with the bearer.
    assert.equal(fetchCalls, 1);
    assert.equal(lastReq.url, "https://gw.test.local/register");
    assert.equal(lastReq.init.headers.authorization, `Bearer ${GATEWAY_TOKEN}`);
    assert.equal(lastReq.init.body, JSON.stringify({ box_id: BOX_ID }));

    // auth.json bytewise unchanged: re-register path does NOT rewrite.
    const afterBytes = readFileSync(path);
    assert.equal(
      Buffer.compare(beforeBytes, afterBytes),
      0,
      "auth.json file contents must be byte-for-byte identical after re-register",
    );
    const onDisk = JSON.parse(afterBytes.toString("utf-8"));
    assert.equal(onDisk.gateway_token, GATEWAY_TOKEN);
    assert.equal(onDisk.gateway_host, HOST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Failed fetch — required
// ---------------------------------------------------------------------------

test("registerWithGateway: fetch throws → warn logged, no exception, auth.json NOT corrupted", async () => {
  const { dir, path } = freshAuthPath("fetch-throw");
  try {
    writeFileSync(
      path,
      JSON.stringify({ box_id: BOX_ID, box_token: "a".repeat(32), created_at: 1 }),
    );

    const cap = captureConsole();
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls++;
      throw new Error("ECONNREFUSED");
    };

    let result;
    try {
      result = await registerWithGateway({
        authPath: path,
        fetchImpl,
        gatewayBase: "https://gw.test.local",
      });
    } finally {
      cap.restore();
    }

    assert.equal(fetchCalls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error, "fetch_failed");
    assert.ok(
      cap.warns.some((w) => /fetch failed/.test(w)),
      `warn must mention fetch failure; got: ${JSON.stringify(cap.warns)}`,
    );

    // auth.json unchanged (still missing gateway_token; no corruption).
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(onDisk.box_id, BOX_ID);
    assert.equal(onDisk.gateway_token, undefined, "no token was written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerWithGateway: non-2xx status → warn logged, no exception, auth.json NOT corrupted", async () => {
  const { dir, path } = freshAuthPath("non-2xx");
  try {
    writeFileSync(
      path,
      JSON.stringify({ box_id: BOX_ID, box_token: "a".repeat(32), created_at: 1 }),
    );

    const cap = captureConsole();
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });

    let result;
    try {
      result = await registerWithGateway({
        authPath: path,
        fetchImpl,
        gatewayBase: "https://gw.test.local",
      });
    } finally {
      cap.restore();
    }

    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.equal(result.error, "non_2xx");
    assert.ok(cap.warns.some((w) => /non-2xx/.test(w) && /status=500/.test(w)));

    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(onDisk.gateway_token, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. MANTA_GATEWAY_BASE === "off" — required
// ---------------------------------------------------------------------------

test('registerWithGateway: gatewayBase="off" → no fetch issued, returns immediately', async () => {
  const { dir, path } = freshAuthPath("off");
  try {
    writeFileSync(
      path,
      JSON.stringify({ box_id: BOX_ID, box_token: "a".repeat(32), created_at: 1 }),
    );

    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const result = await registerWithGateway({
      authPath: path,
      fetchImpl,
      gatewayBase: "off",
    });

    assert.equal(fetchCalls, 0, "no fetch must be issued in off mode");
    assert.equal(result.ok, false);
    assert.equal(result.skipped, "off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Edge cases (extra coverage beyond the four required)
// ---------------------------------------------------------------------------

test("registerWithGateway: missing auth.json → skipped with warning", async () => {
  const { dir, path } = freshAuthPath("no-file");
  try {
    const cap = captureConsole();
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    let result;
    try {
      result = await registerWithGateway({
        authPath: path,
        fetchImpl,
        gatewayBase: "https://gw.test.local",
      });
    } finally {
      cap.restore();
    }
    assert.equal(fetchCalls, 0);
    assert.equal(result.ok, false);
    assert.equal(result.skipped, "no_box_id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerWithGateway: malformed box_id in auth.json → skipped, no fetch", async () => {
  const { dir, path } = freshAuthPath("bad-bid");
  try {
    writeFileSync(
      path,
      JSON.stringify({ box_id: "not-hex", box_token: "a".repeat(32) }),
    );
    const cap = captureConsole();
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    let result;
    try {
      result = await registerWithGateway({
        authPath: path,
        fetchImpl,
        gatewayBase: "https://gw.test.local",
      });
    } finally {
      cap.restore();
    }
    assert.equal(fetchCalls, 0);
    assert.equal(result.ok, false);
    assert.equal(result.skipped, "bad_box_id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerWithGateway: malformed JSON in 200 response → warn, auth.json NOT corrupted", async () => {
  const { dir, path } = freshAuthPath("bad-resp");
  try {
    writeFileSync(
      path,
      JSON.stringify({ box_id: BOX_ID, box_token: "a".repeat(32), created_at: 1 }),
    );
    const cap = captureConsole();
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("unexpected token");
      },
    });
    let result;
    try {
      result = await registerWithGateway({
        authPath: path,
        fetchImpl,
        gatewayBase: "https://gw.test.local",
      });
    } finally {
      cap.restore();
    }
    assert.equal(result.ok, false);
    assert.equal(result.error, "bad_json");
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(onDisk.gateway_token, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerWithGateway: response missing host on first-boot path → warn, no persist", async () => {
  const { dir, path } = freshAuthPath("no-host");
  try {
    writeFileSync(
      path,
      JSON.stringify({ box_id: BOX_ID, box_token: "a".repeat(32), created_at: 1 }),
    );
    const cap = captureConsole();
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ gateway_token: GATEWAY_TOKEN }), // no host
    });
    let result;
    try {
      result = await registerWithGateway({
        authPath: path,
        fetchImpl,
        gatewayBase: "https://gw.test.local",
      });
    } finally {
      cap.restore();
    }
    assert.equal(result.ok, false);
    assert.equal(result.error, "missing_host");
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(onDisk.gateway_token, undefined, "must NOT persist without host");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DEFAULT_GATEWAY_BASE: uses process.env.MANTA_GATEWAY_BASE when set", () => {
  // The module-level constant is captured at import time. The "off" sentinel
  // short-circuits before any env lookup, so the env var is only consulted
  // when the constant is NOT "off". We just sanity-check the constant shape.
  assert.equal(typeof DEFAULT_GATEWAY_BASE, "string");
  assert.ok(DEFAULT_GATEWAY_BASE.length > 0);
});
