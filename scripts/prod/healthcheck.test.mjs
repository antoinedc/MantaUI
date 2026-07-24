// healthcheck.test.mjs — unit tests for the prod uptime probe.
//
// Pure: every I/O surface (fetch) is injected. No real network calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  DEFAULT_TARGETS,
  SITE_URL,
  ARCH_KEYS,
  parseManifest,
  verifyManifestDrift,
  runHealthcheck,
  parseTargetsEnv,
} from "./healthcheck.mjs";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeFetch(perUrl) {
  return async (url, init = {}) => {
    const handler = perUrl[url];
    if (!handler) throw new Error(`fakeFetch: no handler for ${url}`);
    return handler({ url, method: init.method ?? "GET" });
  };
}

function makeRes({ status = 200, body = "", bodyBytes = null } = {}) {
  // bodyBytes lets the drift-check test inject pre-hashed tarball bytes so
  // the fake fetch returns a real sha256 the verifier can compare.
  let bytes = bodyBytes;
  if (bytes == null) bytes = new TextEncoder().encode(body).buffer;
  return {
    status,
    text: async () => (typeof body === "string" ? body : new TextDecoder().decode(bytes)),
    arrayBuffer: async () => bytes,
  };
}

// Build a tarball-shaped body whose sha256 matches what we put in the
// manifest. We use a small fixed string ("tarball-bytes:<arch>") so the
// sha256 is deterministic + cheap to compute in the test.
function tarballBytes(archKey) {
  const s = `tarball-bytes:${archKey}`;
  return {
    bytes: new TextEncoder().encode(s).buffer,
    sha256: createHash("sha256").update(s).digest("hex"),
  };
}

// Manifest content (combined, post-Stage-2 / BET-264). Two arches.
const GOOD_MANIFEST = [
  "version=1.2.3",
  `file_linux_x64=manta-1.2.3-linux-x64.tar.gz`,
  `sha256_linux_x64=${tarballBytes("linux_x64").sha256}`,
  `file_linux_arm64=manta-1.2.3-linux-arm64.tar.gz`,
  `sha256_linux_arm64=${tarballBytes("linux_arm64").sha256}`,
  "release_channel=stable",
].join("\n");

// Handlers that make every default-target URL return healthy 200s.
function defaultHealthyHandlers(manifestText = GOOD_MANIFEST) {
  const tb = {
    "linux_x64": tarballBytes("linux_x64"),
    "linux_arm64": tarballBytes("linux_arm64"),
  };
  const manifestUrl = `${SITE_URL}/releases/manta-latest.txt`;
  return {
    "https://mantaui.com": () => makeRes({ status: 200 }),
    "https://gateway.mantaui.com": () => makeRes({ status: 200 }),
    "https://app.mantaui.com": () => makeRes({ status: 200 }),
    "https://mantaui.com/install.sh": () => makeRes({ status: 200, body: "#!/usr/bin/env bash\n" }),
    [manifestUrl]: ({ method }) => makeRes({ status: 200, body: manifestText }),
    [`${SITE_URL}/releases/manta-1.2.3-linux-x64.tar.gz`]: ({ method }) =>
      method === "HEAD"
        ? makeRes({ status: 200 })
        : makeRes({ status: 200, bodyBytes: tb.linux_x64.bytes }),
    [`${SITE_URL}/releases/manta-1.2.3-linux-arm64.tar.gz`]: ({ method }) =>
      method === "HEAD"
        ? makeRes({ status: 200 })
        : makeRes({ status: 200, bodyBytes: tb.linux_arm64.bytes }),
  };
}

// ---------------------------------------------------------------------------
// Constants — single source of truth mirrors publish.sh.
// ---------------------------------------------------------------------------

test("SITE_URL + ARCH_KEYS match scripts/release/publish.sh (single source of truth)", () => {
  assert.equal(SITE_URL, "https://mantaui.com");
  assert.deepEqual(ARCH_KEYS, ["linux_x64", "linux_arm64"]);
});

test("DEFAULT_TARGETS covers the live surfaces but NOT the per-arch tarballs (those live behind the manifest)", () => {
  const urls = DEFAULT_TARGETS.map((t) => t.url);
  for (const required of [
    "https://mantaui.com",
    "https://gateway.mantaui.com",
    "https://app.mantaui.com",
    "https://mantaui.com/install.sh",
  ]) {
    assert.ok(urls.includes(required), `default targets missing ${required}`);
  }
  // The combined legacy `manta-latest.tar.gz` is NOT served (BET-264
  // dropped it; only per-arch tarballs behind the manifest remain). A
  // stale probe here would 404 forever and flood notify().
  assert.ok(
    !urls.some((u) => u.endsWith("/manta-latest.tar.gz")),
    `DEFAULT_TARGETS must not probe the dead manta-latest.tar.gz URL`,
  );
  // gateway.mantaui.com must expect 200 — that IS the healthz route being healthy.
  const gateway = DEFAULT_TARGETS.find((t) => t.url === "https://gateway.mantaui.com");
  assert.equal(gateway.expect.status, 200, "gateway.mantaui.com must expect 200");
});

// ---------------------------------------------------------------------------
// runHealthcheck — flat probes (regression coverage)
// ---------------------------------------------------------------------------

test("runHealthcheck returns ok:true when every flat target matches AND the manifest drift check passes", async () => {
  const fetchFn = fakeFetch(defaultHealthyHandlers());
  const result = await runHealthcheck({ fetchFn, log: () => {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("runHealthcheck flags a flat status mismatch (manifest drift still passes)", async () => {
  const handlers = defaultHealthyHandlers();
  handlers["https://mantaui.com"] = () => makeRes({ status: 500 });
  const fetchFn = fakeFetch(handlers);
  const result = await runHealthcheck({ fetchFn, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].url, "https://mantaui.com");
  assert.match(result.failures[0].reason, /expected status 200, got 500/);
});

test("runHealthcheck flags a body-prefix mismatch (e.g. Caddy serves the homepage for a missing asset)", async () => {
  const handlers = defaultHealthyHandlers();
  handlers["https://mantaui.com/install.sh"] = () =>
    makeRes({ status: 200, body: "<!doctype html>\n<html>..." });
  const fetchFn = fakeFetch(handlers);
  const result = await runHealthcheck({ fetchFn, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].url, "https://mantaui.com/install.sh");
  assert.match(result.failures[0].reason, /body did not start with/);
});

test("runHealthcheck flags a flat fetch error (DNS / network)", async () => {
  const handlers = defaultHealthyHandlers();
  handlers["https://gateway.mantaui.com"] = async () => { throw new Error("ENOTFOUND"); };
  const fetchFn = fakeFetch(handlers);
  const result = await runHealthcheck({ fetchFn, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].url, "https://gateway.mantaui.com");
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
    targets: [{ url: "https://mantaui.com/install.sh", kind: "head", expect: { status: 200 } }],
    skipDriftCheck: true,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "HEAD");
});

// ---------------------------------------------------------------------------
// parseManifest — pure parser for the BET-264 combined manifest shape.
// ---------------------------------------------------------------------------

test("parseManifest extracts every key=value line (first occurrence wins)", () => {
  const text = [
    "version=1.2.3",
    "file_linux_x64=manta-1.2.3-linux-x64.tar.gz",
    "sha256_linux_x64=aaaa",
    "file_linux_arm64=manta-1.2.3-linux-arm64.tar.gz",
    "sha256_linux_arm64=bbbb",
    "release_channel=stable",
    "# a comment-looking line",
    "malformed line no equals",
    "version=9.9.9", // first-occurrence wins → ignored
  ].join("\n");
  assert.deepEqual(parseManifest(text), {
    version: "1.2.3",
    file_linux_x64: "manta-1.2.3-linux-x64.tar.gz",
    sha256_linux_x64: "aaaa",
    file_linux_arm64: "manta-1.2.3-linux-arm64.tar.gz",
    sha256_linux_arm64: "bbbb",
    release_channel: "stable",
  });
});

test("parseManifest returns {} on empty / non-string input", () => {
  assert.deepEqual(parseManifest(""), {});
  assert.deepEqual(parseManifest(null), {});
  assert.deepEqual(parseManifest(undefined), {});
  assert.deepEqual(parseManifest(42), {});
});

// ---------------------------------------------------------------------------
// verifyManifestDrift — the headline check (BET-171 F4 class, BET-264 two-arch).
// ---------------------------------------------------------------------------

test("verifyManifestDrift returns ok:true when every arch HEAD+sha256 matches", async () => {
  const handlers = defaultHealthyHandlers();
  // Drop the flat-probe URLs so a stray reference doesn't accidentally
  // pass — this test only exercises the drift check.
  const fetchFn = fakeFetch({
    [`${SITE_URL}/releases/manta-latest.txt`]: handlers[`${SITE_URL}/releases/manta-latest.txt`],
    [`${SITE_URL}/releases/manta-1.2.3-linux-x64.tar.gz`]: handlers[`${SITE_URL}/releases/manta-1.2.3-linux-x64.tar.gz`],
    [`${SITE_URL}/releases/manta-1.2.3-linux-arm64.tar.gz`]: handlers[`${SITE_URL}/releases/manta-1.2.3-linux-arm64.tar.gz`],
  });
  const result = await verifyManifestDrift({ fetchFn, log: () => {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("verifyManifestDrift flags a missing manifest (404 → single failure)", async () => {
  const fetchFn = fakeFetch({
    [`${SITE_URL}/releases/manta-latest.txt`]: () => makeRes({ status: 404 }),
  });
  const result = await verifyManifestDrift({ fetchFn, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].url, `${SITE_URL}/releases/manta-latest.txt`);
  assert.match(result.failures[0].reason, /expected status 200, got 404/);
});

test("verifyManifestDrift flags a manifest that lacks one arch's keys", async () => {
  // Manifest is missing file_linux_arm64 + sha256_linux_arm64 entirely.
  const malformed = [
    "version=1.2.3",
    "file_linux_x64=manta-1.2.3-linux-x64.tar.gz",
    `sha256_linux_x64=${tarballBytes("linux_x64").sha256}`,
  ].join("\n");
  const handlers = defaultHealthyHandlers(malformed);
  const fetchFn = fakeFetch({
    [`${SITE_URL}/releases/manta-latest.txt`]: handlers[`${SITE_URL}/releases/manta-latest.txt`],
    [`${SITE_URL}/releases/manta-1.2.3-linux-x64.tar.gz`]: handlers[`${SITE_URL}/releases/manta-1.2.3-linux-x64.tar.gz`],
  });
  const result = await verifyManifestDrift({ fetchFn, log: () => {} });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => /missing file_linux_arm64=/.test(f.reason)),
    `expected a 'missing file_linux_arm64=' failure, got ${JSON.stringify(result.failures)}`,
  );
});

test("verifyManifestDrift flags a tarball HEAD 404 on one arch", async () => {
  const handlers = defaultHealthyHandlers();
  handlers[`${SITE_URL}/releases/manta-1.2.3-linux-arm64.tar.gz`] = ({ method }) =>
    method === "HEAD"
      ? makeRes({ status: 404 })
      : makeRes({ status: 200, bodyBytes: tarballBytes("linux_arm64").bytes });
  const fetchFn = fakeFetch({
    [`${SITE_URL}/releases/manta-latest.txt`]: handlers[`${SITE_URL}/releases/manta-latest.txt`],
    [`${SITE_URL}/releases/manta-1.2.3-linux-x64.tar.gz`]: handlers[`${SITE_URL}/releases/manta-1.2.3-linux-x64.tar.gz`],
    [`${SITE_URL}/releases/manta-1.2.3-linux-arm64.tar.gz`]: handlers[`${SITE_URL}/releases/manta-1.2.3-linux-arm64.tar.gz`],
  });
  const result = await verifyManifestDrift({ fetchFn, log: () => {} });
  assert.equal(result.ok, false);
  const arm = result.failures.find((f) => f.url.endsWith("linux-arm64.tar.gz"));
  assert.ok(arm, "expected a failure for the arm64 tarball URL");
  assert.match(arm.reason, /expected status 200, got 404/);
});

test("verifyManifestDrift flags a sha256 mismatch on one arch (the headline BET-171 F4 case)", async () => {
  const handlers = defaultHealthyHandlers();
  // Swap the arm64 tarball bytes for unrelated content — sha256 won't match.
  handlers[`${SITE_URL}/releases/manta-1.2.3-linux-arm64.tar.gz`] = ({ method }) =>
    method === "HEAD"
      ? makeRes({ status: 200 })
      : makeRes({ status: 200, bodyBytes: new TextEncoder().encode("REPLACED-CONTENT").buffer });
  const fetchFn = fakeFetch({
    [`${SITE_URL}/releases/manta-latest.txt`]: handlers[`${SITE_URL}/releases/manta-latest.txt`],
    [`${SITE_URL}/releases/manta-1.2.3-linux-x64.tar.gz`]: handlers[`${SITE_URL}/releases/manta-1.2.3-linux-x64.tar.gz`],
    [`${SITE_URL}/releases/manta-1.2.3-linux-arm64.tar.gz`]: handlers[`${SITE_URL}/releases/manta-1.2.3-linux-arm64.tar.gz`],
  });
  const result = await verifyManifestDrift({ fetchFn, log: () => {} });
  assert.equal(result.ok, false);
  const arm = result.failures.find((f) => f.url.endsWith("linux-arm64.tar.gz"));
  assert.ok(arm, "expected a failure for the arm64 tarball URL");
  assert.match(arm.reason, /sha256 mismatch/);
  assert.match(arm.reason, /arch=linux_arm64/);
});

test("verifyManifestDrift refuses manifest entries with path-traversal / slashes", async () => {
  // A corrupted manifest pointing file_linux_x64 outside the releases dir
  // must NOT result in a curl-fetch outside our intent.
  const evil = [
    "version=1.2.3",
    "file_linux_x64=../../etc/passwd",
    "sha256_linux_x64=aaaa",
    "file_linux_arm64=manta-1.2.3-linux-arm64.tar.gz",
    `sha256_linux_arm64=${tarballBytes("linux_arm64").sha256}`,
  ].join("\n");
  const handlers = defaultHealthyHandlers(evil);
  const fetchFn = fakeFetch({
    [`${SITE_URL}/releases/manta-latest.txt`]: handlers[`${SITE_URL}/releases/manta-latest.txt`],
    [`${SITE_URL}/releases/manta-1.2.3-linux-arm64.tar.gz`]: handlers[`${SITE_URL}/releases/manta-1.2.3-linux-arm64.tar.gz`],
  });
  const result = await verifyManifestDrift({ fetchFn, log: () => {} });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => /unsafe characters/.test(f.reason)),
    `expected an unsafe-characters failure, got ${JSON.stringify(result.failures)}`,
  );
});

test("verifyManifestDrift returns a single failure for an empty siteUrl", async () => {
  const result = await verifyManifestDrift({ siteUrl: "", fetchFn: globalThis.fetch, log: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /siteUrl is empty/);
});

// ---------------------------------------------------------------------------
// parseTargetsEnv — env-override behavior is unchanged by the refactor.
// ---------------------------------------------------------------------------

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
