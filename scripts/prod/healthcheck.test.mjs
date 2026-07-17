// healthcheck.test.mjs — unit tests for the prod uptime probe.
//
// Pure: every I/O surface (fetch) is injected. No real network calls.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TARGETS, runHealthcheck, parseTargetsEnv } from "./healthcheck.mjs";

function fakeFetch(perUrl) {
  return async (url, init = {}) => {
    const handler = perUrl[url];
    if (!handler) throw new Error(`fakeFetch: no handler for ${url}`);
    return handler({ url, method: init.method ?? "GET" });
  };
}

function makeRes({ status = 200, body = "" } = {}) {
  return {
    status,
    text: async () => body,
  };
}

test("DEFAULT_TARGETS covers every surface in the issue body", () => {
  const urls = DEFAULT_TARGETS.map((t) => t.url);
  for (const required of [
    "https://mantaui.com",
    "https://relay.mantaui.com",
    "https://app.mantaui.com",
    "https://mantaui.com/install.sh",
    "https://mantaui.com/releases/manta-latest.tar.gz",
  ]) {
    assert.ok(urls.includes(required), `default targets missing ${required}`);
  }
  // relay.mantaui.com specifically expects 401 — that IS the auth gate being healthy.
  const relay = DEFAULT_TARGETS.find((t) => t.url === "https://relay.mantaui.com");
  assert.equal(relay.expect.status, 401, "relay.mantaui.com must expect 401");
});

test("runHealthcheck returns ok:true when every target matches", async () => {
  const fetchFn = fakeFetch({
    "https://mantaui.com": () => makeRes({ status: 200 }),
    "https://relay.mantaui.com": () => makeRes({ status: 401 }),
    "https://app.mantaui.com": () => makeRes({ status: 200 }),
    "https://mantaui.com/install.sh": () => makeRes({ status: 200, body: "#!/usr/bin/env bash\n" }),
    "https://mantaui.com/releases/manta-latest.tar.gz": () => makeRes({ status: 200 }),
  });
  const result = await runHealthcheck({ fetchFn, log: () => {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("runHealthcheck flags a status mismatch", async () => {
  const fetchFn = fakeFetch({
    "https://mantaui.com": () => makeRes({ status: 500 }),
    "https://relay.mantaui.com": () => makeRes({ status: 401 }),
    "https://app.mantaui.com": () => makeRes({ status: 200 }),
    "https://mantaui.com/install.sh": () => makeRes({ status: 200, body: "#!/usr/bin/env bash\n" }),
    "https://mantaui.com/releases/manta-latest.tar.gz": () => makeRes({ status: 200 }),
  });
  const result = await runHealthcheck({ fetchFn, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].url, "https://mantaui.com");
  assert.match(result.failures[0].reason, /expected status 200, got 500/);
});

test("runHealthcheck flags a body-prefix mismatch (e.g. Caddy serves the homepage for a missing asset)", async () => {
  const fetchFn = fakeFetch({
    "https://mantaui.com": () => makeRes({ status: 200 }),
    "https://relay.mantaui.com": () => makeRes({ status: 401 }),
    "https://app.mantaui.com": () => makeRes({ status: 200 }),
    "https://mantaui.com/install.sh": () => makeRes({ status: 200, body: "<!doctype html>\n<html>..." }),
    "https://mantaui.com/releases/manta-latest.tar.gz": () => makeRes({ status: 200 }),
  });
  const result = await runHealthcheck({ fetchFn, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].url, "https://mantaui.com/install.sh");
  assert.match(result.failures[0].reason, /body did not start with/);
});

test("runHealthcheck flags a fetch error (DNS / network)", async () => {
  const fetchFn = fakeFetch({
    "https://mantaui.com": () => makeRes({ status: 200 }),
    "https://relay.mantaui.com": async () => { throw new Error("ENOTFOUND"); },
    "https://app.mantaui.com": () => makeRes({ status: 200 }),
    "https://mantaui.com/install.sh": () => makeRes({ status: 200, body: "#!/usr/bin/env bash\n" }),
    "https://mantaui.com/releases/manta-latest.tar.gz": () => makeRes({ status: 200 }),
  });
  const result = await runHealthcheck({ fetchFn, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].url, "https://relay.mantaui.com");
  assert.match(result.failures[0].reason, /fetch error: ENOTFOUND/);
});

test("runHealthcheck uses HEAD method for HEAD-kind targets", async () => {
  const seen = [];
  const fetchFn = async (url, init = {}) => {
    seen.push({ url, method: init.method ?? "GET" });
    return makeRes({ status: 200 });
  };
  await runHealthcheck({
    fetchFn,
    log: () => {},
    targets: [{ url: "https://mantaui.com/releases/manta-latest.tar.gz", kind: "head", expect: { status: 200 } }],
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "HEAD");
});

test("parseTargetsEnv parses a JSON override", () => {
  const parsed = parseTargetsEnv({
    HEALTHCHECK_TARGETS: JSON.stringify([
      { url: "https://example.com", kind: "body", expect: { status: 200 } },
    ]),
  });
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].url, "https://example.com");
});

test("parseTargetsEnv returns null on missing / invalid / non-array input", () => {
  assert.equal(parseTargetsEnv({}), null);
  assert.equal(parseTargetsEnv({ HEALTHCHECK_TARGETS: "" }), null);
  assert.equal(parseTargetsEnv({ HEALTHCHECK_TARGETS: "not-json" }), null);
  assert.equal(parseTargetsEnv({ HEALTHCHECK_TARGETS: JSON.stringify({ url: "x" }) }), null);
});
