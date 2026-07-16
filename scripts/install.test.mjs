import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  resolveConfig,
  parsePort,
  resolveTarballUrl,
  isValidVersion,
  checkIdentity,
  waitForHealth,
  formatPairingOutput,
  formatExpiry,
  renderShellConfig,
  DEFAULT_PORT,
  DEFAULT_RELEASE_HOST,
} from "./install-lib.mjs";

const HOME = "/home/tester";

// ----------------------------------------------------------------------------
// resolveConfig — arg/env parsing with MANTA_HOME / MANTA_TARBALL_URL overrides
// ----------------------------------------------------------------------------

test("resolveConfig applies defaults when env is empty", () => {
  const cfg = resolveConfig({ env: {}, home: HOME });
  assert.equal(cfg.buiHome, join(HOME, "bui"));
  assert.equal(cfg.authDir, join(HOME, ".manta"));
  assert.equal(cfg.authFile, join(HOME, ".manta", "auth.json"));
  assert.equal(cfg.tarballUrl, null);
  assert.equal(cfg.releaseHost, DEFAULT_RELEASE_HOST);
  assert.equal(cfg.port, DEFAULT_PORT);
  assert.equal(cfg.healthUrl, `http://127.0.0.1:${DEFAULT_PORT}/auth/status`);
});

test("resolveConfig honors MANTA_HOME override", () => {
  const cfg = resolveConfig({ env: { MANTA_HOME: "/opt/bui" }, home: HOME });
  assert.equal(cfg.buiHome, "/opt/bui");
  // auth dir stays under HOME, never inside MANTA_HOME — identity survives upgrades
  assert.equal(cfg.authDir, join(HOME, ".manta"));
});

test("resolveConfig honors MANTA_TARBALL_URL override", () => {
  const cfg = resolveConfig({
    env: { MANTA_TARBALL_URL: "file:///tmp/bui-test.tar.gz" },
    home: HOME,
  });
  assert.equal(cfg.tarballUrl, "file:///tmp/bui-test.tar.gz");
});

test("resolveConfig treats empty-string env vars as unset (shell footgun)", () => {
  const cfg = resolveConfig({
    env: { MANTA_HOME: "", MANTA_TARBALL_URL: "", MANTA_MOBILE_PORT: "" },
    home: HOME,
  });
  assert.equal(cfg.buiHome, join(HOME, "bui"));
  assert.equal(cfg.tarballUrl, null);
  assert.equal(cfg.port, DEFAULT_PORT);
});

test("resolveConfig strips trailing slash from MANTA_RELEASE_HOST", () => {
  const cfg = resolveConfig({
    env: { MANTA_RELEASE_HOST: "https://mirror.example.com/" },
    home: HOME,
  });
  assert.equal(cfg.releaseHost, "https://mirror.example.com");
});

test("resolveConfig honors MANTA_MOBILE_PORT and derives healthUrl", () => {
  const cfg = resolveConfig({ env: { MANTA_MOBILE_PORT: "9999" }, home: HOME });
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.healthUrl, "http://127.0.0.1:9999/auth/status");
});

// ----------------------------------------------------------------------------
// parsePort
// ----------------------------------------------------------------------------

test("parsePort accepts valid ports, rejects junk", () => {
  assert.equal(parsePort("8787"), 8787);
  assert.equal(parsePort("1"), 1);
  assert.equal(parsePort("65535"), 65535);
  assert.equal(parsePort("0"), undefined);
  assert.equal(parsePort("65536"), undefined);
  assert.equal(parsePort("-1"), undefined);
  assert.equal(parsePort("abc"), undefined);
  assert.equal(parsePort(""), undefined);
  assert.equal(parsePort(null), undefined);
  assert.equal(parsePort("80.5"), undefined);
});

// ----------------------------------------------------------------------------
// resolveTarballUrl / isValidVersion
// ----------------------------------------------------------------------------

test("resolveTarballUrl builds default URL from host + version", () => {
  const url = resolveTarballUrl({
    tarballUrl: null,
    releaseHost: "https://app.mantaui.com",
    version: "0.0.1",
  });
  assert.equal(url, "https://app.mantaui.com/releases/bui-0.0.1.tar.gz");
});

test("resolveTarballUrl uses explicit override verbatim", () => {
  const url = resolveTarballUrl({
    tarballUrl: "file:///tmp/x.tar.gz",
    releaseHost: "https://ignored.example.com",
    version: "9.9.9",
  });
  assert.equal(url, "file:///tmp/x.tar.gz");
});

test("resolveTarballUrl strips trailing slash on host", () => {
  const url = resolveTarballUrl({
    tarballUrl: "",
    releaseHost: "https://mirror.example.com/",
    version: "1.2.3-rc.1",
  });
  assert.equal(url, "https://mirror.example.com/releases/bui-1.2.3-rc.1.tar.gz");
});

test("resolveTarballUrl rejects a path-traversal version", () => {
  assert.throws(
    () =>
      resolveTarballUrl({
        tarballUrl: null,
        releaseHost: "https://x.com",
        version: "../../etc/passwd",
      }),
    /invalid version/,
  );
});

test("isValidVersion accepts semver-ish, rejects slashes", () => {
  assert.equal(isValidVersion("0.0.1"), true);
  assert.equal(isValidVersion("1.2.3-rc.1"), true);
  assert.equal(isValidVersion("latest"), true);
  assert.equal(isValidVersion("../x"), false);
  assert.equal(isValidVersion("a/b"), false);
  assert.equal(isValidVersion(""), false);
  assert.equal(isValidVersion(null), false);
});

// ----------------------------------------------------------------------------
// checkIdentity — idempotency: preserve existing box identity
// ----------------------------------------------------------------------------

test("checkIdentity reports preserve when auth.json exists", () => {
  const cfg = resolveConfig({ env: {}, home: HOME });
  const seen = [];
  const res = checkIdentity(cfg, {
    exists: (p) => {
      seen.push(p);
      return true;
    },
  });
  assert.equal(res.preserveIdentity, true);
  assert.equal(res.authFile, join(HOME, ".manta", "auth.json"));
  assert.match(res.reason, /preserving/);
  assert.deepEqual(seen, [join(HOME, ".manta", "auth.json")]);
});

test("checkIdentity reports fresh when auth.json missing", () => {
  const cfg = resolveConfig({ env: {}, home: HOME });
  const res = checkIdentity(cfg, { exists: () => false });
  assert.equal(res.preserveIdentity, false);
  assert.match(res.reason, /mint/);
});

test("checkIdentity requires authFile", () => {
  assert.throws(() => checkIdentity({}, { exists: () => true }), /authFile required/);
});

// ----------------------------------------------------------------------------
// waitForHealth — poller with injected fetch + clock (no real sleeps)
// ----------------------------------------------------------------------------

test("waitForHealth returns on first 200", async () => {
  let calls = 0;
  const sleeps = [];
  const res = await waitForHealth("http://127.0.0.1:8787/auth/status", {
    maxAttempts: 5,
    intervalMs: 1000,
    fetchFn: async () => {
      calls++;
      return { status: 200 };
    },
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.equal(sleeps.length, 0, "no sleep before a first-try success");
});

test("waitForHealth treats a gated 401 as healthy (server is listening)", async () => {
  const res = await waitForHealth("http://127.0.0.1:8787/auth/status", {
    maxAttempts: 3,
    fetchFn: async () => ({ status: 401 }),
    sleep: async () => {},
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(res.status, 401);
});

test("waitForHealth retries on connection-refused then succeeds", async () => {
  let calls = 0;
  const sleeps = [];
  const res = await waitForHealth("http://127.0.0.1:8787/auth/status", {
    maxAttempts: 5,
    intervalMs: 250,
    fetchFn: async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return { status: 200 };
    },
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 250], "slept between the two failed attempts");
});

test("waitForHealth gives up after the attempt cap", async () => {
  let calls = 0;
  const res = await waitForHealth("http://127.0.0.1:8787/auth/status", {
    maxAttempts: 4,
    intervalMs: 10,
    fetchFn: async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    },
    sleep: async () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.attempts, 4);
  assert.equal(calls, 4);
  assert.match(res.error, /did not become healthy/);
  assert.match(res.error, /ECONNREFUSED/);
});

test("waitForHealth requires a url and a fetch", async () => {
  await assert.rejects(() => waitForHealth("", { fetchFn: async () => ({ status: 200 }) }), /url required/);
  await assert.rejects(() => waitForHealth("http://x", { fetchFn: null }), /no fetch/);
});

// ----------------------------------------------------------------------------
// formatPairingOutput / formatExpiry
// ----------------------------------------------------------------------------

test("formatPairingOutput produces a stable human block", () => {
  const out = formatPairingOutput({
    pairing_code: "847291",
    box_id: "0123456789abcdef0123456789abcdef",
    expiresAt: Date.UTC(2026, 6, 3, 12, 34, 56),
  });
  assert.match(out, /Pairing code:  847291/);
  assert.match(out, /Box ID:        0123456789abcdef0123456789abcdef/);
  assert.match(out, /Expires:       2026-07-03 12:34:56 UTC/);
  assert.match(out, /Enter the pairing code in the bui desktop app/);
});

test("formatPairingOutput prints ingress hint when no serverUrl given", () => {
  const out = formatPairingOutput({ pairing_code: "000123" });
  assert.match(out, /Pairing code:  000123/);
  assert.match(out, /Tailscale/);
  assert.match(out, /Reverse proxy/);
});

test("formatPairingOutput includes serverUrl when provided", () => {
  const out = formatPairingOutput({
    pairing_code: "111111",
    serverUrl: "https://box.tailnet.ts.net",
  });
  assert.match(out, /Server URL:    https:\/\/box\.tailnet\.ts\.net/);
  assert.doesNotMatch(out, /Tailscale \/ VPN/);
});

test("formatPairingOutput rejects a non-6-digit code", () => {
  assert.throws(() => formatPairingOutput({ pairing_code: "12345" }), /6 digits/);
  assert.throws(() => formatPairingOutput({ pairing_code: "abcdef" }), /6 digits/);
  assert.throws(() => formatPairingOutput({}), /6 digits/);
});

test("formatExpiry handles epoch-ms, ISO string, and junk", () => {
  assert.equal(formatExpiry(Date.UTC(2026, 0, 2, 3, 4, 5)), "2026-01-02 03:04:05 UTC");
  assert.equal(formatExpiry("2026-01-02T03:04:05.000Z"), "2026-01-02 03:04:05 UTC");
  assert.equal(formatExpiry("not-a-date"), "not-a-date");
});

// ----------------------------------------------------------------------------
// renderShellConfig — the shell bridge install.sh evals
// ----------------------------------------------------------------------------

test("renderShellConfig emits eval-able KEY=VALUE lines", () => {
  const cfg = resolveConfig({ env: {}, home: HOME });
  const out = renderShellConfig(cfg, { version: "0.0.1" });
  assert.match(out, new RegExp(`MANTA_HOME='${join(HOME, "bui")}'`));
  assert.match(out, /MANTA_AUTH_FILE='.*\.manta\/auth\.json'/);
  assert.match(out, /MANTA_TARBALL_URL='.*\/releases\/bui-0\.0\.1\.tar\.gz'/);
  assert.match(out, /MANTA_PORT='8787'/);
  assert.match(out, /MANTA_HEALTH_URL='http:\/\/127\.0\.0\.1:8787\/auth\/status'/);
});

test("renderShellConfig single-quotes values with spaces safely", () => {
  const cfg = resolveConfig({ env: { MANTA_HOME: "/opt/my bui" }, home: HOME });
  const out = renderShellConfig(cfg, { version: "0.0.1" });
  assert.match(out, /MANTA_HOME='\/opt\/my bui'/);
});
