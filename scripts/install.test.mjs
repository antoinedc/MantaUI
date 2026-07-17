import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import {
  resolveConfig,
  parsePort,
  resolveTarballUrl,
  isValidVersion,
  checkIdentity,
  waitForHealth,
  waitForRelay,
  readBoxIdentity,
  formatPairingOutput,
  formatExpiry,
  renderShellConfig,
  stripJsoncLineComments,
  mergeOpencodeConfig,
  renderSystemdUnit,
  OPENCODE_CLAUDE_AUTH_PLUGIN,
  DEFAULT_PORT,
  DEFAULT_RELEASE_HOST,
} from "./install-lib.mjs";

const HOME = "/home/tester";
const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = join(__dirname, "install.sh");

/**
 * Source scripts/install.sh in test mode (MANTA_INSTALL_TEST_MODE=1) after
 * applying `preBody` (mocks / overrides), then call `bootstrap_node`. Returns
 * the captured stdout+stderr as a single string. The harness writes a tiny bash
 * script to a temp file so we don't fight bash quoting rules.
 *
 * Mock pattern: define functions AFTER sourcing install.sh. Bash uses the
 * latest definition, so the test's mocks override install.sh's helpers. The
 * test mock for `command` is what makes "node missing on PATH" testable in a
 * sandbox that already has node installed.
 *
 * Never throws — bootstrap_node's `die` calls `exit 1`, which would otherwise
 * propagate via execSync's thrown-on-non-zero-exit behavior. The harness
 * swallows the error and returns the captured output (with BOOTSTRAP_EXIT=NNN
 * appended) so the test can assert on the message + exit code together.
 */
function runBootstrap({ preBody = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "manta-bootstrap-"));
  const script = join(dir, "test.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set +e
export MANTA_INSTALL_TEST_MODE=1
source '${INSTALL_SH}'
${preBody}
bootstrap_node
rc=$?
echo "BOOTSTRAP_EXIT=$rc"
exit $rc
`,
    { mode: 0o755 },
  );
  try {
    try {
      return execSync(`bash ${script}`, {
        env: { ...process.env, PATH: process.env.PATH },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // execSync throws when the child exits non-zero (bootstrap_node calls
      // `die` → `exit 1` for the failure paths). The stderr/stdout is on
      // the error object — concatenate and return so callers can assert on
      // the message AND the BOOTSTRAP_EXIT=N marker.
      const out = (e.stdout ?? "") + (e.stderr ?? "");
      // execSync's stdout/stderr are string when encoding is set.
      return out;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------
// resolveConfig — arg/env parsing with MANTA_HOME / MANTA_TARBALL_URL overrides
// ----------------------------------------------------------------------------

test("resolveConfig applies defaults when env is empty", () => {
  const cfg = resolveConfig({ env: {}, home: HOME });
  assert.equal(cfg.buiHome, join(HOME, "manta"));
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
  assert.equal(cfg.buiHome, join(HOME, "manta"));
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
    releaseHost: "https://mantaui.com",
    version: "0.0.1",
  });
  assert.equal(url, "https://mantaui.com/releases/manta-0.0.1.tar.gz");
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
  assert.equal(url, "https://mirror.example.com/releases/manta-1.2.3-rc.1.tar.gz");
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
// waitForRelay — polls /relay/status, install.sh's relay-handshake probe
// ----------------------------------------------------------------------------

test("waitForRelay returns connected=true on a 2xx with connected:true", async () => {
  const r = await waitForRelay("http://127.0.0.1:8787", {
    maxAttempts: 3,
    intervalMs: 10,
    fetchFn: async () => ({
      status: 200,
      json: async () => ({ enabled: true, connected: true }),
    }),
    sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.enabled, true);
  assert.equal(r.connected, true);
  assert.equal(r.attempts, 1, "no sleep before a first-try success");
});

test("waitForRelay returns enabled=false (short-circuit) on enabled:false", async () => {
  // The server is up and reports the agent is disabled (config opted out).
  // install.sh treats this as success-with-no-relay — NOT a failure.
  let calls = 0;
  const r = await waitForRelay("http://127.0.0.1:8787", {
    maxAttempts: 5,
    intervalMs: 10,
    fetchFn: async () => {
      calls++;
      return { status: 200, json: async () => ({ enabled: false, connected: false }) };
    },
    sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.enabled, false);
  assert.equal(r.connected, false);
  assert.equal(calls, 1, "settles immediately — no reason to re-poll a disabled agent");
});

test("waitForRelay retries on ECONNREFUSED and succeeds on the next attempt", async () => {
  let calls = 0;
  const sleeps = [];
  const r = await waitForRelay("http://127.0.0.1:8787", {
    maxAttempts: 5,
    intervalMs: 250,
    fetchFn: async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return { status: 200, json: async () => ({ enabled: true, connected: true }) };
    },
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.deepEqual(sleeps, [250, 250], "slept between the two failed attempts");
});

test("waitForRelay keeps retrying while connected:false (server up, handshake still pending)", async () => {
  // Server is up, but the agent is mid-backoff — connected flips to true on
  // attempt 4. install.sh keeps polling until maxAttempts because that's the
  // only way to learn whether the handshake eventually succeeds.
  let calls = 0;
  const r = await waitForRelay("http://127.0.0.1:8787", {
    maxAttempts: 5,
    intervalMs: 5,
    fetchFn: async () => {
      calls++;
      const connected = calls >= 4;
      return { status: 200, json: async () => ({ enabled: true, connected }) };
    },
    sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.connected, true);
  assert.equal(r.attempts, 4);
});

test("waitForRelay gives up after maxAttempts and reports connected:false", async () => {
  // The "degraded" path install.sh warn()s on. The lib returns ok=false so
  // callers can decide whether to surface it; install.sh treats both ok=false
  // and connected=false as a warn (never a die).
  const r = await waitForRelay("http://127.0.0.1:8787", {
    maxAttempts: 3,
    intervalMs: 1,
    fetchFn: async () => ({
      status: 200,
      json: async () => ({ enabled: true, connected: false }),
    }),
    sleep: async () => {},
  });
  assert.equal(r.ok, true, "the server answered every poll — that's a successful probe");
  assert.equal(r.connected, false, "but the agent isn't connected yet");
  assert.equal(r.attempts, 3);
});

test("waitForRelay tolerates a non-JSON body (still reports ok=true)", async () => {
  // Defensive: a 200 with an empty/non-JSON body shouldn't crash the poll.
  const r = await waitForRelay("http://127.0.0.1:8787", {
    maxAttempts: 1,
    intervalMs: 0,
    fetchFn: async () => ({
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }),
    sleep: async () => {},
  });
  assert.equal(r.ok, true);
  // body couldn't be parsed → defaults are conservative (false).
  assert.equal(r.enabled, false);
  assert.equal(r.connected, false);
});

test("waitForRelay treats a non-2xx as 'not yet' and retries", async () => {
  // A 403 from /relay/status means a non-loopback caller hit it — install.sh
  // is running locally so this won't happen, but the lib must be defensive.
  let calls = 0;
  const r = await waitForRelay("http://127.0.0.1:8787", {
    maxAttempts: 3,
    intervalMs: 1,
    fetchFn: async () => {
      calls++;
      if (calls < 2) return { status: 403, json: async () => ({}) };
      return { status: 200, json: async () => ({ enabled: true, connected: true }) };
    },
    sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});

test("waitForRelay appends /relay/status to the base and strips trailing slashes", async () => {
  const urls = [];
  await waitForRelay("http://127.0.0.1:8787/", {
    maxAttempts: 1,
    intervalMs: 0,
    fetchFn: async (u) => {
      urls.push(u);
      return { status: 200, json: async () => ({ enabled: true, connected: true }) };
    },
    sleep: async () => {},
  });
  assert.deepEqual(urls, ["http://127.0.0.1:8787/relay/status"]);
});

test("waitForRelay gives up with ok=false when the server never responds", async () => {
  const r = await waitForRelay("http://127.0.0.1:8787", {
    maxAttempts: 4,
    intervalMs: 1,
    fetchFn: async () => {
      throw new Error("ECONNREFUSED");
    },
    sleep: async () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 4);
  assert.equal(r.connected, false);
  assert.match(r.error, /did not connect/);
  assert.match(r.error, /ECONNREFUSED/);
});

test("waitForRelay requires a base and a fetch", async () => {
  await assert.rejects(() => waitForRelay("", { fetchFn: async () => ({}) }), /healthUrlBase required/);
  await assert.rejects(() => waitForRelay("http://x", { fetchFn: null }), /no fetch/);
});

// ----------------------------------------------------------------------------
// readBoxIdentity — install.sh's auth.json reader (re-export of loadAuth)
// ----------------------------------------------------------------------------

test("readBoxIdentity returns the box identity from a valid auth.json", () => {
  // loadAuth (the underlying reader) takes a path and reads the real fs —
  // already unit-tested in src/server/auth.test.mjs. Here we round-trip
  // through a temp file to confirm install.sh's re-export actually calls it
  // and surfaces the box_id (the install heredoc consumes this).
  const dir = mkdtempSync(join(tmpdir(), "manta-install-readid-"));
  const authFile = join(dir, "auth.json");
  writeFileSync(
    authFile,
    JSON.stringify({
      box_id: "0123456789abcdef0123456789abcdef",
      box_token: "11112222333344445555666677778888",
      created_at: 1700000000000,
    }),
  );
  try {
    const id = readBoxIdentity(authFile);
    assert.ok(id, "readBoxIdentity returned an identity for a valid auth.json");
    assert.equal(id.box_id, "0123456789abcdef0123456789abcdef");
    assert.equal(id.box_token, "11112222333344445555666677778888");
    assert.equal(id.created_at, 1700000000000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoxIdentity returns null when the file is missing (fresh box — install must not crash)", () => {
  // install.sh must not blow up if auth.json hasn't been written yet (the
  // server mints it on first start, which may be a moment after this script
  // runs). The fallback path is to omit the Box ID line from the heredoc.
  assert.equal(readBoxIdentity("/definitely/not/here/auth.json"), null);
});

test("readBoxIdentity returns null on a corrupt auth.json (server will mint a fresh one)", () => {
  const dir = mkdtempSync(join(tmpdir(), "manta-install-readid-"));
  const authFile = join(dir, "auth.json");
  writeFileSync(authFile, "not json{");
  try {
    assert.equal(readBoxIdentity(authFile), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.match(out, /Enter the pairing code in the Manta desktop app/);
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
  assert.match(out, new RegExp(`MANTA_HOME='${join(HOME, "manta")}'`));
  assert.match(out, /MANTA_AUTH_FILE='.*\.manta\/auth\.json'/);
  assert.match(out, /MANTA_TARBALL_URL='.*\/releases\/manta-0\.0\.1\.tar\.gz'/);
  assert.match(out, /MANTA_PORT='8787'/);
  assert.match(out, /MANTA_HEALTH_URL='http:\/\/127\.0\.0\.1:8787\/auth\/status'/);
});

test("renderShellConfig single-quotes values with spaces safely", () => {
  const cfg = resolveConfig({ env: { MANTA_HOME: "/opt/my bui" }, home: HOME });
  const out = renderShellConfig(cfg, { version: "0.0.1" });
  assert.match(out, /MANTA_HOME='\/opt\/my bui'/);
});

// ----------------------------------------------------------------------------
// stripJsoncLineComments — keeps // inside strings intact
// ----------------------------------------------------------------------------

test("stripJsoncLineComments removes line comments, preserves strings", () => {
  const src = `{
    // drop this
    "model": "claude-sonnet-4-6", // also a comment
    "note": "http://example.com", // url must survive
    "label": "// not a comment"
  }`;
  const out = stripJsoncLineComments(src);
  assert.doesNotMatch(out, /drop this/);
  assert.doesNotMatch(out, /also a comment/);
  assert.match(out, /"note": "http:\/\/example\.com"/);
  assert.match(out, /"label": "\/\/ not a comment"/);
});

// ----------------------------------------------------------------------------
// mergeOpencodeConfig — MERGE, never clobber; idempotent; corrupt-safe
// ----------------------------------------------------------------------------

test("mergeOpencodeConfig on empty input seeds plugin only", () => {
  const { text, corrupt, plugin } = mergeOpencodeConfig("");
  assert.equal(corrupt, false, "empty input is not corrupt");
  assert.deepEqual(plugin, [OPENCODE_CLAUDE_AUTH_PLUGIN]);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.plugin, [OPENCODE_CLAUDE_AUTH_PLUGIN]);
  assert.equal(parsed.theme, undefined);
});

test("mergeOpencodeConfig preserves unrelated keys (model, theme, provider)", () => {
  const before = JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      theme: "system",
      model: "anthropic/claude-sonnet-4-6",
      provider: {
        voska: {
          npm: "@ai-sdk/openai-compatible",
          name: "Voska AI",
          options: { baseURL: "https://api.example.com/v1", apiKey: "sk-test" },
          models: {},
        },
      },
    },
    null,
    2,
  );
  const { text, corrupt, plugin } = mergeOpencodeConfig(before);
  assert.equal(corrupt, false);
  const after = JSON.parse(text);
  assert.equal(after.theme, "system");
  assert.equal(after.model, "anthropic/claude-sonnet-4-6");
  assert.equal(after.$schema, "https://opencode.ai/config.json");
  assert.equal(after.provider.voska.options.baseURL, "https://api.example.com/v1");
  assert.equal(after.provider.voska.options.apiKey, "sk-test");
  assert.deepEqual(plugin, [OPENCODE_CLAUDE_AUTH_PLUGIN]);
});

test("mergeOpencodeConfig is byte-identical when plugin already present", () => {
  const before = JSON.stringify(
    { theme: "system", plugin: [OPENCODE_CLAUDE_AUTH_PLUGIN] },
    null,
    2,
  ) + "\n";
  const { text, corrupt, plugin } = mergeOpencodeConfig(before);
  assert.equal(corrupt, false);
  assert.deepEqual(plugin, [OPENCODE_CLAUDE_AUTH_PLUGIN]);
  assert.equal(text, before);
});

test("mergeOpencodeConfig appends without duplicating an existing match", () => {
  // The auth plugin is already present (1st slot); the new entry is appended.
  const before = JSON.stringify(
    { plugin: [OPENCODE_CLAUDE_AUTH_PLUGIN, "some-other-plugin"] },
    null,
    2,
  ) + "\n";
  const { text, plugin } = mergeOpencodeConfig(before);
  assert.deepEqual(plugin, [OPENCODE_CLAUDE_AUTH_PLUGIN, "some-other-plugin"]);
  const after = JSON.parse(text);
  assert.deepEqual(after.plugin, [OPENCODE_CLAUDE_AUTH_PLUGIN, "some-other-plugin"]);
});

test("mergeOpencodeConfig appends the auth plugin at the END when missing", () => {
  // Order-preserving: existing entries stay where they were; the new one is appended.
  const before = JSON.stringify(
    { plugin: ["some-other-plugin"] },
    null,
    2,
  ) + "\n";
  const { text, plugin } = mergeOpencodeConfig(before);
  assert.deepEqual(plugin, ["some-other-plugin", OPENCODE_CLAUDE_AUTH_PLUGIN]);
  const after = JSON.parse(text);
  assert.deepEqual(after.plugin, ["some-other-plugin", OPENCODE_CLAUDE_AUTH_PLUGIN]);
});

test("mergeOpencodeConfig strips JSONC comments and merges plugin", () => {
  const jsonc = `{
    // top-level comment
    "theme": "system", // inline
    "plugin": ["already-there"]
  }`;
  const { text, corrupt, plugin } = mergeOpencodeConfig(jsonc);
  assert.equal(corrupt, false);
  const after = JSON.parse(text);
  assert.equal(after.theme, "system");
  assert.deepEqual(plugin, ["already-there", OPENCODE_CLAUDE_AUTH_PLUGIN]);
});

test("mergeOpencodeConfig flags corrupt JSONC and starts from {}", () => {
  const { text, corrupt, plugin } = mergeOpencodeConfig("{ broken: not-json,");
  assert.equal(corrupt, true);
  const after = JSON.parse(text);
  assert.deepEqual(after.plugin, [OPENCODE_CLAUDE_AUTH_PLUGIN]);
});

test("mergeOpencodeConfig coerces non-object root to {} + corrupt", () => {
  const { text, corrupt } = mergeOpencodeConfig("[1,2,3]");
  assert.equal(corrupt, true);
  const after = JSON.parse(text);
  assert.deepEqual(after.plugin, [OPENCODE_CLAUDE_AUTH_PLUGIN]);
});

test("mergeOpencodeConfig tolerates a malformed plugin array (drops non-strings)", () => {
  const before = JSON.stringify(
    { plugin: ["keep-me", null, 42, { junk: true }, "also-keep"] },
    null,
    2,
  );
  const { plugin } = mergeOpencodeConfig(before);
  // Non-strings are dropped; the new auth plugin is appended.
  assert.deepEqual(plugin, ["keep-me", "also-keep", OPENCODE_CLAUDE_AUTH_PLUGIN]);
});

test("mergeOpencodeConfig is null/undefined safe (treated as empty)", () => {
  const a = mergeOpencodeConfig(null);
  const b = mergeOpencodeConfig(undefined);
  assert.equal(a.corrupt, false);
  assert.equal(b.corrupt, false);
  assert.deepEqual(a.plugin, [OPENCODE_CLAUDE_AUTH_PLUGIN]);
  assert.deepEqual(b.plugin, [OPENCODE_CLAUDE_AUTH_PLUGIN]);
});

// ----------------------------------------------------------------------------
// renderSystemdUnit — placeholder substitution used by install.sh
// ----------------------------------------------------------------------------

test("renderSystemdUnit substitutes placeholders verbatim", () => {
  const tpl = `ExecStart=@@OPENCODE_BIN@@ serve --port @@OPENCODE_PORT@@
WorkingDirectory=@@MANTA_HOME@@
`;
  const out = renderSystemdUnit(tpl, {
    OPENCODE_BIN: "/usr/local/bin/opencode",
    OPENCODE_PORT: "4096",
    MANTA_HOME: "/home/dev/manta",
  });
  assert.match(out, /ExecStart=\/usr\/local\/bin\/opencode serve --port 4096/);
  assert.match(out, /WorkingDirectory=\/home\/dev\/manta/);
  assert.doesNotMatch(out, /@@/);
});

test("renderSystemdUnit refuses values containing the token (loop guard)", () => {
  assert.throws(
    () =>
      renderSystemdUnit("X=@@A@@", {
        A: "x@@A@@y",
      }),
    /contains the token/,
  );
});

test("renderSystemdUnit rejects non-string template / non-object placeholders", () => {
  assert.throws(() => renderSystemdUnit(null, {}), /must be a string/);
  assert.throws(() => renderSystemdUnit("X=@@A@@", null), /placeholders object required/);
});

// ----------------------------------------------------------------------------
// waitForHealth — acceptAnyStatus option (default true, opt-in strict mode)
// ----------------------------------------------------------------------------

test("waitForHealth acceptAnyStatus=false requires 2xx/3xx (rejects 401)", async () => {
  const res = await waitForHealth("http://127.0.0.1:4096/", {
    maxAttempts: 3,
    acceptAnyStatus: false,
    fetchFn: async () => ({ status: 401 }),
    sleep: async () => {},
  });
  assert.equal(res.ok, false, "401 must NOT count as healthy when acceptAnyStatus=false");
  assert.equal(res.attempts, 3);
  assert.match(res.error, /non-2xx status 401/);
});

test("waitForHealth acceptAnyStatus=false accepts a 200", async () => {
  const res = await waitForHealth("http://127.0.0.1:4096/", {
    acceptAnyStatus: false,
    fetchFn: async () => ({ status: 200 }),
    sleep: async () => {},
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
});

test("waitForHealth acceptAnyStatus=true (default) accepts 404 as healthy", async () => {
  const res = await waitForHealth("http://127.0.0.1:4096/", {
    fetchFn: async () => ({ status: 404 }),
    sleep: async () => {},
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, 404);
});

// ----------------------------------------------------------------------------
// install.sh — bash syntax + bootstrap_node (BET-162 F1 fix)
// ----------------------------------------------------------------------------
//
// These tests shell out to bash because install.sh is bash, not JS. They use
// the MANTA_INSTALL_TEST_MODE=1 sentinel (added in install.sh) which bails
// before the install body runs and only loads the bash helpers
// (log/ok/warn/die + bootstrap_node + install_node_via_* + require_cmd). The
// unit tests then exercise the helpers with mocked apt/dnf/yum call sites so
// nothing hits the network.

test("install.sh is bash-syntax-clean (bash -n)", () => {
  // Sanity check that the script parses. The harness writes it to a temp
  // file so the bash error message includes a useful path; bash -n itself
  // doesn't need to write, but the temp-file dance keeps the assertion
  // independent of where the test runner lives.
  const dir = mkdtempSync(join(tmpdir(), "manta-install-syntax-"));
  const script = join(dir, "install.sh");
  writeFileSync(script, readFileSync(INSTALL_SH));
  try {
    execSync(`bash -n ${script}`, { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bootstrap_node is a no-op when node is already on PATH (idempotent)", () => {
  // The harness's bash env has node on PATH (the test runner depends on it).
  // The mock for install_node_via_apt MUST NOT fire — bootstrap_node should
  // early-return at the `command -v node` check. This is the re-run path:
  // a box that already has node should NOT touch apt.
  const out = runBootstrap({
    preBody: `
# Mock the apt installer — if this fires, the no-op guarantee is broken.
install_node_via_apt() {
  echo "MOCK_APT_CALLED" >&2
  return 0
}
install_node_via_dnf() {
  echo "MOCK_DNF_CALLED" >&2
  return 0
}
install_node_via_yum() {
  echo "MOCK_YUM_CALLED" >&2
  return 0
}
`,
  });
  assert.doesNotMatch(out, /MOCK_APT_CALLED/);
  assert.doesNotMatch(out, /MOCK_DNF_CALLED/);
  assert.doesNotMatch(out, /MOCK_YUM_CALLED/);
  assert.doesNotMatch(out, /bootstrap_node|NodeSource/, "no bootstrap log lines when node is on PATH");
  assert.match(out, /BOOTSTRAP_EXIT=0/);
});

test("bootstrap_node calls install_node_via_apt on Debian/Ubuntu when node is missing", () => {
  // Pretend node is missing by shadowing `command -v node`. The bash test
  // env has node, so without the shadow bootstrap_node would no-op.
  const out = runBootstrap({
    preBody: `
# Pretend \`command -v node\` always fails.
command() {
  if [ "$1" = "-v" ] && [ "$2" = "node" ]; then
    return 1
  fi
  builtin command "$@"
}

# Force the Debian/Ubuntu distro branch (no /etc/os-release in some sandboxes).
detect_distro_id() { echo "ubuntu"; }

# Mock the apt installer — if this fires, the call site is wired right.
install_node_via_apt() {
  echo "MOCK_APT_CALLED"
  return 0
}
`,
  });
  assert.match(out, /MOCK_APT_CALLED/, "apt installer was called");
  assert.match(out, /bootstrapping Node\.js 20\.x/);
  // The mock returns 0, so the install is "successful" — but bootstrap_node
  // re-checks `command -v node` afterwards and our shadow still says "missing",
  // so it dies. That's the expected flow when the install doesn't actually
  // put node on PATH (a real apt install would).
  assert.match(out, /node is still missing after bootstrap/);
});

test("bootstrap_node calls install_node_via_dnf on Fedora when node is missing", () => {
  const out = runBootstrap({
    preBody: `
command() {
  if [ "$1" = "-v" ] && [ "$2" = "node" ]; then
    return 1
  fi
  builtin command "$@"
}
detect_distro_id() { echo "fedora"; }
install_node_via_dnf() {
  echo "MOCK_DNF_CALLED"
  return 0
}
`,
  });
  assert.match(out, /MOCK_DNF_CALLED/);
  assert.match(out, /node is still missing after bootstrap/);
});

test("bootstrap_node calls install_node_via_yum on RHEL when dnf is absent", () => {
  const out = runBootstrap({
    preBody: `
command() {
  if [ "$1" = "-v" ] && [ "$2" = "node" ]; then
    return 1
  fi
  builtin command "$@"
}
detect_distro_id() { echo "rhel"; }
# Make dnf fail so yum is tried as the fallback.
install_node_via_dnf() {
  echo "MOCK_DNF_CALLED"
  return 1
}
install_node_via_yum() {
  echo "MOCK_YUM_CALLED"
  return 0
}
`,
  });
  assert.match(out, /MOCK_DNF_CALLED/);
  assert.match(out, /MOCK_YUM_CALLED/);
  assert.match(out, /node is still missing after bootstrap/);
});

test("bootstrap_node dies with a clear hint when the distro installer fails", () => {
  // The mock returns non-zero — install_node_via_apt fails. The script
  // MUST surface the failure as a `die` with the manual-install hint, NOT
  // silently swallow it.
  const out = runBootstrap({
    preBody: `
command() {
  if [ "$1" = "-v" ] && [ "$2" = "node" ]; then
    return 1
  fi
  builtin command "$@"
}
detect_distro_id() { echo "ubuntu"; }
install_node_via_apt() {
  echo "MOCK_APT_FAIL"
  return 1
}
`,
  });
  assert.match(out, /MOCK_APT_FAIL/);
  assert.match(out, /Node\.js install via apt failed/);
  assert.match(out, /Install manually: https:\/\/nodejs\.org/);
});

test("bootstrap_node dies with a manual-install hint for unknown distros", () => {
  // distro='arch' isn't in our case statement — the user gets the same
  // "install manually" hint as the require_cmd failures (BET-162 F1 tone).
  const out = runBootstrap({
    preBody: `
command() {
  if [ "$1" = "-v" ] && [ "$2" = "node" ]; then
    return 1
  fi
  builtin command "$@"
}
detect_distro_id() { echo "arch"; }
`,
  });
  assert.match(out, /not auto-bootstrapped/);
  assert.match(out, /https:\/\/nodejs\.org/, "manual-install hint points at nodejs.org");
});

test("bootstrap_node dies with a manual-install hint when /etc/os-release is unreadable", () => {
  const out = runBootstrap({
    preBody: `
command() {
  if [ "$1" = "-v" ] && [ "$2" = "node" ]; then
    return 1
  fi
  builtin command "$@"
}
detect_distro_id() { echo ""; }
`,
  });
  assert.match(out, /\/etc\/os-release is unreadable/);
  assert.match(out, /https:\/\/nodejs\.org/, "manual-install hint points at nodejs.org");
});

test("bootstrap_node dies when node + curl are missing together", () => {
  // The bootstrap path itself depends on curl + tar to fetch the NodeSource
  // setup script. If those are gone too, we must NOT try to apt-install
  // curl — that would silently sudo over a hostile environment. The hint
  // is "install everything manually and re-run" — same tone as require_cmd.
  const out = runBootstrap({
    preBody: `
command() {
  # Pretend node, curl, AND tar are all missing.
  case " $2 " in
    " node "|" curl "|" tar ") return 1 ;;
  esac
  builtin command "$@"
}
# If we DID call the apt installer, this would catch the bug.
install_node_via_apt() {
  echo "MOCK_APT_CALLED" >&2
  return 0
}
`,
  });
  assert.doesNotMatch(out, /MOCK_APT_CALLED/);
  assert.match(out, /node is missing and so are:/);
  assert.match(out, /curl/);
  assert.match(out, /tar/);
});
