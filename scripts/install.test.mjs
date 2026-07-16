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
  stripJsoncLineComments,
  mergeOpencodeConfig,
  renderSystemdUnit,
  OPENCODE_CLAUDE_AUTH_PLUGIN,
  DEFAULT_PORT,
  DEFAULT_RELEASE_HOST,
} from "./install-lib.mjs";

const HOME = "/home/tester";

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
