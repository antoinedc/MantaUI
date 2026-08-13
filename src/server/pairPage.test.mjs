// Tests for pairPage.mjs pure logic — no live HTTP, no real QR PNG.
// Run via `npm run test:server` (node:test).
//
// Mirror style of src/server/servePage.test.mjs: pure-logic only, asserting
// shape and validation; the actual rendering + serving happens in index.mjs
// (covered by the curl smoke checks at the end of BET-239).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEX32_RE,
  CODE_RE,
  validatePairQrQuery,
  resolveBoxChannel,
  renderPairQr,
  readPairAsset,
} from "./pairPage.mjs";
import { CHANNELS, CHANNEL_IDS } from "../shared/channel.mjs";

const HEX32 = "0123456789abcdef0123456789abcdef";

// Same per-channel iteration pattern as pairPayload.test.ts: drive the
// per-scheme tests off the channel table so adding a fourth channel
// automatically extends coverage (and a future PR that drops a scheme
// from CHANNELS has to update the test alongside it).
const SCHEMES = CHANNEL_IDS.map((id) => CHANNELS[id].urlScheme);

// ---------------------------------------------------------------------------
// HEX32_RE / CODE_RE
// ---------------------------------------------------------------------------

test("HEX32_RE accepts 32 lowercase hex only", () => {
  assert.equal(HEX32_RE.test(HEX32), true);
  assert.equal(HEX32_RE.test("a".repeat(32)), true);
  assert.equal(HEX32_RE.test("A".repeat(32)), false); // uppercase rejected
  assert.equal(HEX32_RE.test("a".repeat(31)), false);
  assert.equal(HEX32_RE.test("a".repeat(33)), false);
});

test("CODE_RE accepts exactly 6 digits", () => {
  assert.equal(CODE_RE.test("000000"), true);
  assert.equal(CODE_RE.test("847291"), true);
  assert.equal(CODE_RE.test("12345"), false);
  assert.equal(CODE_RE.test("1234567"), false);
  assert.equal(CODE_RE.test("abcdef"), false);
});

// ---------------------------------------------------------------------------
// resolveBoxChannel — the env → channel table lookup
// ---------------------------------------------------------------------------

test("resolveBoxChannel falls back to the prod channel when MANTA_CHANNEL is unset", () => {
  const prev = process.env.MANTA_CHANNEL;
  delete process.env.MANTA_CHANNEL;
  try {
    assert.equal(resolveBoxChannel(), CHANNELS.prod);
  } finally {
    if (prev !== undefined) process.env.MANTA_CHANNEL = prev;
  }
});

test("resolveBoxChannel honors MANTA_CHANNEL=staging → CHANNELS.staging", () => {
  const prev = process.env.MANTA_CHANNEL;
  process.env.MANTA_CHANNEL = "staging";
  try {
    assert.equal(resolveBoxChannel(), CHANNELS.staging);
  } finally {
    if (prev !== undefined) process.env.MANTA_CHANNEL = prev;
    else delete process.env.MANTA_CHANNEL;
  }
});

test("resolveBoxChannel honors MANTA_CHANNEL=dev → CHANNELS.dev", () => {
  const prev = process.env.MANTA_CHANNEL;
  process.env.MANTA_CHANNEL = "dev";
  try {
    assert.equal(resolveBoxChannel(), CHANNELS.dev);
  } finally {
    if (prev !== undefined) process.env.MANTA_CHANNEL = prev;
    else delete process.env.MANTA_CHANNEL;
  }
});

test("resolveBoxChannel falls back to prod for an unrecognised MANTA_CHANNEL value (never throws)", () => {
  // Same defensive rule as resolveChannel in shared/channel.mjs — a bad
  // box deploy must still mint a working QR, not throw at request time.
  // The pair page is auth-exempt and on the critical pairing path; a
  // crash there would brick the install.
  const prev = process.env.MANTA_CHANNEL;
  process.env.MANTA_CHANNEL = "garbage";
  try {
    assert.equal(resolveBoxChannel(), CHANNELS.prod);
  } finally {
    if (prev !== undefined) process.env.MANTA_CHANNEL = prev;
    else delete process.env.MANTA_CHANNEL;
  }
});

// ---------------------------------------------------------------------------
// validatePairQrQuery
// ---------------------------------------------------------------------------

test("validatePairQrQuery returns ok + the canonical payload for valid input", () => {
  const r = validatePairQrQuery({ box: HEX32, code: "847291" });
  assert.equal(r.ok, true);
  assert.equal(r.payload, `manta://pair?box=${HEX32}&code=847291`);
});

test("validatePairQrQuery lowercases the box before validating", () => {
  // Hostnames arrive case-insensitive — uppercase hex MUST be accepted.
  const r = validatePairQrQuery({
    box: "0123456789ABCDEF0123456789ABCDEF",
    code: "847291",
  });
  assert.equal(r.ok, true);
  assert.equal(r.payload, `manta://pair?box=${HEX32}&code=847291`);
});

test("validatePairQrQuery trims surrounding whitespace", () => {
  const r = validatePairQrQuery({ box: `  ${HEX32}  `, code: " 847291 " });
  assert.equal(r.ok, true);
  assert.equal(r.payload, `manta://pair?box=${HEX32}&code=847291`);
});

test("validatePairQrQuery rejects a 31-hex box", () => {
  const r = validatePairQrQuery({ box: HEX32.slice(0, 31), code: "847291" });
  assert.equal(r.ok, false);
  assert.match(r.error, /32-char lowercase hex/);
});

test("validatePairQrQuery rejects a non-hex box", () => {
  const r = validatePairQrQuery({ box: "not-hex-not-hex-not-hex-not-he", code: "847291" });
  assert.equal(r.ok, false);
  assert.match(r.error, /32-char lowercase hex/);
});

test("validatePairQrQuery rejects a 5-digit code", () => {
  const r = validatePairQrQuery({ box: HEX32, code: "12345" });
  assert.equal(r.ok, false);
  assert.match(r.error, /exactly 6 digits/);
});

test("validatePairQrQuery rejects a 7-digit code", () => {
  const r = validatePairQrQuery({ box: HEX32, code: "1234567" });
  assert.equal(r.ok, false);
  assert.match(r.error, /exactly 6 digits/);
});

test("validatePairQrQuery rejects a non-numeric code", () => {
  const r = validatePairQrQuery({ box: HEX32, code: "abcdef" });
  assert.equal(r.ok, false);
  assert.match(r.error, /exactly 6 digits/);
});

test("validatePairQrQuery rejects missing fields", () => {
  assert.equal(validatePairQrQuery({ code: "847291" }).ok, false);
  assert.equal(validatePairQrQuery({ box: HEX32 }).ok, false);
  assert.equal(validatePairQrQuery({}).ok, false);
  assert.equal(validatePairQrQuery(null).ok, false);
});

test("validatePairQrQuery rejects non-string fields", () => {
  assert.equal(validatePairQrQuery({ box: 123, code: "847291" }).ok, false);
  assert.equal(validatePairQrQuery({ box: HEX32, code: 847291 }).ok, false);
});

// ---------------------------------------------------------------------------
// validatePairQrQuery — server= param (BET-336, Tailscale pair link)
// ---------------------------------------------------------------------------

test("validatePairQrQuery without a server param returns the unchanged payload (BET-336, public path)", () => {
  // Pre-BET-336 wire shape — must stay unchanged so existing QR consumers
  // keep working.
  const r = validatePairQrQuery({ box: HEX32, code: "847291" });
  assert.equal(r.ok, true);
  assert.equal(r.payload, `manta://pair?box=${HEX32}&code=847291`);
  assert.equal(r.payload.includes("server="), false);
});

test("validatePairQrQuery appends &server=<encoded> for a private URL (BET-336, tailscale path)", () => {
  const r = validatePairQrQuery({
    box: HEX32,
    code: "847291",
    server: "http://100.64.1.5:8787",
  });
  assert.equal(r.ok, true);
  assert.equal(
    r.payload,
    `manta://pair?box=${HEX32}&code=847291&server=${encodeURIComponent("http://100.64.1.5:8787")}`,
  );
});

test("validatePairQrQuery accepts .ts.net and 192.168.x servers (BET-336, accepted families)", () => {
  const r1 = validatePairQrQuery({
    box: HEX32,
    code: "847291",
    server: "https://mybox.ts.net",
  });
  assert.equal(r1.ok, true);
  assert.equal(
    r1.payload,
    `manta://pair?box=${HEX32}&code=847291&server=${encodeURIComponent("https://mybox.ts.net")}`,
  );
  const r2 = validatePairQrQuery({
    box: HEX32,
    code: "847291",
    server: "http://192.168.1.10:8787",
  });
  assert.equal(r2.ok, true);
});

test("validatePairQrQuery rejects a PUBLIC server URL (BET-336, crafted-link guard)", () => {
  // The whole payload must be refused — NOT silently dropped and emitted
  // without &server= (that fallback would make the link resolve to a
  // public host, which is exactly the attack vector the gate prevents).
  const r = validatePairQrQuery({
    box: HEX32,
    code: "847291",
    server: "https://attacker.example.com",
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /private\/tailnet/);
});

// ---------------------------------------------------------------------------
// validatePairQrQuery — channel-aware scheme (BET-373)
//
// The renderer + desktop pair-link path now keys off the channel table
// (src/shared/channel.mjs). These tests pin every channel's emitted
// payload and the env-driven default that ties the box to its own scheme.
// ---------------------------------------------------------------------------

test("validatePairQrQuery honors an explicit scheme arg for every channel (BET-373)", () => {
  for (const scheme of SCHEMES) {
    const r = validatePairQrQuery({ box: HEX32, code: "847291" }, scheme);
    assert.equal(r.ok, true, `scheme=${scheme} should accept valid input`);
    assert.equal(
      r.payload,
      `${scheme}://pair?box=${HEX32}&code=847291`,
      `scheme=${scheme} should emit <scheme>://pair?…`,
    );
  }
});

test("validatePairQrQuery honors an explicit scheme arg with &server= appended (BET-336 + BET-373)", () => {
  // BET-336 + BET-373 together: a channel-aware scheme plus a Tailscale
  // server URL. Pin both ends so a future PR that drops the scheme arg
  // can't quietly regress.
  for (const scheme of SCHEMES) {
    const r = validatePairQrQuery(
      { box: HEX32, code: "847291", server: "http://100.64.1.5:8787" },
      scheme,
    );
    assert.equal(r.ok, true, `scheme=${scheme} should accept valid input`);
    assert.equal(
      r.payload,
      `${scheme}://pair?box=${HEX32}&code=847291&server=${encodeURIComponent("http://100.64.1.5:8787")}`,
      `scheme=${scheme} should emit <scheme>://pair?…&server=<encoded>`,
    );
  }
});

test("validatePairQrQuery defaults to the box's MANTA_CHANNEL scheme when no scheme arg is passed (BET-373)", () => {
  // Drive every channel through env + delete so the env-driven default
  // is pinned for ALL three channels. Pin the expected payload prefix to
  // the env-driven channel so a future PR that loses the channel lookup
  // (and silently falls back to manta://) fails this test for the
  // staging + dev channels.
  const prev = process.env.MANTA_CHANNEL;
  try {
    for (const id of CHANNEL_IDS) {
      process.env.MANTA_CHANNEL = id;
      const r = validatePairQrQuery({ box: HEX32, code: "847291" });
      assert.equal(r.ok, true, `channel=${id} should accept valid input`);
      assert.equal(
        r.payload,
        `${CHANNELS[id].urlScheme}://pair?box=${HEX32}&code=847291`,
        `channel=${id} (env) should default to ${CHANNELS[id].urlScheme}://`,
      );
    }
  } finally {
    if (prev !== undefined) process.env.MANTA_CHANNEL = prev;
    else delete process.env.MANTA_CHANNEL;
  }
});

test("validatePairQrQuery defaults to manta:// when MANTA_CHANNEL is unset (BET-373 back-compat)", () => {
  // The "no channel configured" path must still mint a valid
  // `manta://pair?…` QR — pre-BET-373 boxes (which have no MANTA_CHANNEL
  // env at all) keep working without any installer change. Pin the
  // behavior so a future PR that re-routes an unset channel to dev
  // (or anywhere else) breaks loudly here.
  const prev = process.env.MANTA_CHANNEL;
  delete process.env.MANTA_CHANNEL;
  try {
    const r = validatePairQrQuery({ box: HEX32, code: "847291" });
    assert.equal(r.ok, true);
    assert.equal(r.payload, `manta://pair?box=${HEX32}&code=847291`);
  } finally {
    if (prev !== undefined) process.env.MANTA_CHANNEL = prev;
  }
});

test("validatePairQrQuery defaults to manta:// when MANTA_CHANNEL is unrecognised (BET-373 defensive fallback)", () => {
  // Same defensive rule as resolveChannel — a mis-configured box must
  // still mint a working QR. The pair page is auth-exempt and on the
  // critical pairing path; a crash there would brick the install.
  const prev = process.env.MANTA_CHANNEL;
  process.env.MANTA_CHANNEL = "garbage";
  try {
    const r = validatePairQrQuery({ box: HEX32, code: "847291" });
    assert.equal(r.ok, true);
    assert.equal(r.payload, `manta://pair?box=${HEX32}&code=847291`);
  } finally {
    if (prev !== undefined) process.env.MANTA_CHANNEL = prev;
    else delete process.env.MANTA_CHANNEL;
  }
});

test("validatePairQrQuery: explicit scheme arg beats MANTA_CHANNEL env (BET-373 caller override)", () => {
  // Pin the precedence: an explicit `scheme` arg from the caller wins
  // over the env-driven default. Tests use this to drive each scheme
  // without mutating the env; production callers (index.mjs) DON'T
  // override and therefore pick up the env-driven channel.
  const prev = process.env.MANTA_CHANNEL;
  process.env.MANTA_CHANNEL = "staging";
  try {
    const r = validatePairQrQuery(
      { box: HEX32, code: "847291" },
      "manta-dev",
    );
    assert.equal(r.ok, true);
    assert.equal(
      r.payload,
      `manta-dev://pair?box=${HEX32}&code=847291`,
      "explicit scheme must override env-derived default",
    );
  } finally {
    if (prev !== undefined) process.env.MANTA_CHANNEL = prev;
    else delete process.env.MANTA_CHANNEL;
  }
});

// ---------------------------------------------------------------------------
// renderPairQr — produces a valid PNG buffer
// ---------------------------------------------------------------------------

test("renderPairQr returns a Buffer with the PNG magic header", async () => {
  const png = await renderPairQr(`manta://pair?box=${HEX32}&code=847291`);
  assert.ok(Buffer.isBuffer(png), "renderPairQr must return a Buffer");
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A (8 bytes)
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(
    png.subarray(0, 8).equals(expected),
    "first 8 bytes must match the PNG magic signature",
  );
  // Sanity: a 360×360 QR with margin:1 is comfortably above the minimum PNG
  // size (the PNG signature + IHDR + at least one IDAT chunk). We just guard
  // against an empty buffer, not the exact pixel count.
  assert.ok(png.length > 100, "PNG buffer should be non-trivial");
});

// ---------------------------------------------------------------------------
// readPairAsset — pair.html / pair-logo.png exist next to this module
// ---------------------------------------------------------------------------

test("readPairAsset returns pair.html bytes from disk", () => {
  const buf = readPairAsset("pair.html");
  assert.ok(Buffer.isBuffer(buf));
  const head = buf.subarray(0, 64).toString("utf-8");
  assert.match(head, /^<!DOCTYPE html>/i);
  // "MantaUI" appears in the <title> later in the file — sample beyond the head.
  const tail = buf.subarray(0, Math.min(buf.length, 4096)).toString("utf-8");
  assert.match(tail, /MantaUI/);
});

test("readPairAsset returns pair-logo.png bytes (PNG magic)", () => {
  const buf = readPairAsset("pair-logo.png");
  assert.ok(Buffer.isBuffer(buf));
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(expected));
  assert.ok(buf.length > 100, "logo PNG should be non-trivial");
});

// ---------------------------------------------------------------------------
// BET-489 — manual six-digit entry on the /pair page
//
// These tests assert DIRECTLY on the shipped `pair.html` (the exact file the
// server serves verbatim via readPairAsset), not on extracted/module helpers.
// The page's dynamic logic (fragment parse, /auth/claim POST, resolved-box
// render) lives in its inline <script> — so we certify the shipped artifact.
// ---------------------------------------------------------------------------

// The manual-entry mailbox: the shipped page hands the code from the URL
// FRAGMENT to the EXISTING /auth/claim endpoint as a {code} POST body —
// manual entry sends only the six digits, the server resolves the box (§5.2.9).
// The /auth/claim server half (code → resolved box) is already covered by
// auth.test.mjs; this pins that the page wires to that same endpoint.
test("manual-entry mailbox: shipped page checks the fragment code against /auth/check (BET-699)", () => {
  const html = readPairAsset("pair.html").toString("utf-8");
  // The check endpoint is built by claimEndpointFor — it must resolve to the
  // NON-consuming /auth/check path, never /auth/claim (which would burn the
  // one-time code and leak the box token to the browser).
  const endpoint = html.match(/function claimEndpointFor\(origin\)\{([\s\S]*?)\n\}/);
  assert.ok(endpoint, "the page must define claimEndpointFor(origin)");
  assert.match(endpoint[1], /\/auth\/check/, "the endpoint must be /auth/check");
  assert.match(endpoint[1], /"\/auth\/check";/, "endpoint is exactly <origin>/auth/check");
  assert.doesNotMatch(endpoint[1], /"\/auth\/check\?/, "no query appended after /auth/check");
  assert.doesNotMatch(endpoint[1], /[?&]code\s*=/i, "no code in a query string");
  assert.doesNotMatch(endpoint[1], /\/auth\/claim/, "must NOT reuse the consuming /auth/claim");
  // doCheck POSTs only {code} to that endpoint — the code travels in the body.
  const doCheck = html.match(/function doCheck\(code\)\{([\s\S]*?)\n\}/);
  assert.ok(doCheck, "the page must define doCheck(code)");
  assert.match(doCheck[1], /fetch\(claimEndpointFor\(origin\)/, "checks via the built endpoint");
  assert.match(doCheck[1], /method:\s*"POST"/, "must be a POST");
  assert.match(doCheck[1], /JSON\.stringify\(\{\s*code:\s*code\s*\}\)/, "body carries {code}");
  assert.doesNotMatch(doCheck[1], /box\s*:/, "manual entry sends no box id");
});

// Fragment-only: the code must never be placed in a path/query the server
// could log. The code is sourced only from `location.hash` and sent as a POST
// body, never reconstructed into a URL the proxy records.
test("the page never puts the code in a path/query the server could log (fragment only) (BET-489)", () => {
  const html = readPairAsset("pair.html").toString("utf-8");
  // The code is sourced only from the URL fragment.
  assert.match(html, /location\.hash/, "code must be read from the fragment");
  // No path/query construction that would surface the code to a proxy log.
  assert.doesNotMatch(html, /"\/auth\/check\?"/, "no code-carrying check URL query");
  assert.doesNotMatch(html, /&code=|&box=/, "no query-string code/box usage");
});

// The resolved-box card is fed by a successful check (the server returns
// box_id on success). The page must key the "Box found" card off that
// resolved response — not off any client-side assumption — and the check must
// NEVER hand back a box_token (validation only; the code stays claimable).
test("resolved-box card is fed by a successful /auth/check that resolved the box (BET-699)", () => {
  const html = readPairAsset("pair.html").toString("utf-8");
  const present = html.match(/function presentCheckResult\(res, body\)\{([\s\S]*?)\n\}/);
  assert.ok(present, "presentCheckResult must exist");
  assert.match(present[1], /res\s*&&\s*res\.ok/, "only a successful response shows the card");
  assert.match(present[1], /body\s*\.\s*box_id/, "keys off the server-resolved box_id");
  assert.doesNotMatch(present[1], /box_token/, "check must never reference a box_token");
  assert.match(html, /Box found/, "the resolved-box card heading");
  assert.match(html, /the code stays valid/, "confirms the code is still claimable");
});

// Failure-state copy renders per §5.4 — the {cause, action} pairs. The page
// cannot distinguish a typo from an expired code, so both land on the same
// "That code didn't work" view (BET-699).
test("pair.html renders the §5.4 failure-state copy verbatim (BET-489)", () => {
  const html = readPairAsset("pair.html").toString("utf-8");
  // Validation rejection (wrong/expired/malformed/rate-limited)
  assert.match(html, /That code didn't work/);
  assert.match(html, /It may have expired or been mistyped/);
  assert.match(html, /Nothing was linked and nothing changed/);
  assert.match(html, /Get a fresh code/);
  assert.match(html, /manta pair/);
  assert.match(html, /Scan again/);
  assert.match(html, /Enter a code instead/);
  // Unreachable
  assert.match(html, /Can't reach your box/);
  assert.match(html, /Nothing was linked\./);
  assert.match(html, /It may be asleep/);
  assert.match(html, /Check it's powered on and the server is running/);
  assert.match(html, /Or this network blocks it/);
  assert.match(html, /Try cellular instead of Wi-Fi/);
  assert.match(html, /Try again/);
  assert.match(html, /Copy diagnostics/);
  // Manual + not-installed fallback
  assert.match(html, /Enter the code/);
  assert.match(html, /Read the six digits off your desktop/);
  assert.match(html, /Get the app to finish/);
  assert.match(html, /Prefer to type it\?/);
  assert.match(html, /Get Manta/);
});

// No box_token or secret embedded anywhere in the served page.
test("pair.html embeds no box_token or secret (BET-489)", () => {
  const html = readPairAsset("pair.html").toString("utf-8");
  assert.ok(!/box_token/i.test(html), "must not embed the bearer token key");
  assert.ok(!/Authorization/i.test(html), "must not embed the auth header");
  assert.ok(!/\bbearer\b/i.test(html), "must not embed the bearer scheme");
  assert.ok(!/secret/i.test(html), "must not embed any secret string");
  // No 32-hex literal (a box_token / box_id shape) in the static page.
  assert.ok(!/[0-9a-f]{32}/i.test(html), "must not embed a 32-hex token literal");
});
