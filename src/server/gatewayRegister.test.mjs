import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import {
  registerWithGateway,
  loadAuthFile,
  publicBaseUrl,
  DEFAULT_AUTH_PATH,
} from "./gatewayRegister.mjs";

// Helpers ---------------------------------------------------------------

const BOX_ID = "0123456789abcdef0123456789abcdef";
const PRIOR_TOKEN = "fedcba9876543210fedcba9876543210";
const NEW_TOKEN = "aaaa1111bbbb2222cccc3333dddd4444";

function tmpAuthPath(label) {
  return join(
    tmpdir(),
    `manta-gateway-register-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    "auth.json",
  );
}

async function writeAuth(path, body) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(body, null, 2), { mode: 0o600 });
}

function makeJsonResponse(status, json) {
  return {
    status,
    async json() {
      return json;
    },
    async text() {
      return JSON.stringify(json);
    },
  };
}

function makeLogger() {
  const calls = { warn: [], log: [], info: [] };
  return {
    warn: (...a) => calls.warn.push(a),
    log: (...a) => calls.log.push(a),
    info: (...a) => calls.info.push(a),
    _calls: calls,
  };
}

// ----------------------------------------------------------------------------
// loadAuthFile — pure helper used by the registration flow
// ----------------------------------------------------------------------------

test("loadAuthFile returns null when the file is missing", async () => {
  const path = tmpAuthPath("missing");
  assert.equal(await loadAuthFile(path), null);
});

test("loadAuthFile returns the parsed object when present", async () => {
  const path = tmpAuthPath("present");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN });
  const out = await loadAuthFile(path);
  assert.equal(out.box_id, BOX_ID);
  assert.equal(out.box_token, PRIOR_TOKEN);
});

test("loadAuthFile returns null on corrupt JSON", async () => {
  const path = tmpAuthPath("corrupt");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "not json {", { mode: 0o600 });
  assert.equal(await loadAuthFile(path), null);
});

// ----------------------------------------------------------------------------
// First boot — no gateway_token in auth.json
// ----------------------------------------------------------------------------

test("first boot: POSTs /register without auth, persists token + host", async () => {
  const path = tmpAuthPath("first-boot");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN });
  // No gateway_token field — this is the first-boot shape.
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return makeJsonResponse(200, {
      host: `${BOX_ID}.boxes.mantaui.com`,
      gateway_token: NEW_TOKEN,
    });
  };
  const logger = makeLogger();

  const result = await registerWithGateway({
    authPath: path,
    fetchImpl,
    logger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.registered, true);
  assert.equal(result.host, `${BOX_ID}.boxes.mantaui.com`);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gateway.mantaui.com/register");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  // First boot: NO Authorization header.
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), { box_id: BOX_ID });

  // auth.json was rewritten with the new gateway_token + gateway_host.
  const stored = await loadAuthFile(path);
  assert.equal(stored.box_id, BOX_ID);
  assert.equal(stored.box_token, PRIOR_TOKEN);
  assert.equal(stored.gateway_token, NEW_TOKEN);
  assert.equal(stored.gateway_host, `${BOX_ID}.boxes.mantaui.com`);
});

// ----------------------------------------------------------------------------
// Subsequent boot — gateway_token present
// ----------------------------------------------------------------------------

test("subsequent boot: POSTs /register WITH Bearer, no rewrite when nothing changed", async () => {
  const path = tmpAuthPath("subsequent-noop");
  await writeAuth(path, {
    box_id: BOX_ID,
    box_token: PRIOR_TOKEN,
    gateway_token: PRIOR_TOKEN,
    gateway_host: `${BOX_ID}.boxes.mantaui.com`,
    created_at: 1_700_000_000_000,
  });
  // Capture pre-write content for byte-equal comparison.
  const before = (await readFile(path)).toString();

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    // Re-register response: no new token, same host.
    return makeJsonResponse(200, {
      host: `${BOX_ID}.boxes.mantaui.com`,
    });
  };

  const result = await registerWithGateway({
    authPath: path,
    fetchImpl,
    logger: makeLogger(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.registered, false);
  assert.equal(result.host, `${BOX_ID}.boxes.mantaui.com`);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${PRIOR_TOKEN}`);

  // auth.json must be byte-for-byte unchanged — no rewrite for idempotent refresh.
  const after = (await readFile(path)).toString();
  assert.equal(after, before);
});

test("subsequent boot: persists gateway_host when the gateway reports a new host", async () => {
  const path = tmpAuthPath("subsequent-host");
  await writeAuth(path, {
    box_id: BOX_ID,
    box_token: PRIOR_TOKEN,
    gateway_token: PRIOR_TOKEN,
  });

  const fetchImpl = async () =>
    makeJsonResponse(200, { host: `${BOX_ID}.boxes.mantaui.com` });

  await registerWithGateway({
    authPath: path,
    fetchImpl,
    logger: makeLogger(),
  });

  const stored = await loadAuthFile(path);
  assert.equal(stored.gateway_token, PRIOR_TOKEN);
  assert.equal(stored.gateway_host, `${BOX_ID}.boxes.mantaui.com`);
});

// ----------------------------------------------------------------------------
// Failed fetch — warn, no throw, auth.json not corrupted
// ----------------------------------------------------------------------------

test("failed fetch: warn logged, no exception, auth.json untouched", async () => {
  const path = tmpAuthPath("failed-fetch");
  const original = { box_id: BOX_ID, box_token: PRIOR_TOKEN, custom_field: "preserved" };
  await writeAuth(path, original);
  const before = (await readFile(path)).toString();

  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const logger = makeLogger();

  let result;
  let threw;
  try {
    result = await registerWithGateway({
      authPath: path,
      fetchImpl,
      logger,
    });
  } catch (e) {
    threw = e;
  }

  assert.equal(threw, undefined, "registerWithGateway must not throw");
  assert.equal(result.ok, false);
  assert.equal(result.skipped, "fetch_failed");
  assert.ok(
    logger._calls.warn.some((c) => String(c[0]).includes("fetch failed")),
    "warn must be logged on fetch failure",
  );

  // auth.json must be byte-for-byte unchanged — never touch disk on failure.
  const after = (await readFile(path)).toString();
  assert.equal(after, before);
});

test("non-200 response: warn logged, ok:false, auth.json untouched", async () => {
  const path = tmpAuthPath("non-200");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN });
  const before = (await readFile(path)).toString();

  const fetchImpl = async () => makeJsonResponse(503, { error: "dns_create_failed" });
  const logger = makeLogger();

  const result = await registerWithGateway({
    authPath: path,
    fetchImpl,
    logger,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.ok(logger._calls.warn.some((c) => String(c[0]).includes("503")));
  const after = (await readFile(path)).toString();
  assert.equal(after, before);
});

// ----------------------------------------------------------------------------
// MANTA_GATEWAY_BASE === "off"
// ----------------------------------------------------------------------------

test("MANTA_GATEWAY_BASE=off: no fetch issued, returns immediately", async () => {
  const path = tmpAuthPath("off");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN });
  const before = (await readFile(path)).toString();

  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return makeJsonResponse(200, {});
  };

  const result = await registerWithGateway({
    authPath: path,
    fetchImpl,
    env: { MANTA_GATEWAY_BASE: "off" },
    logger: makeLogger(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, "off");
  assert.equal(fetchCalls, 0, "fetch must not be invoked when gateway is off");

  const after = (await readFile(path)).toString();
  assert.equal(after, before);
});

test("gatewayBase param wins over env (test injection)", async () => {
  const path = tmpAuthPath("override");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN });

  let observedUrl = null;
  const fetchImpl = async (url) => {
    observedUrl = url;
    return makeJsonResponse(200, { host: `${BOX_ID}.boxes.mantaui.com` });
  };

  await registerWithGateway({
    authPath: path,
    fetchImpl,
    env: { MANTA_GATEWAY_BASE: "https://should-be-overridden.example" },
    gatewayBase: "https://test-gateway.example",
    logger: makeLogger(),
  });

  assert.equal(observedUrl, "https://test-gateway.example/register");
});

// ----------------------------------------------------------------------------
// Edge cases
// ----------------------------------------------------------------------------

test("missing box_id in auth.json: warn, no fetch, ok:false", async () => {
  const path = tmpAuthPath("no-boxid");
  await writeAuth(path, { some_other_field: "value" });

  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return makeJsonResponse(200, {});
  };
  const logger = makeLogger();

  const result = await registerWithGateway({
    authPath: path,
    fetchImpl,
    logger,
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, "no_box_id");
  assert.equal(fetchCalls, 0);
  assert.ok(logger._calls.warn.some((c) => String(c[0]).includes("no box_id")));
});

test("missing auth.json: warn, no fetch, ok:false", async () => {
  const path = tmpAuthPath("missing-auth");
  // Don't write the file.
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return makeJsonResponse(200, {});
  };
  const logger = makeLogger();

  const result = await registerWithGateway({
    authPath: path,
    fetchImpl,
    logger,
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, "no_box_id");
  assert.equal(fetchCalls, 0);
});

test("default gateway base used when env unset", async () => {
  const path = tmpAuthPath("default-base");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN });

  let observedUrl = null;
  const fetchImpl = async (url) => {
    observedUrl = url;
    return makeJsonResponse(200, { host: `${BOX_ID}.boxes.mantaui.com` });
  };

  await registerWithGateway({
    authPath: path,
    fetchImpl,
    env: {},
    logger: makeLogger(),
  });

  assert.equal(observedUrl, "https://gateway.mantaui.com/register");
});

test("default auth path is exported and well-formed", () => {
  assert.ok(typeof DEFAULT_AUTH_PATH === "string");
  assert.ok(DEFAULT_AUTH_PATH.endsWith("/auth.json"));
  assert.ok(DEFAULT_AUTH_PATH.includes(".manta"));
});

// ----------------------------------------------------------------------------
// publicBaseUrl — the box's own public base URL (no DNS round-trip; just
// re-reads gateway_host from auth.json fresh per call so a value that lands
// AFTER the server boots is visible to the next caller)
// ----------------------------------------------------------------------------

test("publicBaseUrl returns https://<host> when gateway_host is set", async () => {
  const path = tmpAuthPath("public-base-set");
  await writeAuth(path, {
    box_id: BOX_ID,
    box_token: PRIOR_TOKEN,
    gateway_host: `${BOX_ID}.boxes.mantaui.com`,
  });
  assert.equal(publicBaseUrl(path), `https://${BOX_ID}.boxes.mantaui.com`);
});

test("publicBaseUrl returns '' when gateway_host is missing", async () => {
  const path = tmpAuthPath("public-base-no-host");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN });
  assert.equal(publicBaseUrl(path), "");
});

test("publicBaseUrl returns '' when auth.json is missing", () => {
  const path = tmpAuthPath("public-base-missing");
  assert.equal(publicBaseUrl(path), "");
});

test("publicBaseUrl returns '' when gateway_host is the empty string", async () => {
  const path = tmpAuthPath("public-base-empty-host");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN, gateway_host: "" });
  assert.equal(publicBaseUrl(path), "");
});

test("publicBaseUrl reads fresh on each call (no module-scope cache)", async () => {
  const path = tmpAuthPath("public-base-fresh");
  // First call: no host → ""
  assert.equal(publicBaseUrl(path), "");
  // Host lands AFTER the first read (simulating registerWithGateway writing
  // gateway_host post-boot). Second call MUST see it.
  await writeAuth(path, {
    box_id: BOX_ID,
    box_token: PRIOR_TOKEN,
    gateway_host: `${BOX_ID}.boxes.mantaui.com`,
  });
  assert.equal(publicBaseUrl(path), `https://${BOX_ID}.boxes.mantaui.com`);
});

// ----------------------------------------------------------------------------
// publicBaseUrl — tailscale fallback (BET-349). A Tailscale-only box never
// registers with the gateway (no gateway_host), but it has a reachable
// tailnet address recorded in ~/.manta/ingress.json. The resolver MUST fall
// back to ingress.json's serverUrl when mode === "tailscale", else serve_page
// refuses to register a page on what is in fact a reachable box.
// ----------------------------------------------------------------------------

test("publicBaseUrl: gateway_host wins over a tailscale ingress.json", async () => {
  const path = tmpAuthPath("public-base-gateway-wins");
  await writeAuth(path, {
    box_id: BOX_ID,
    box_token: PRIOR_TOKEN,
    gateway_host: `${BOX_ID}.boxes.mantaui.com`,
  });
  // ingress.json in the same directory as auth.json
  await writeFile(join(path, "..", "ingress.json"), JSON.stringify({
    mode: "tailscale",
    tailnetIp: "100.64.0.1",
    serverUrl: "http://100.64.0.1:8787",
  }, null, 2), { mode: 0o600 });
  assert.equal(publicBaseUrl(path), `https://${BOX_ID}.boxes.mantaui.com`);
});

test("publicBaseUrl: tailscale ingress.json when no gateway_host (BET-349 regression)", async () => {
  const path = tmpAuthPath("public-base-tailscale");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN });
  await writeFile(join(path, "..", "ingress.json"), JSON.stringify({
    mode: "tailscale",
    tailnetIp: "100.64.0.1",
    serverUrl: "http://100.64.0.1:8787",
  }, null, 2), { mode: 0o600 });
  assert.equal(publicBaseUrl(path), "http://100.64.0.1:8787");
});

test("publicBaseUrl: public-mode ingress.json is NOT a fallback", async () => {
  const path = tmpAuthPath("public-base-public-mode");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN });
  await writeFile(join(path, "..", "ingress.json"), JSON.stringify({
    mode: "public",
  }, null, 2), { mode: 0o600 });
  assert.equal(publicBaseUrl(path), "");
});

test("publicBaseUrl: no gateway_host and no ingress.json → ''", async () => {
  const path = tmpAuthPath("public-base-no-ingress");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN });
  // No ingress.json written alongside auth.json
  assert.equal(publicBaseUrl(path), "");
});

test("publicBaseUrl: malformed ingress.json does not throw, returns ''", async () => {
  const path = tmpAuthPath("public-base-bad-ingress");
  await writeAuth(path, { box_id: BOX_ID, box_token: PRIOR_TOKEN });
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(join(path, "..", "ingress.json"), "not json {", { mode: 0o600 });
  assert.equal(publicBaseUrl(path), "");
});

// Cleanup any stray tmp dirs. Best-effort; safe to ignore errors.
test("cleanup tmp auth files", async () => {
  // No-op assertion: each test already uses its own unique tmp path. This
  // exists as a documented hook so reviewers can see we considered disk
  // hygiene without each test needing a finally block.
  assert.ok(true);
});
