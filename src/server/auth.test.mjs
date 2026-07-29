import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, readFile, stat, writeFile } from "node:fs/promises";
import {
  isValidToken,
  isValidPairingCode,
  tokenMatches,
  parseBearer,
  isExemptPath,
  isPublicAssetPath,
  loadAuth,
  saveAuth,
  deleteAuth,
  ensureAuth,
  createPairingRegistry,
  createAuthEngine,
  isLoopbackAddress,
  isLocalDirectRequest,
  queryTokenAllowedForPath,
  authorizationForRequest,
  QUERY_TOKEN_PATHS,
} from "./auth.mjs";

const HEX32 = "0123456789abcdef0123456789abcdef";
const HEX32B = "fedcba9876543210fedcba9876543210";

// ----------------------------------------------------------------------------
// isValidToken
// ----------------------------------------------------------------------------

test("isValidToken accepts 32 lowercase hex only", () => {
  assert.equal(isValidToken(HEX32), true);
  assert.equal(isValidToken("a".repeat(32)), true);
  assert.equal(isValidToken("A".repeat(32)), false); // uppercase
  assert.equal(isValidToken("a".repeat(31)), false); // short
  assert.equal(isValidToken("a".repeat(33)), false); // long
  assert.equal(isValidToken("../etc/passwd"), false);
  assert.equal(isValidToken(""), false);
  assert.equal(isValidToken(null), false);
  assert.equal(isValidToken(undefined), false);
});

// ----------------------------------------------------------------------------
// isValidPairingCode
// ----------------------------------------------------------------------------

test("isValidPairingCode accepts exactly 6 digits", () => {
  assert.equal(isValidPairingCode("000000"), true);
  assert.equal(isValidPairingCode("123456"), true);
  assert.equal(isValidPairingCode("12345"), false); // 5 digits
  assert.equal(isValidPairingCode("1234567"), false); // 7 digits
  assert.equal(isValidPairingCode(" 123456 "), false); // whitespace
  assert.equal(isValidPairingCode("12345a"), false); // non-digit
  assert.equal(isValidPairingCode(123456), false); // not a string
  assert.equal(isValidPairingCode(""), false);
});

// ----------------------------------------------------------------------------
// tokenMatches (constant-time)
// ----------------------------------------------------------------------------

test("tokenMatches only for exact equal valid tokens", () => {
  assert.equal(tokenMatches(HEX32, HEX32), true);
  assert.equal(tokenMatches(HEX32, HEX32B), false);
  assert.equal(tokenMatches(HEX32, "a".repeat(32)), false);
  assert.equal(tokenMatches(HEX32, "bad"), false); // invalid presented
  assert.equal(tokenMatches("bad", HEX32), false); // invalid expected
  assert.equal(tokenMatches(null, HEX32), false);
});

// ----------------------------------------------------------------------------
// parseBearer
// ----------------------------------------------------------------------------

test("parseBearer extracts token from Authorization header", () => {
  assert.equal(parseBearer(`Bearer ${HEX32}`), HEX32);
  assert.equal(parseBearer(`bearer ${HEX32}`), HEX32); // case-insensitive scheme
  assert.equal(parseBearer(`  Bearer   ${HEX32}  `), HEX32); // extra spaces
  assert.equal(parseBearer(HEX32), HEX32); // bare token accepted
  assert.equal(parseBearer(""), null);
  assert.equal(parseBearer(null), null);
  assert.equal(parseBearer(42), null);
});

// ----------------------------------------------------------------------------
// isExemptPath
// ----------------------------------------------------------------------------

test("isExemptPath exempts only /auth pairing + /pair onboarding + /hook delivery + /pages hosting", () => {
  assert.equal(isExemptPath("/auth/pair"), true);
  assert.equal(isExemptPath("/auth/claim"), true);
  assert.equal(isExemptPath("/pair"), true);
  assert.equal(isExemptPath("/pair/qr.png"), true);
  assert.equal(isExemptPath("/pair/logo.png"), true);
  assert.equal(isExemptPath("/hook/deadbeef"), true);
  assert.equal(isExemptPath("/hook/"), true);
  // /pages/<sub> — hosted page (AI `serve_page` tool). Sandbox CSP keeps the
  // document in an opaque origin so it can't reach the box_token. Visitor
  // holds no token by definition.
  assert.equal(isExemptPath("/pages/foo"), true);
  assert.equal(isExemptPath("/pages/"), true);
  assert.equal(isExemptPath("/pages/my-design"), true);
  // NOT exempt — these must be gated
  assert.equal(isExemptPath("/auth/status"), false);
  assert.equal(isExemptPath("/api/projects"), false);
  assert.equal(isExemptPath("/api/serve-page"), false); // management API is gated
  assert.equal(isExemptPath("/rpc/tmux"), false);
  assert.equal(isExemptPath("/events"), false);
  assert.equal(isExemptPath("/pair/other"), false); // narrow exemption: only the 3 exact paths
  assert.equal(isExemptPath("/pairx"), false);      // prefix attack guard
  assert.equal(isExemptPath("/pagesx"), false);     // prefix attack guard
  assert.equal(isExemptPath("/"), false);
  assert.equal(isExemptPath(null), false);
});

// ----------------------------------------------------------------------------
// isPublicAssetPath
// ----------------------------------------------------------------------------

test("isPublicAssetPath allows the SPA shell + PWA assets", () => {
  assert.equal(isPublicAssetPath("/"), true);
  assert.equal(isPublicAssetPath("/index.html"), true);
  assert.equal(isPublicAssetPath("/sw.js"), true);
  assert.equal(isPublicAssetPath("/favicon.ico"), true);
  assert.equal(isPublicAssetPath("/manifest.webmanifest"), true);
  assert.equal(isPublicAssetPath("/assets/index-abc123.js"), true);
  assert.equal(isPublicAssetPath("/icons/icon-192.png"), true);
  // data/control routes are NOT public assets
  assert.equal(isPublicAssetPath("/api/projects"), false);
  assert.equal(isPublicAssetPath("/rpc/tmux"), false);
  assert.equal(isPublicAssetPath("/events"), false);
  assert.equal(isPublicAssetPath(null), false);
});

// ----------------------------------------------------------------------------
// query-param token fallback — /events + /pty (BET-51; /pty re-added in BET-158)
// ----------------------------------------------------------------------------

test("queryTokenAllowedForPath allows /events AND /pty", () => {
  assert.equal(queryTokenAllowedForPath("/events"), true);
  // BET-158: /pty is back (binary-safe terminal WS that the relay bridges).
  assert.equal(queryTokenAllowedForPath("/pty"), true);
  // every other route must present a real Bearer header
  assert.equal(queryTokenAllowedForPath("/api/projects"), false);
  assert.equal(queryTokenAllowedForPath("/rpc/tmux"), false);
  assert.equal(queryTokenAllowedForPath("/auth/status"), false);
  assert.equal(queryTokenAllowedForPath("/"), false);
  assert.equal(queryTokenAllowedForPath("/events/../api/projects"), false);
  // exactly the two paths, nothing more
  assert.deepEqual([...QUERY_TOKEN_PATHS].sort(), ["/events", "/pty"]);
});

test("authorizationForRequest: header always wins on any route", () => {
  // A real header is passed through verbatim regardless of path or query token.
  assert.equal(
    authorizationForRequest("/api/projects", `Bearer ${HEX32}`, "ignored"),
    `Bearer ${HEX32}`,
  );
  assert.equal(
    authorizationForRequest("/events", `Bearer ${HEX32}`, HEX32B),
    `Bearer ${HEX32}`,
  );
  assert.equal(
    authorizationForRequest("/pty", `Bearer ${HEX32}`, HEX32B),
    `Bearer ${HEX32}`,
  );
  // whitespace-only header is treated as absent → falls through to query rules
  assert.equal(authorizationForRequest("/events", "   ", HEX32), `Bearer ${HEX32}`);
  assert.equal(authorizationForRequest("/pty", "   ", HEX32), `Bearer ${HEX32}`);
});

test("authorizationForRequest: ?token= honored on /events AND /pty", () => {
  // stream paths: query token becomes a Bearer value
  assert.equal(authorizationForRequest("/events", "", HEX32), `Bearer ${HEX32}`);
  assert.equal(authorizationForRequest("/pty", "", HEX32), `Bearer ${HEX32}`);
  // any other route ignores ?token= entirely → empty (gate then 401s)
  assert.equal(authorizationForRequest("/api/projects", "", HEX32), "");
  assert.equal(authorizationForRequest("/rpc/tmux", null, HEX32), "");
  assert.equal(authorizationForRequest("/auth/status", "", HEX32), "");
});

test("authorizationForRequest: no header + no query token → empty", () => {
  assert.equal(authorizationForRequest("/events", "", ""), "");
  assert.equal(authorizationForRequest("/events", undefined, undefined), "");
  assert.equal(authorizationForRequest("/pty", null, null), "");
  assert.equal(authorizationForRequest("/api/projects", "", ""), "");
});

test("authorizationForRequest result feeds authorize() end-to-end", () => {
  const eng = createAuthEngine({ auth: AUTH });
  // valid ?token= on /events → authorized
  const okAuth = authorizationForRequest("/events", "", AUTH.box_token);
  assert.equal(eng.authorize({ method: "GET", path: "/events", authorization: okAuth }).ok, true);
  // valid ?token= on /pty → authorized (BET-158 — relay → box /pty WS path)
  const ptyAuth = authorizationForRequest("/pty", "", AUTH.box_token);
  assert.equal(eng.authorize({ method: "GET", path: "/pty", authorization: ptyAuth }).ok, true);
  // same token as ?token= on a NON-stream route → not applied → 401
  const blockedAuth = authorizationForRequest("/api/projects", "", AUTH.box_token);
  const blocked = eng.authorize({ method: "GET", path: "/api/projects", authorization: blockedAuth });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 401);
});

// ----------------------------------------------------------------------------
// store: loadAuth / saveAuth / ensureAuth
// ----------------------------------------------------------------------------

function tmpPath(name) {
  return join(tmpdir(), `manta-auth-test-${process.pid}-${Date.now()}-${name}.json`);
}

test("loadAuth returns null for a missing file", () => {
  assert.equal(loadAuth(tmpPath("missing")), null);
});

test("saveAuth writes 0600 and loadAuth round-trips", async () => {
  const path = tmpPath("roundtrip");
  const auth = { box_id: HEX32, box_token: HEX32B, created_at: 123 };
  try {
    await saveAuth(auth, path);
    const st = await stat(path);
    // 0600 → owner rw only
    assert.equal(st.mode & 0o777, 0o600);
    const loaded = loadAuth(path);
    assert.deepEqual(loaded, auth);
  } finally {
    await rm(path, { force: true });
  }
});

test("loadAuth returns null on corrupt / invalid content", async () => {
  const path = tmpPath("corrupt");
  try {
    await saveAuth({ box_id: "not-hex", box_token: HEX32B }, path);
    assert.equal(loadAuth(path), null);
    await saveAuth({ box_id: HEX32 }, path); // missing token
    assert.equal(loadAuth(path), null);
  } finally {
    await rm(path, { force: true });
  }
});

test("ensureAuth generates + persists a fresh identity on first run, then is stable", async () => {
  const path = tmpPath("ensure");
  const load = () => loadAuth(path);
  const save = (a) => saveAuth(a, path);
  try {
    const first = await ensureAuth({ load, save, now: () => 42 });
    assert.equal(isValidToken(first.box_id), true);
    assert.equal(isValidToken(first.box_token), true);
    assert.equal(first.created_at, 42);
    // second call returns the SAME persisted identity (no regeneration)
    const second = await ensureAuth({ load, save });
    assert.deepEqual(second, first);
    // file actually exists on disk
    const onDisk = JSON.parse(await readFile(path, "utf-8"));
    assert.equal(onDisk.box_id, first.box_id);
  } finally {
    await rm(path, { force: true });
  }
});

// ----------------------------------------------------------------------------
// pairing registry
// ----------------------------------------------------------------------------

test("pairing registry issues a 6-digit code and consumes it once", () => {
  const reg = createPairingRegistry();
  const { code } = reg.issue();
  assert.equal(isValidPairingCode(code), true);
  assert.equal(reg.hasActive(), true);
  assert.equal(reg.consume(code), true); // first consume ok
  assert.equal(reg.consume(code), false); // reuse rejected
  assert.equal(reg.hasActive(), false);
});

test("pairing registry rejects wrong / invalid codes", () => {
  const reg = createPairingRegistry();
  const { code } = reg.issue();
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal(reg.consume(wrong), false);
  assert.equal(reg.consume("bad"), false);
  assert.equal(reg.consume(null), false);
  // the real code still works — a wrong guess doesn't burn it
  assert.equal(reg.consume(code), true);
});

test("pairing registry expires codes after TTL", () => {
  let t = 1000;
  const reg = createPairingRegistry({ ttlMs: 500, now: () => t });
  const { code } = reg.issue();
  t = 1400; // within TTL
  assert.equal(reg.hasActive(), true);
  t = 1600; // past TTL
  assert.equal(reg.hasActive(), false);
  assert.equal(reg.consume(code), false);
});

test("issuing a new code supersedes the prior one", () => {
  const reg = createPairingRegistry();
  const first = reg.issue().code;
  const second = reg.issue().code;
  // first is invalidated even if it happened to differ
  if (first !== second) assert.equal(reg.consume(first), false);
  assert.equal(reg.consume(second), true);
});

// ----------------------------------------------------------------------------
// auth engine — authorize gate
// ----------------------------------------------------------------------------

const AUTH = { box_id: HEX32, box_token: HEX32B, created_at: 0 };

test("createAuthEngine requires a valid identity", () => {
  assert.throws(() => createAuthEngine({ auth: null }));
  assert.throws(() => createAuthEngine({ auth: { box_id: "bad", box_token: HEX32 } }));
});

test("authorize gates data routes without a valid token", () => {
  const eng = createAuthEngine({ auth: AUTH });
  // no token → 401
  let r = eng.authorize({ method: "GET", path: "/api/projects", authorization: "" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  // wrong token → 401
  r = eng.authorize({
    method: "GET",
    path: "/api/projects",
    authorization: `Bearer ${HEX32}`,
  });
  assert.equal(r.ok, false);
  // correct token → ok
  r = eng.authorize({
    method: "GET",
    path: "/api/projects",
    authorization: `Bearer ${AUTH.box_token}`,
  });
  assert.equal(r.ok, true);
});

test("authorize allows exempt + preflight + public-asset paths without a token", () => {
  const eng = createAuthEngine({ auth: AUTH });
  assert.equal(eng.authorize({ method: "OPTIONS", path: "/api/projects" }).ok, true);
  assert.equal(eng.authorize({ method: "GET", path: "/auth/pair" }).ok, true);
  assert.equal(eng.authorize({ method: "POST", path: "/auth/claim" }).ok, true);
  assert.equal(eng.authorize({ method: "GET", path: "/pair" }).ok, true);
  assert.equal(eng.authorize({ method: "GET", path: "/pair/qr.png" }).ok, true);
  assert.equal(eng.authorize({ method: "GET", path: "/pair/logo.png" }).ok, true);
  assert.equal(eng.authorize({ method: "POST", path: "/hook/abcd" }).ok, true);
  assert.equal(eng.authorize({ method: "GET", path: "/pages/foo" }).ok, true);
  assert.equal(eng.authorize({ method: "GET", path: "/" }).ok, true);
  assert.equal(eng.authorize({ method: "GET", path: "/assets/x.js" }).ok, true);
  // /auth/status is NOT exempt → gated
  assert.equal(eng.authorize({ method: "GET", path: "/auth/status" }).ok, false);
  // /pair/other is NOT exempt — narrow allowlist
  assert.equal(eng.authorize({ method: "GET", path: "/pair/other" }).ok, false);
  // /api/serve-page is NOT exempt — management API must be gated
  assert.equal(eng.authorize({ method: "GET", path: "/api/serve-page" }).ok, false);
  // a POST to an asset-looking path is still gated (assets are GET-only)
  assert.equal(eng.authorize({ method: "POST", path: "/assets/x.js" }).ok, false);
});

test("authorize allows everything when enforcement is disabled", () => {
  const eng = createAuthEngine({ auth: AUTH, enforce: false });
  assert.equal(eng.authorize({ method: "GET", path: "/api/projects", authorization: "" }).ok, true);
  assert.equal(eng.authorize({ method: "POST", path: "/rpc/tmux", authorization: "" }).ok, true);
});

// ----------------------------------------------------------------------------
// auth engine — pair / claim handshake
// ----------------------------------------------------------------------------

test("pair mints a code + box_id; claim exchanges a valid code for the token", () => {
  const eng = createAuthEngine({ auth: AUTH });
  const p = eng.pair();
  assert.equal(p.ok, true);
  assert.equal(isValidPairingCode(p.pairing_code), true);
  assert.equal(p.box_id, AUTH.box_id);

  const c = eng.claim({ pairing_code: p.pairing_code });
  assert.equal(c.ok, true);
  assert.equal(c.box_token, AUTH.box_token);
  assert.equal(c.box_id, AUTH.box_id);
});

test("claim is one-time and rejects reused / wrong / malformed codes", () => {
  const eng = createAuthEngine({ auth: AUTH });
  const { pairing_code } = eng.pair();

  // reused code → 403
  eng.claim({ pairing_code });
  const reused = eng.claim({ pairing_code });
  assert.equal(reused.ok, false);
  assert.equal(reused.status, 403);

  // malformed code → 400
  const bad = eng.claim({ pairing_code: "abc" });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);

  // wrong (valid-shape) code → 403
  eng.pair();
  const wrong = eng.claim({ pairing_code: "999999" });
  // could be right by 1-in-1e6 chance; assert only the shape of a rejection path
  if (!wrong.ok) assert.equal(wrong.status, 403);
});

test("claim rejects an expired code", () => {
  let t = 0;
  const eng = createAuthEngine({ auth: AUTH, ttlMs: 100, now: () => t });
  const { pairing_code } = eng.pair();
  t = 200; // past TTL
  const r = eng.claim({ pairing_code });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

// ----------------------------------------------------------------------------
// auth engine — revoke (BET-357 §2: "remove this box from the device")
// ----------------------------------------------------------------------------
//
// revoke() is the per-device "forget this box" handshake. The contract
// (from the issue spec + the DELETE /auth/revoke handler in index.mjs):
//
//   no token presented           → 401 unauthorized
//   token is not 32-hex          → 400 malformed token
//   token is 32-hex but wrong    → 401 unauthorized
//   token is 32-hex and matches  → 200, deletes box_token from
//                                   ~/.manta/auth.json, mints a fresh
//                                   identity in place so the engine's
//                                   subsequent authorize/claim calls use
//                                   the new token (the OLD one is dead
//                                   from this instant).

test("revoke: no token presented → 401", async () => {
  const eng = createAuthEngine({ auth: AUTH });
  const r = await eng.revoke({});
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test("revoke: empty-string token → 401", async () => {
  const eng = createAuthEngine({ auth: AUTH });
  const r = await eng.revoke({ token: "" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test("revoke: malformed token (not 32-hex) → 400", async () => {
  const eng = createAuthEngine({ auth: AUTH });
  const r = await eng.revoke({ token: "not-32-hex" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  // The malformed path returns BEFORE the token compare — so the box's
  // own token is NOT exposed to a malformed-token caller (no partial leak).
  // We assert that by checking that the engine's authorize() gate still
  // accepts the real token afterwards (no rotation happened).
  const gate = eng.authorize({
    method: "GET",
    path: "/api/projects",
    authorization: `Bearer ${AUTH.box_token}`,
  });
  assert.equal(gate.ok, true);
});

test("revoke: 32-hex token that doesn't match → 401, no rotation", async () => {
  const eng = createAuthEngine({ auth: AUTH });
  const wrong = "a".repeat(32);
  const r = await eng.revoke({ token: wrong });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  // Same leak guard as the malformed case: the engine's token is intact.
  const gate = eng.authorize({
    method: "GET",
    path: "/api/projects",
    authorization: `Bearer ${AUTH.box_token}`,
  });
  assert.equal(gate.ok, true);
});

test("revoke: valid token deletes box_token from auth.json (BET-357 §2)", async () => {
  // Live FS round-trip: write a real auth.json, build the engine around it,
  // revoke, and assert the file no longer authenticates the OLD token. The
  // engine's in-memory state is also rotated (verified by subsequent
  // authorize() calls).
  const path = tmpPath("revoke-roundtrip");
  const initial = { box_id: HEX32, box_token: HEX32B, created_at: 1000 };
  await saveAuth(initial, path);
  const eng = createAuthEngine({
    auth: initial,
    saveAuth: (a) => saveAuth(a, path),
    deleteAuth: () => deleteAuth(path),
  });

  const r = await eng.revoke({ token: HEX32B });
  assert.equal(r.ok, true);
  assert.equal(isValidToken(r.box_id), true);
  // The new box_id MUST differ from the old one — otherwise we'd be reusing
  // the identity, which defeats the point of "remove this box".
  assert.notEqual(r.box_id, HEX32);

  // On-disk file: the OLD token must no longer authorize. We re-read the
  // file (instead of trusting the in-memory mutation) so the test pins the
  // actual persistence behavior, not just the engine's bookkeeping.
  const onDisk = JSON.parse(await readFile(path, "utf-8"));
  assert.equal(onDisk.box_id, r.box_id);
  assert.notEqual(onDisk.box_token, HEX32B);
  assert.equal(isValidToken(onDisk.box_token), true);

  // In-memory rotation: subsequent authorize() with the OLD token fails.
  const blocked = eng.authorize({
    method: "GET",
    path: "/api/projects",
    authorization: `Bearer ${HEX32B}`,
  });
  assert.equal(blocked.ok, false);
  // ...and the NEW token (whatever was just written) authorizes.
  const ok2 = eng.authorize({
    method: "GET",
    path: "/api/projects",
    authorization: `Bearer ${onDisk.box_token}`,
  });
  assert.equal(ok2.ok, true);

  await rm(path, { force: true });
});

test("revoke: pair + claim after revoke returns the NEW identity, not the old one", async () => {
  // End-to-end: a real revoke is followed by a fresh pair+claim. The claim
  // must surface the new identity (so any device that re-pairs next gets a
  // working token, not the dead old one). This pins the "next install mints
  // a new one" semantics from the spec.
  const path = tmpPath("revoke-claim-roundtrip");
  const initial = { box_id: HEX32, box_token: HEX32B, created_at: 1000 };
  await saveAuth(initial, path);
  const eng = createAuthEngine({
    auth: initial,
    saveAuth: (a) => saveAuth(a, path),
    deleteAuth: () => deleteAuth(path),
  });

  await eng.revoke({ token: HEX32B });

  // Now mint a code and claim it — must yield the NEW token (which the
  // engine wrote to disk during the revoke).
  const { pairing_code } = eng.pair();
  const claimed = eng.claim({ pairing_code });
  assert.equal(claimed.ok, true);
  assert.notEqual(claimed.box_token, HEX32B);
  assert.equal(isValidToken(claimed.box_token), true);

  await rm(path, { force: true });
});

test("revoke: clears any active pairing code (the old identity's code is moot)", async () => {
  // Issue a code before revoke, then revoke. The pre-existing code must be
  // invalidated — otherwise a code minted under the OLD identity would
  // authorize the OLD token (which nothing holds anymore).
  const eng = createAuthEngine({ auth: AUTH });
  const { pairing_code: stale } = eng.pair();
  assert.equal(eng.hasActivePairing(), true);

  await eng.revoke({ token: AUTH.box_token });

  assert.equal(eng.hasActivePairing(), false);
  const staleClaim = eng.claim({ pairing_code: stale });
  assert.equal(staleClaim.ok, false);
});

test("deleteAuth: idempotent — missing file is not an error", async () => {
  const path = tmpPath("delete-missing");
  // Should not throw, even though the file doesn't exist.
  await deleteAuth(path);
  await deleteAuth(path); // twice for good measure
});

test("deleteAuth: removes the file and the next loadAuth returns null", async () => {
  const path = tmpPath("delete-roundtrip");
  try {
    await writeFile(path, JSON.stringify({ box_id: HEX32, box_token: HEX32B }), "utf-8");
    assert.equal(loadAuth(path)?.box_token, HEX32B);
    await deleteAuth(path);
    assert.equal(loadAuth(path), null);
  } finally {
    await rm(path, { force: true });
  }
});

// ----------------------------------------------------------------------------
// isLoopbackAddress / isLocalDirectRequest — REGRESSION for the /auth/pair hole
// (unauthenticated remote minting = box_token theft in 2 requests)
// ----------------------------------------------------------------------------

test("isLoopbackAddress accepts v4/v6 loopback forms only", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.1.2.3"), true); // whole /8
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true); // v4-mapped
  assert.equal(isLoopbackAddress("::FFFF:127.0.0.1"), true); // case-insensitive
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isLoopbackAddress("10.0.0.1"), false);
  assert.equal(isLoopbackAddress("::ffff:10.0.0.1"), false);
  assert.equal(isLoopbackAddress("1270.0.0.1"), false);
  assert.equal(isLoopbackAddress(""), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("isLocalDirectRequest allows a clean loopback request", () => {
  assert.equal(
    isLocalDirectRequest({ remoteAddress: "127.0.0.1", headers: {} }),
    true,
  );
  assert.equal(
    isLocalDirectRequest({
      remoteAddress: "::1",
      headers: { "user-agent": "curl/8.0", accept: "*/*" },
    }),
    true,
  );
});

test("isLocalDirectRequest rejects non-loopback sockets", () => {
  assert.equal(
    isLocalDirectRequest({ remoteAddress: "192.168.1.50", headers: {} }),
    false,
  );
  assert.equal(isLocalDirectRequest({ remoteAddress: undefined, headers: {} }), false);
  assert.equal(isLocalDirectRequest({}), false);
  assert.equal(isLocalDirectRequest(), false);
});

test("REGRESSION: loopback + proxy forwarding headers is NOT local (cloudflared)", () => {
  // cloudflared runs ON the box and proxies public traffic to 127.0.0.1:8787 —
  // the socket is loopback but the tunnel edge injects these headers, and an
  // external attacker cannot strip them. Each one alone must flip the verdict.
  const base = { remoteAddress: "127.0.0.1" };
  for (const h of [
    "x-forwarded-for",
    "x-forwarded-host",
    "x-real-ip",
    "cf-connecting-ip",
    "cf-ray",
    "forwarded",
  ]) {
    assert.equal(
      isLocalDirectRequest({ ...base, headers: { [h]: "203.0.113.7" } }),
      false,
      `header ${h} must mark the request non-local`,
    );
  }
  // empty-string header value does not count as forwarded
  assert.equal(
    isLocalDirectRequest({ ...base, headers: { "x-forwarded-for": "" } }),
    true,
  );
});
