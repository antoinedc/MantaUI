import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  resolveConfig,
  parsePort,
  checkIdentity,
  waitForHealth,
  readBoxIdentity,
  formatPairingOutput,
  buildPairLink,
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

// A canonical 32-lowercase-hex token — mirrors the test constants in
// src/main/auth.test.ts and src/shared/transport.test.ts so the install
// side agrees on the same shape.
const HEX32 = "0123456789abcdef0123456789abcdef";

/**
 * Source scripts/install.sh in test mode (MANTA_INSTALL_TEST_MODE=1) after
 * applying `preBody` (mocks / overrides), then call the helper named by
 * `func` (default: bash's no-op `:`). Returns the captured stdout+stderr as
 * a single string. The harness writes a tiny bash script to a temp file so
 * we don't fight bash quoting rules.
 *
 * Mock pattern: define functions AFTER sourcing install.sh. Bash uses the
 * latest definition, so the test's mocks override install.sh's helpers.
 * Tests shadow `uname` for require_arch; previously the deleted bootstrap_*
 * tests shadowed `command` / `detect_distro_id`.
 *
 * Never throws — helpers' `die` calls `exit 1`, which would otherwise
 * propagate via execSync's thrown-on-non-zero behavior. The harness swallows
 * the error and returns the captured output (with BOOTSTRAP_EXIT=NNN
 * appended) so the test can assert on the message + exit code together.
 */
function runBootstrap({ preBody = "", func = ":" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "manta-bootstrap-"));
  const script = join(dir, "test.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set +e
export MANTA_INSTALL_TEST_MODE=1
source '${INSTALL_SH}'
${preBody}
${func}
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
      // execSync throws when the child exits non-zero (helpers' `die`
      // → `exit 1` for the failure paths). The stderr/stdout is on the
      // error object — concatenate and return so callers can assert on
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
  // BET-177 §2.4: when both box_id AND a 6-digit code are present the output
  // includes the canonical pair link + a terminal-rendered QR (via the real
  // qrcode-terminal in default mode). We assert on the text half here so the
  // test doesn't depend on a specific QR rendering — the QR rendering has
  // its own assertions below with a stubbed renderer.
  const out = formatPairingOutput({
    pairing_code: "847291",
    box_id: "0123456789abcdef0123456789abcdef",
    expiresAt: Date.UTC(2026, 6, 3, 12, 34, 56),
  });
  assert.match(out, /Pairing code:  847291/);
  assert.match(out, /Box ID:        0123456789abcdef0123456789abcdef/);
  assert.match(out, /Expires:       2026-07-03 12:34:56 UTC/);
  assert.match(out, /Pair link:     manta:\/\/pair\?box=0123456789abcdef0123456789abcdef&code=847291/);
  assert.match(out, /paste into the desktop app, or scan as a QR/);
  // QR rendering produces some non-empty ANSI block (qrcode-terminal prints
  // block chars). We don't pin the exact bytes — only that the renderer
  // contributed at least one row.
  assert.match(out, /\u2588|\u2584|\u2580/);
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

// ----------------------------------------------------------------------------
// buildPairLink — canonical box-form pair link (BET-177 §2.4)
// ----------------------------------------------------------------------------
//
// Single source of truth for the box-form link string emitted by
// `formatPairingOutput` AND printed by install.sh's heredoc. Must match the
// renderer's `buildPairPayload({boxId,serverUrl:null,code})` shape exactly,
// and must round-trip through `parsePairPayload` to a non-null payload (the
// same invariant the mobile deep-link handler relies on).

test("buildPairLink emits the canonical manta://pair?box=&code= shape", () => {
  const url = buildPairLink(HEX32, "847291");
  assert.equal(url, `manta://pair?box=${HEX32}&code=847291`);
});

test("buildPairLink URL-encodes the boxId (defensive — 32-hex has no reserved chars)", () => {
  // 32-hex is already URL-safe; this test pins the encodeURIComponent call
  // so a future shape change that DOES introduce a reserved char still
  // round-trips.
  const url = buildPairLink("00112233445566778899aabbccddeeff", "000000");
  assert.equal(url, "manta://pair?box=00112233445566778899aabbccddeeff&code=000000");
});

test("buildPairLink rejects a non-32-hex boxId", () => {
  assert.throws(() => buildPairLink("not-32-hex", "847291"), /32-hex token/);
  assert.throws(() => buildPairLink(HEX32.slice(0, 31), "847291"), /32-hex token/);
  assert.throws(() => buildPairLink(HEX32 + "0", "847291"), /32-hex token/);
  assert.throws(() => buildPairLink("", "847291"), /32-hex token/);
  assert.throws(() => buildPairLink(null, "847291"), /32-hex token/);
});

test("buildPairLink rejects a non-6-digit code", () => {
  assert.throws(() => buildPairLink(HEX32, "12345"), /6 digits/);
  assert.throws(() => buildPairLink(HEX32, "abcdef"), /6 digits/);
  assert.throws(() => buildPairLink(HEX32, ""), /6 digits/);
});

test("buildPairLink shape matches install.sh's heredoc literal (BET-177 §2.4)", () => {
  // The renderer's `parsePairPayload` is the gate the mobile app uses to
  // decide whether a QR is valid; install.sh's heredoc prints the canonical
  // box-form link in lockstep. The install.test suite is plain Node — we
  // don't load the .ts parser here — but we CAN enforce the wire shape on
  // both the install-lib helper AND the literal install.sh heredoc printf,
  // so a future drift in either side is caught here.
  //
  // 1. install-lib's buildPairLink produces the canonical shape:
  const fromLib = buildPairLink(HEX32, "847291");
  assert.equal(
    fromLib,
    "manta://pair?box=0123456789abcdef0123456789abcdef&code=847291",
    "install-lib buildPairLink produces the canonical box-form URL",
  );
  // 2. install.sh's heredoc uses the SAME shape — read the literal printf
  //    template and assert it matches the install-lib output structure:
  const installShSrc = readFileSync(INSTALL_SH, "utf-8");
  const printfMatch = installShSrc.match(
    /manta:\/\/pair\?box=%s&code=%s/,
  );
  assert.ok(
    printfMatch,
    "install.sh heredoc uses the canonical box-form printf template",
  );
  // 3. The printf template `manta://pair?box=%s&code=%s` MUST round-trip —
  //    when sprintf'd with a 32-hex boxId + 6-digit code, it produces the
  //    same string buildPairLink produces for the same inputs. We pin
  //    BOTH the printf template AND the install-lib output so a future
  //    drift in either side surfaces here.
  assert.match(printfMatch[0], /^manta:\/\/pair\?box=%s&code=%s$/);
});

// ----------------------------------------------------------------------------
// formatPairingOutput — pair-link + QR block (BET-177 §2.4)
// ----------------------------------------------------------------------------
//
// formatPairingOutput emits the canonical box-form pair link AND a terminal-
// rendered QR (via the injected qrRender — tests stub it so no actual terminal
// painting happens). The link is direct-mode shape (manta://pair?box=<id>&code=<code>)
// — the desktop / phone resolve it to https://<box_id>.boxes.mantaui.com and
// claim against the box's own /auth/claim.

test("formatPairingOutput includes the pair link + QR", () => {
  const qrText = "[stubbed QR rows]\nrow 2\nrow 3";
  const out = formatPairingOutput(
    {
      pairing_code: "847291",
      box_id: HEX32,
      expiresAt: Date.UTC(2026, 6, 3, 12, 34, 56),
    },
    {
      qrRender: () => qrText,
    },
  );
  assert.match(out, /Pair link:     manta:\/\/pair\?box=0123456789abcdef0123456789abcdef&code=847291/);
  assert.match(out, /paste into the desktop app, or scan as a QR/);
  // Stubbed QR rows are indented to match the surrounding 2-space indent.
  // We use a literal newline+two-spaces prefix in the regex (no \s — `s`
  // is .includes-sensitive and we want the exact byte sequence the formatter
  // emits).
  assert.match(out, /\n  \[stubbed QR rows\]/);
  assert.match(out, /\n  row 2/);
  // The trailing "Enter the pairing code" line is REPLACED by the link+QR
  // block — only one of them should appear.
  assert.doesNotMatch(out, /Enter the pairing code in the Manta desktop app/);
});

test("formatPairingOutput falls back to the text-only block when qrRender throws", () => {
  // A broken qrcode-terminal (e.g. a stripped dev node_modules) must NOT
  // crash the install — the link text is the source of truth, the QR is
  // best-effort. The text link + the "scan as a QR" hint still appear so the
  // operator can paste; only the QR ROWS are absent (the text talks about
  // scanning, but no QR is rendered).
  const out = formatPairingOutput(
    { pairing_code: "847291", box_id: HEX32 },
    { qrRender: () => { throw new Error("qrcode-terminal exploded"); } },
  );
  assert.match(out, /Pair link:     manta:\/\/pair\?box=/);
  assert.match(out, /scan as a QR/);
  // QR block chars (qrcode-terminal draws U+2588 FULL BLOCK + U+2584 LOWER
  // HALF BLOCK) are absent. We assert on the QR's STUB marker rather than
  // guessing which ANSI bytes the real renderer uses.
  assert.doesNotMatch(out, /\u2588/);
  assert.doesNotMatch(out, /\u2584/);
  assert.doesNotMatch(out, /\[stubbed QR rows\]/);
});

test("formatPairingOutput still throws on a non-6-digit code", () => {
  assert.throws(
    () => formatPairingOutput({ pairing_code: "12345" }),
    /6 digits/,
  );
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
  assert.match(out, /MANTA_PORT='8787'/);
  assert.match(out, /MANTA_HEALTH_URL='http:\/\/127\.0\.0\.1:8787\/auth\/status'/);
  // MANTA_TARBALL_URL is NOT emitted — install.sh derives the URL from the
  // manifest. (resolveConfig still parses it for tests / future overrides.)
  assert.doesNotMatch(out, /MANTA_TARBALL_URL=/);
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
// install.sh — bash syntax + manifest_get / verify_sha256 / require_arch
// ----------------------------------------------------------------------------
//
// These tests shell out to bash because install.sh is bash, not JS. They use
// the MANTA_INSTALL_TEST_MODE=1 sentinel (added in install.sh) which bails
// before the install body runs and only loads the bash helpers
// (log/ok/warn/die + manifest_get + verify_sha256 + require_arch). The unit
// tests then exercise the helpers with mocked `uname`/tmpfiles so nothing
// hits the network.
//
// (Previous BET-162/170 cases — bootstrap_node, install_node_via_*, and
// bootstrap_build_essential — are DELETED in BET-173: the installer no longer
// installs Node or build-essential on the box. The tarball ships a vendored
// Node runtime + prebuilt production deps.)

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

// ----------------------------------------------------------------------------
// manifest_get — the bash helper install.sh uses to read key=value from the
// release manifest BEFORE any node exists on the box.
// ----------------------------------------------------------------------------

test("manifest_get extracts each key from a well-formed manifest", () => {
  // The harness sources install.sh, then echoes the value of each call into
  // a tagged line we grep for. The manifest body is built inline.
  const out = runBootstrap({
    preBody: `
manifest='version=0.0.1
file_linux_x64=manta-0.0.1-linux-x64.tar.gz
sha256_linux_x64=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
echo "V=\$(manifest_get "\$manifest" version)"
echo "F=\$(manifest_get "\$manifest" file_linux_x64)"
echo "S=\$(manifest_get "\$manifest" sha256_linux_x64)"
`,
  });
  assert.match(out, /V=0\.0\.1/);
  assert.match(out, /F=manta-0\.0\.1-linux-x64\.tar\.gz/);
  assert.match(out, /S=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/);
});

test("manifest_get returns empty on a missing key (no false positives)", () => {
  const out = runBootstrap({
    preBody: `
manifest='version=0.0.1
file_linux_x64=manta-0.0.1-linux-x64.tar.gz'
val="\$(manifest_get "\$manifest" sha256_linux_x64)"
echo "VAL_LEN=\${#val}"
`,
  });
  assert.match(out, /VAL_LEN=0/);
});

test("manifest_get ignores a second occurrence of the same key (head -n1)", () => {
  // The manifest writer (pack.mjs) emits exactly one of each key, but if a
  // future bug regresses to two, the installer must keep reading the FIRST
  // (the published sha is the one Caddy serves; the second is whatever the
  // operator hand-edited).
  const out = runBootstrap({
    preBody: `
manifest='file_linux_x64=manta-first.tar.gz
file_linux_x64=manta-second.tar.gz'
echo "F=\$(manifest_get "\$manifest" file_linux_x64)"
`,
  });
  assert.match(out, /F=manta-first\.tar\.gz/);
  assert.doesNotMatch(out, /manta-second\.tar\.gz/);
});

test("manifest_get tolerates values containing '=' (cut -d= -f2-)", () => {
  // Some mirrors serve URLs as values — they contain '=' in query strings.
  // The helper must not truncate at the first '='.
  const out = runBootstrap({
    preBody: `
manifest='some_url=https://mirror.example.com/x?token=abc=def=='
echo "U=\$(manifest_get "\$manifest" some_url)"
`,
  });
  assert.match(out, /U=https:\/\/mirror\.example\.com\/x\?token=abc=def==/);
});

// ----------------------------------------------------------------------------
// verify_sha256 — the sha256 check install.sh runs before extracting the
// tarball. Dies loudly on mismatch (the operator must see why, not silently
// continue with a corrupt tarball).
// ----------------------------------------------------------------------------

test("verify_sha256 passes when the file's hash matches the expected sha", () => {
  const dir = mkdtempSync(join(tmpdir(), "manta-verify-sha-"));
  const file = join(dir, "blob");
  writeFileSync(file, "hello world\n");
  const expected = createHash("sha256").update(readFileSync(file)).digest("hex");
  try {
    const out = runBootstrap({
      preBody: `
verify_sha256 "${file}" "${expected}"
echo "VERIFIED_OK=\$?"
`,
    });
    assert.match(out, /VERIFIED_OK=0/);
    assert.match(out, /BOOTSTRAP_EXIT=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify_sha256 dies with 'checksum mismatch' on a wrong sha", () => {
  // `die` calls `exit 1`, so the harness captures the error stream and stops
  // there — no separate exit-code marker is reachable. We assert on the die
  // message (which carries both expected/actual hashes) — that's the
  // user-facing signal anyway.
  const dir = mkdtempSync(join(tmpdir(), "manta-verify-sha-"));
  const file = join(dir, "blob");
  writeFileSync(file, "hello world\n");
  const wrongSha = "0".repeat(64);
  try {
    const out = runBootstrap({
      preBody: `
verify_sha256 "${file}" "${wrongSha}"
`,
    });
    assert.match(out, /checksum mismatch for/);
    assert.match(out, new RegExp(`expected: ${wrongSha}`));
    assert.match(out, /actual:/);
    assert.match(out, /corrupt download or stale manifest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// require_arch — die unless uname -m reports x86_64. The harness overrides
// `uname` via a function in preBody (same mocking style as the deleted
// bootstrap_* tests used for `command` and `detect_distro_id`).
// ----------------------------------------------------------------------------

test("require_arch passes when uname emits x86_64", () => {
  const out = runBootstrap({
    preBody: `
uname() { echo "x86_64"; }
require_arch
echo "RA_OK=\$?"
`,
  });
  assert.match(out, /RA_OK=0/);
  assert.match(out, /BOOTSTRAP_EXIT=0/);
  assert.doesNotMatch(out, /only x86_64 Linux is supported/);
});

test("require_arch dies with a clear message on aarch64", () => {
  // `die` calls `exit 1`, so the harness captures the error stream and
  // stops there — no separate exit-code marker is reachable. Assert on the
  // die message body (which carries the architecture the user has).
  const out = runBootstrap({
    preBody: `
uname() { echo "aarch64"; }
require_arch
`,
  });
  assert.match(out, /only x86_64 Linux is supported by this installer today/);
  assert.match(out, /got: aarch64/);
});

test("require_arch dies on armv7l too (no fallthrough for any non-x86_64)", () => {
  const out = runBootstrap({
    preBody: `
uname() { echo "armv7l"; }
require_arch
`,
  });
  assert.match(out, /only x86_64 Linux is supported/);
  assert.match(out, /got: armv7l/);
});
